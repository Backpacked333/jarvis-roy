import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultRoomPolicy, type ArtifactManifest, type AttemptRef, type PlanDraft, type Room, type Run, type Usage } from "../bridge/harness-contracts/domain.ts";
import { questionBinding, type AnswerQuestionRequest } from "../bridge/harness-contracts/interactions.ts";
import type { AuthoringResult, HarnessService, PlanAuthor } from "../bridge/harness-contracts/service.ts";
import { artifactDigest, sha256 } from "../bridge/harness-contracts/validation.ts";
import type { Cancellation, Reconciliation, WorkerContext, WorkerResult, WorkerRunner, WorkerSpec } from "../bridge/harness-contracts/worker.ts";
import { createHarnessKernel } from "../bridge/harness-kernel/index.ts";
import { HarnessKernel } from "../bridge/harness-kernel/kernel.ts";
import { zeroUsage, type Database } from "../bridge/harness-kernel/model.ts";
import { SqliteKernelStore, type KernelStore } from "../bridge/harness-kernel/store.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Call = { spec: WorkerSpec; context: WorkerContext; result: ReturnType<typeof deferred<WorkerResult>>; sequence: number };
class ControlledWorker implements WorkerRunner {
  readonly calls: Call[] = [];
  readonly cancellations: AttemptRef[] = [];
  private queued: Call[] = [];
  private waiting: ReturnType<typeof deferred<Call>>[] = [];
  available = true;
  cancelled: (ref: AttemptRef) => Promise<Cancellation> = async (ref) => ({ ref, confirmed: true, reason: null });
  reconciled: (ref: AttemptRef) => Promise<Reconciliation> = async (ref) => ({ state: "missing", ref, reason: "No test resource" });
  beforeStart: ((spec: WorkerSpec) => Promise<void>) | null = null;
  readonly artifacts = { read: async () => { throw new Error("Kernel metadata tests do not impersonate a real worker artifact reader"); } };
  async availability() { return { available: this.available, reason: this.available ? null : "No isolated worker configured" }; }
  async run(spec: WorkerSpec, context: WorkerContext) {
    await this.beforeStart?.(spec);
    const call: Call = { spec, context, result: deferred<WorkerResult>(), sequence: 0 };
    this.calls.push(call);
    await context.emit({ type: "started", ref: spec.ref, sequence: call.sequence++, at: new Date().toISOString(), resourceId: `container-${spec.ref.attemptId}` });
    const next = this.waiting.shift();
    if (next) next.resolve(call); else this.queued.push(call);
    return call.result.promise;
  }
  async next(): Promise<Call> {
    const call = this.queued.shift();
    if (call) return call;
    const next = deferred<Call>();
    this.waiting.push(next);
    return next.promise;
  }
  async cancel(ref: AttemptRef) { this.cancellations.push(ref); return this.cancelled(ref); }
  async reconcile(ref: AttemptRef) { return this.reconciled(ref); }
}

class ObservedStore implements KernelStore {
  readonly actual: SqliteKernelStore;
  value!: Database;
  private waiters: { predicate: (db: Database) => boolean; resolve: (db: Database) => void }[] = [];
  constructor(directory: string) { this.actual = new SqliteKernelStore(directory); }
  async open(initial: Database) { this.value = await this.actual.open(initial); return this.value; }
  save(value: Database) {
    this.actual.save(value);
    this.value = structuredClone(value);
    for (const waiter of this.waiters.filter((w) => w.predicate(this.value))) waiter.resolve(this.value);
    this.waiters = this.waiters.filter((w) => !w.predicate(this.value));
  }
  waitFor(predicate: (db: Database) => boolean): Promise<Database> {
    if (predicate(this.value)) return Promise.resolve(this.value);
    const next = deferred<Database>();
    this.waiters.push({ predicate, resolve: next.resolve });
    return next.promise;
  }
  close() { this.actual.close(); }
  failWrites() {
    const connection = (this.actual as unknown as { connection: DatabaseSync }).connection;
    connection.exec("PRAGMA query_only=ON");
  }
}

const policy = () => defaultRoomPolicy(`sha256:${"1".repeat(64)}`);
const usage = (steps = 1, tokens = 20): Usage => ({ ...zeroUsage(), steps, modelCalls: steps, inputTokens: tokens, outputTokens: tokens });
const node = (id: string, dependencies: string[] = [], inputFrom: string[] = []) => ({
  id, title: id, role: "builder" as const, instructions: "Create a small inert text artifact", dependencies, inputFrom,
  outputPaths: ["result.txt"], limits: { maxSteps: 4, maxModelCalls: 4, maxTokens: 2_000,
    maxOutputTokensPerCall: 256, maxWallTimeMs: 30_000, estimatedUsdLimit: null },
});
const draft = (nodes = [node("build")]): PlanDraft => ({ goal: "Build an inert text file", nodes });
function artifact(spec: WorkerSpec, id = `artifact_${spec.ref.attemptId}`): ArtifactManifest {
  const content = Buffer.from(`Real fixture bytes for ${spec.ref.attemptId}`);
  const manifest: ArtifactManifest = { version: 1, id, ...spec.ref, planDigest: spec.planDigest,
    digest: "0".repeat(64), createdAt: new Date().toISOString(),
    files: [{ path: "result.txt", sha256: sha256(content), bytes: content.length, mediaType: "text/plain" }],
    inputDigests: spec.inputs.map((a) => a.digest), verification: "unverified", verificationSummary: "Test fixture, not a real worker verification" };
  manifest.digest = artifactDigest(manifest);
  return manifest;
}
function complete(call: Call, used = usage()): WorkerResult {
  const result: WorkerResult = { status: "completed", ref: call.spec.ref, usage: used, artifacts: [artifact(call.spec)], summary: "Fixture output" };
  call.result.resolve(result);
  return result;
}
function question(call: Call, used = usage()): WorkerResult {
  const result: WorkerResult = { status: "waiting_question", ref: call.spec.ref, usage: used,
    checkpoint: { version: 1, ref: call.spec.ref, sequence: call.sequence - 1, createdAt: new Date().toISOString(),
      resumeMode: "continue_after_answer", continuation: { version: 1, summary: "Files sealed; previous tools must not replay", history: [], completedStepIds: ["step1"], usage: used },
      artifacts: [artifact(call.spec)], question: { prompt: "Which color?", choices: [{ id: "blue", label: "Blue" }], allowText: true } } };
  call.result.resolve(result);
  return result;
}
async function fixture(t: TestContext, options: { draft?: PlanDraft; maximum?: number; author?: PlanAuthor; now?: () => Date } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-kernel-"));
  const worker = new ControlledWorker();
  const store = new ObservedStore(directory);
  let counter = 0;
  const author = options.author ?? { author: async () => ({ status: "completed" as const, draft: options.draft ?? draft(), usage: usage() }) };
  const kernel = new HarnessKernel({ dataDirectory: directory, worker, author, maxActiveWorkers: options.maximum ?? 2,
    now: options.now, createId: () => `id_${++counter}`, defaultPolicy: policy() }, store);
  await kernel.initialize();
  t.after(async () => { await kernel.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return { directory, worker, store, kernel, author };
}
async function room(kernel: HarnessService, requestId = "create") {
  return kernel.createRoom({ requestId, title: requestId, description: "Scoped fixture room", policy: policy() });
}
async function plan(f: Awaited<ReturnType<typeof fixture>>, room: Room) {
  const author = await f.kernel.authorPlan(room.id, { requestId: `author_${room.id}`, expectedRoomRevision: room.revision, goal: "Build an inert text file" });
  const db = await f.store.waitFor((db) => db.state.authorings.some((a) => a.id === author.id && a.status !== "authoring"));
  const completed = db.state.authorings.find((a) => a.id === author.id)!;
  assert.equal(completed.status, "completed", completed.error ?? "author completion");
  return db.state.plans.find((p) => p.id === completed.planId)!;
}
async function start(f: Awaited<ReturnType<typeof fixture>>, r: Room, requestId = `start_${r.id}`) {
  const p = await plan(f, r);
  const accepted = await f.kernel.acceptPlan(r.id, p.id, { expectedRevision: p.revision });
  const request = { requestId, planId: p.id, expectedPlanRevision: accepted.revision, planDigest: accepted.digest! };
  const run = await f.kernel.startRun(r.id, request);
  return { run, request, accepted };
}
const current = async (kernel: HarnessService, id: string) => (await kernel.state()).runs.find((r) => r.id === id)!;

test("durable room idempotency, revision CAS, accepted plan immutability and exact start", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  assert.deepEqual(await room(f.kernel), r);
  await assert.rejects(f.kernel.createRoom({ requestId: "create", title: "different", description: "", policy: policy() }), /different content/);
  const p = await plan(f, r);
  await assert.rejects(f.kernel.startRun(r.id, { requestId: "draftStart", planId: p.id, expectedPlanRevision: 1, planDigest: "0".repeat(64) }), /accepted/);
  const edited = await f.kernel.updatePlan(r.id, p.id, { expectedRevision: p.revision, draft: { ...draft(), goal: "Edited goal" } });
  await assert.rejects(f.kernel.acceptPlan(r.id, p.id, { expectedRevision: p.revision }), /Stale revision/);
  const accepted = await f.kernel.acceptPlan(r.id, p.id, { expectedRevision: edited.revision });
  await assert.rejects(f.kernel.updatePlan(r.id, p.id, { expectedRevision: edited.revision, draft: draft() }), /immutable/);
  const request = { requestId: "run", planId: p.id, expectedPlanRevision: accepted.revision, planDigest: accepted.digest! };
  const [a, b] = await Promise.all([f.kernel.startRun(r.id, request), f.kernel.startRun(r.id, request)]);
  assert.equal(a.id, b.id);
  const call = await f.worker.next();
  assert.equal(f.worker.calls.length, 1);
  assert.equal(call.spec.planDigest, accepted.digest);
  await assert.rejects(f.kernel.startRun(r.id, { ...request, planDigest: "a".repeat(64) }), /different content/);
  complete(call);
  await f.store.waitFor((db) => db.state.runs[0].status === "completed");
  const state = await f.kernel.state();
  state.plans[0].nodes[0].instructions = "mutate returned copy";
  assert.notEqual((await f.kernel.state()).plans[0].nodes[0].instructions, state.plans[0].nodes[0].instructions);
  const concurrent = await Promise.allSettled([
    f.kernel.updateRoom(r.id, { expectedRevision: r.revision, title: "one" }),
    f.kernel.updateRoom(r.id, { expectedRevision: r.revision, title: "two" }),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  await f.kernel.shutdown();
  const restarted = createHarnessKernel({ dataDirectory: f.directory, worker: f.worker, author: f.author });
  await restarted.initialize();
  t.after(() => restarted.shutdown());
  assert.equal((await restarted.state()).runs[0].status, "completed");
  assert.equal((await restarted.startRun(r.id, request)).id, a.id);
  assert.equal(f.worker.calls.length, 1);
  assert.equal((await stat(path.join(f.directory, "harness-kernel/kernel.sqlite"))).mode & 0o777, 0o600);
  await restarted.shutdown();
});

test("parallel dependency scheduling reserves full budgets and hands off immutable exact artifacts", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { draft: draft([node("left"), node("right"), node("review", ["left", "right"], ["left", "right"])]) });
  const r = await room(f.kernel);
  f.worker.beforeStart = async (spec) => {
    const persisted = f.store.value.attempts.find((a) => a.ref.attemptId === spec.ref.attemptId)!;
    assert.equal(persisted.phase, "intent");
    assert.equal((await f.kernel.state()).runs[0].nodes.find((n) => n.nodeId === spec.ref.nodeId)!.startedAt, null);
  };
  const { run } = await start(f, r);
  const left = await f.worker.next();
  const right = await f.worker.next();
  assert.equal(f.worker.calls.length, 2);
  assert.equal((await current(f.kernel, run.id)).usage.reservedTokens, 6_000);
  complete(left);
  await f.store.waitFor((db) => db.state.runs[0].nodes[0].status === "completed");
  assert.equal(f.worker.calls.length, 2);
  complete(right);
  const review = await f.worker.next();
  assert.equal(review.spec.node.id, "review");
  assert.deepEqual(review.spec.inputs.map((a) => a.nodeId).sort(), ["left", "right"]);
  assert.equal(new Set(review.spec.inputs.map((a) => a.digest)).size, 2);
  complete(review);
  const done = await f.store.waitFor((db) => db.state.runs[0].status === "completed");
  assert.equal(done.state.runs[0].usage.inputTokens, 60);
  assert.equal(done.state.runs[0].usage.reservedTokens, 0);
  const first = done.state.artifacts[0];
  assert.deepEqual(await f.kernel.artifact(r.id, run.id, first.id), first);
});

test("global and per-room concurrency ceilings, round-robin rooms and pause do not synthesize work", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { maximum: 1, draft: draft([node("first"), node("second")]) });
  const a = await room(f.kernel, "a");
  const b = await room(f.kernel, "b");
  const runA = (await start(f, a)).run;
  const a1 = await f.worker.next();
  const runB = (await start(f, b)).run;
  assert.equal(f.worker.calls.length, 1);
  const aNow = await current(f.kernel, runA.id);
  await f.kernel.pauseRun(a.id, runA.id, { expectedRevision: aNow.revision });
  complete(a1);
  const b1 = await f.worker.next();
  assert.equal(b1.spec.ref.roomId, b.id);
  const bNow = await current(f.kernel, runB.id);
  await f.kernel.pauseRun(b.id, runB.id, { expectedRevision: bNow.revision });
  complete(b1);
  await f.store.waitFor((db) => db.state.runs.find((r) => r.id === runB.id)!.nodes[0].status === "completed");
  assert.equal(f.worker.calls.length, 2);
  const paused = await current(f.kernel, runA.id);
  await f.kernel.resumeRun(a.id, runA.id, { expectedRevision: paused.revision });
  const a2 = await f.worker.next();
  assert.equal(a2.spec.ref.roomId, a.id);
  complete(a2);
  await f.store.waitFor((db) => db.state.runs.find((r) => r.id === runA.id)!.status === "completed");
});

test("failed prerequisites block dependents; explicit measured retry retains cumulative usage", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { draft: draft([node("build"), node("review", ["build"], ["build"])]) });
  const r = await room(f.kernel);
  const { run } = await start(f, r);
  const failed = await f.worker.next();
  failed.result.resolve({ status: "failed", ref: failed.spec.ref, usage: usage(), error: "Fixture check failed" });
  await f.store.waitFor((db) => db.state.runs[0].nodes[1].status === "blocked");
  assert.equal(f.worker.calls.length, 1);
  const before = await current(f.kernel, run.id);
  await f.kernel.retryNode(r.id, run.id, "build", { expectedRevision: before.revision, previousAttemptId: failed.spec.ref.attemptId });
  const retry = await f.worker.next();
  assert.notEqual(retry.spec.ref.attemptId, failed.spec.ref.attemptId);
  assert.equal(retry.spec.checkpoint, null);
  assert.equal(retry.spec.node.limits.maxSteps, 4);
  complete(retry, usage(2, 40));
  const review = await f.worker.next();
  complete(review);
  const done = await f.store.waitFor((db) => db.state.runs[0].status === "completed");
  assert.equal(done.state.runs[0].nodes[0].usage.inputTokens, 40);
  assert.equal(done.state.runs[0].usage.inputTokens, 60);
});

test("questions suspend one node, survive restart, consume exact bindings once and use a new attempt", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  const { run } = await start(f, r);
  const first = await f.worker.next();
  question(first);
  const waiting = await f.store.waitFor((db) => db.state.questions.length === 1);
  const q = waiting.state.questions[0];
  await f.kernel.shutdown();
  const store = new ObservedStore(f.directory);
  const kernel = new HarnessKernel({ dataDirectory: f.directory, worker: f.worker, author: f.author }, store);
  await kernel.initialize();
  t.after(() => kernel.shutdown());
  const answer: AnswerQuestionRequest = { binding: questionBinding(q), source: "voice", text: "blue", choiceId: null };
  const wrong = structuredClone(answer);
  wrong.binding.target.roomId = "other";
  await assert.rejects(kernel.answerQuestion(wrong), /cross-scope/);
  const outcomes = await Promise.allSettled([kernel.answerQuestion(answer), kernel.answerQuestion(answer)]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  const resumed = await f.worker.next();
  assert.equal(resumed.spec.ref.runId, run.id);
  assert.notEqual(resumed.spec.ref.attemptId, first.spec.ref.attemptId);
  assert.equal(resumed.spec.checkpoint?.ref.attemptId, first.spec.ref.attemptId);
  assert.deepEqual(resumed.spec.checkpoint?.continuation.completedStepIds, ["step1"]);
  assert.deepEqual(resumed.spec.answer, answer);
  await assert.rejects(first.context.emit({ type: "progress", ref: first.spec.ref, at: new Date().toISOString(), sequence: first.sequence++, operation: "late" }), /Stale|shutting down/);
  complete(resumed, usage(2, 40));
  await store.waitFor((db) => db.state.runs[0].status === "completed");
  assert.equal((await kernel.state()).runs[0].usage.inputTokens, 40);
  await kernel.shutdown();
});

test("cancellation is requested then confirmed; late completed output cannot overwrite it", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  const { run } = await start(f, r);
  const call = await f.worker.next();
  const stopped = deferred<Cancellation>();
  f.worker.cancelled = () => stopped.promise;
  const live = await current(f.kernel, run.id);
  const requested = await f.kernel.cancelRun(r.id, run.id, { expectedRevision: live.revision });
  assert.equal(requested.status, "cancel_requested");
  assert.equal(requested.cancelConfirmed, false);
  complete(call);
  stopped.resolve({ ref: call.spec.ref, confirmed: true, reason: null });
  const done = await f.store.waitFor((db) => db.state.runs[0].cancelConfirmed);
  assert.equal(done.state.runs[0].status, "cancelled");
  assert.equal(done.state.artifacts.length, 0);
  assert.equal(done.state.runs[0].usage.accounting, "unknown");
  assert.equal(done.state.runs[0].usage.reservedTokens, 2_000);
});

test("unconfirmed stop retains global slot and refuses unsafe retry", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { maximum: 1 });
  const a = await room(f.kernel, "a");
  const runA = (await start(f, a)).run;
  const call = await f.worker.next();
  f.worker.cancelled = async (ref) => ({ ref, confirmed: false, reason: "Daemon unreachable" });
  const before = await current(f.kernel, runA.id);
  await f.kernel.cancelRun(a.id, runA.id, { expectedRevision: before.revision });
  await f.store.waitFor((db) => db.state.runs[0].status === "interrupted");
  const b = await room(f.kernel, "b");
  await start(f, b);
  assert.equal(f.worker.calls.length, 1);
  const uncertain = await current(f.kernel, runA.id);
  await assert.rejects(f.kernel.retryNode(a.id, runA.id, "build", { expectedRevision: uncertain.revision, previousAttemptId: call.spec.ref.attemptId }), /refresh|cannot/);
  assert.equal(f.worker.calls.length, 1);
});

test("cross-room operations, stale worker sequences and forged artifact results cannot cross boundaries", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const a = await room(f.kernel, "a");
  const b = await room(f.kernel, "b");
  const { run, accepted } = await start(f, a);
  const call = await f.worker.next();
  await assert.rejects(f.kernel.acceptPlan(b.id, accepted.id, { expectedRevision: 1 }), /not found/);
  await assert.rejects(f.kernel.pauseRun(b.id, run.id, { expectedRevision: run.revision }), /not found/);
  await assert.rejects(call.context.emit({ type: "progress", ref: call.spec.ref, sequence: 0, at: new Date().toISOString(), operation: "duplicate" }), /sequence/);
  await assert.rejects(call.context.emit({ type: "progress", ref: { ...call.spec.ref, roomId: b.id }, sequence: 1, at: new Date().toISOString(), operation: "forged" }), /scope/);
  const forged = artifact(call.spec);
  forged.roomId = b.id;
  forged.digest = artifactDigest(forged);
  call.result.resolve({ status: "completed", ref: call.spec.ref, usage: usage(), artifacts: [forged], summary: "Invalid" });
  const interrupted = await f.store.waitFor((db) => db.state.runs[0].status === "interrupted");
  assert.equal(interrupted.state.artifacts.length, 0);
  assert.equal(f.worker.cancellations.length, 1);
});

test("exhausted retries and partial accounting never acquire fresh budgets", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  const { run } = await start(f, r);
  const call = await f.worker.next();
  call.result.resolve({ status: "failed", ref: call.spec.ref, usage: usage(4), error: "Spent step budget" });
  await f.store.waitFor((db) => db.state.runs[0].status === "failed");
  const failed = await current(f.kernel, run.id);
  await assert.rejects(f.kernel.retryNode(r.id, run.id, "build", { expectedRevision: failed.revision, previousAttemptId: call.spec.ref.attemptId }), /budget exhausted/);
  assert.equal(f.worker.calls.length, 1);
  const other = await room(f.kernel, "partial");
  const partialRun = (await start(f, other)).run;
  const partial = await f.worker.next();
  partial.result.resolve({ status: "failed", ref: partial.spec.ref, usage: { ...usage(), accounting: "partial" }, error: "Missing provider accounting" });
  await f.store.waitFor((db) => db.state.runs.find((r) => r.id === partialRun.id)!.status === "failed");
  const state = await current(f.kernel, partialRun.id);
  assert.equal(state.usage.reservedTokens, 1_960);
  await assert.rejects(f.kernel.retryNode(other.id, state.id, "build", { expectedRevision: state.revision, previousAttemptId: partial.spec.ref.attemptId }), /Unknown usage/);
});

test("model-authored cyclic graphs cannot become drafts", { timeout: 10_000 }, async (t) => {
  const result = deferred<AuthoringResult>();
  const f = await fixture(t, { author: { author: () => result.promise } });
  const r = await room(f.kernel);
  const a = await f.kernel.authorPlan(r.id, { requestId: "bad", expectedRoomRevision: r.revision, goal: "Bad graph" });
  result.resolve({ status: "completed", draft: draft([node("a", ["b"]), node("b", ["a"])]), usage: usage() });
  await f.store.waitFor((db) => db.state.authorings[0].status === "failed");
  assert.equal((await f.kernel.state()).plans.length, 0);
  assert.equal((await f.kernel.state()).authorings[0].id, a.id);
});

test("authoring questions use authoring IDs, consume once, and stale policy fails closed", { timeout: 10_000 }, async (t) => {
  const calls: { input: Parameters<PlanAuthor["author"]>[0]; next: ReturnType<typeof deferred<AuthoringResult>> }[] = [];
  const entered = deferred<void>();
  const resumed = deferred<void>();
  const f = await fixture(t, { author: { author: (input) => {
    const next = deferred<AuthoringResult>(); calls.push({ input, next });
    (calls.length === 1 ? entered : resumed).resolve(); return next.promise;
  } } });
  const r = await room(f.kernel);
  await f.kernel.authorPlan(r.id, { requestId: "ask", expectedRoomRevision: r.revision, goal: "Need info" });
  await entered.promise;
  calls[0].next.resolve({ status: "waiting_question", question: { prompt: "Which artifact?", choices: [], allowText: true },
    checkpoint: { version: 1, continuation: { version: 1, summary: "inert", history: [], completedStepIds: [], usage: usage() } }, usage: usage() });
  const db = await f.store.waitFor((db) => db.state.questions.length === 1);
  assert.equal(db.state.questions[0].target.scope, "authoring");
  const answer: AnswerQuestionRequest = { binding: questionBinding(db.state.questions[0]), source: "text", text: "Text", choiceId: null };
  await f.kernel.answerQuestion(answer);
  await resumed.promise;
  assert.deepEqual(calls[1].input.answer, answer);
  assert.equal(calls[1].input.checkpoint?.continuation.usage.inputTokens, 20);
  await assert.rejects(f.kernel.answerQuestion(answer), /Stale|pending/);
  await f.kernel.updateRoom(r.id, { expectedRevision: r.revision, policy: { ...r.policy, maxNodes: 3 } });
  calls[1].next.resolve({ status: "completed", draft: draft(), usage: usage(2) });
  await f.store.waitFor((db) => db.state.authorings[0].status === "failed");
  assert.equal((await f.kernel.state()).plans.length, 0);
});

test("atomic persistence failure rolls back state, rejects event acknowledgement and fences dispatch", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  await start(f, r);
  const call = await f.worker.next();
  const before = await f.kernel.state();
  f.store.failWrites();
  await assert.rejects(call.context.emit({ type: "progress", ref: call.spec.ref, sequence: 1, at: new Date().toISOString(), operation: "Must not become durable" }), /readonly|read-only/);
  const after = await f.kernel.state();
  assert.equal(after.ready, false);
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.runs[0].nodes[0].operation, before.runs[0].nodes[0].operation);
  assert.equal(call.context.signal.aborted, true);
  await assert.rejects(f.kernel.createRoom({ requestId: "unsafe", title: "No", description: "", policy: policy() }), /write failed/);
  await f.kernel.shutdown();
  const file = new DatabaseSync(path.join(f.directory, "harness-kernel/kernel.sqlite"));
  const saved = JSON.parse(file.prepare("SELECT body FROM snapshot").get()!.body as string);
  file.close();
  assert.equal(saved.state.sequence, before.sequence);
  assert.equal(saved.state.runs[0].nodes[0].operation, before.runs[0].nodes[0].operation);
});

test("SQLite lifetime lock prevents competing kernels and unsupported versions fail closed", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const second = createHarnessKernel({ dataDirectory: f.directory, worker: f.worker, author: f.author });
  await assert.rejects(second.initialize(), /locked/);
  await second.shutdown();
  await f.kernel.shutdown();
  const file = path.join(f.directory, "harness-kernel/kernel.sqlite");
  const database = new DatabaseSync(file);
  database.exec("PRAGMA user_version=99"); database.close();
  const future = createHarnessKernel({ dataDirectory: f.directory, worker: f.worker, author: f.author });
  await assert.rejects(future.initialize(), /Unsupported/);
  await future.shutdown();
});

test("corrupt accepted plans and unsafe database symlinks are rejected, not silently reset", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  const p = await plan(f, r);
  await f.kernel.acceptPlan(r.id, p.id, { expectedRevision: 1 });
  await f.kernel.shutdown();
  const file = path.join(f.directory, "harness-kernel/kernel.sqlite");
  const db = new DatabaseSync(file);
  const stored = JSON.parse(db.prepare("SELECT body FROM snapshot").get()!.body as string);
  stored.state.plans[0].nodes[0].instructions = "tampered accepted plan";
  db.prepare("UPDATE snapshot SET body=?").run(JSON.stringify(stored)); db.close();
  const corrupted = createHarnessKernel({ dataDirectory: f.directory, worker: f.worker, author: f.author });
  await assert.rejects(corrupted.initialize(), /digest mismatch/);
  await corrupted.shutdown();
  await rm(file);
  await symlink(path.join(f.directory, "elsewhere"), file);
  const unsafe = createHarnessKernel({ dataDirectory: f.directory, worker: f.worker, author: f.author });
  await assert.rejects(unsafe.initialize(), /Unsafe/);
  await unsafe.shutdown();
});

test("expired questions cannot resume and policy revisions invalidate old accepted starts", { timeout: 10_000 }, async (t) => {
  let now = new Date("2026-11-06T19:00:00.000Z");
  const f = await fixture(t, { now: () => now });
  const r = await room(f.kernel);
  const { accepted, request } = await start(f, r);
  const call = await f.worker.next();
  question(call);
  const db = await f.store.waitFor((db) => db.state.questions.length === 1);
  const q = db.state.questions[0];
  now = new Date(now.getTime() + 86_400_001);
  await assert.rejects(f.kernel.answerQuestion({ binding: questionBinding(q), source: "voice", text: "yes", choiceId: null }), /pending/);
  assert.equal((await f.kernel.state()).questions[0].status, "expired");
  await f.kernel.updateRoom(r.id, { expectedRevision: r.revision, policy: { ...r.policy, maxNodes: 3 } });
  await assert.rejects(f.kernel.startRun(r.id, { ...request, requestId: "new" }), /stale room policy/);
  assert.equal((await f.kernel.state()).plans[0].digest, accepted.digest);
});

test("event history is bounded with room filters and explicit reset cursors", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  let r = await room(f.kernel);
  for (let i = 0; i < 1_005; i++) r = await f.kernel.updateRoom(r.id, { expectedRevision: r.revision, description: `Revision ${i}` });
  const result = await f.kernel.events(0, r.id);
  assert.equal(result.events.length, 1_000);
  assert.equal(result.resetRequired, true);
  assert.equal((await f.kernel.events(result.nextSequence)).events.length, 0);
  assert.equal((await f.kernel.events(result.nextSequence + 1)).resetRequired, true);
  await assert.rejects(f.kernel.events(0, "cross_room"), /not found/);
});

async function crashAtIntent(t: TestContext, beforeStarted = false): Promise<{ directory: string; spec: WorkerSpec }> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-kernel-crash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `
    import { createHarnessKernel } from ${JSON.stringify(new URL("../bridge/harness-kernel/index.ts", import.meta.url).href)};
    const policy = ${JSON.stringify(policy())};
    const used = ${JSON.stringify(usage())};
    const draft = ${JSON.stringify(draft())};
    const keepAlive = setInterval(() => {}, 1000);
    const worker = {
      artifacts: { read: async () => { throw new Error('unused'); } },
      availability: async () => ({available: true, reason: null}),
      cancel: async ref => ({ref, confirmed: true, reason: null}),
      reconcile: async ref => ({ref, state: 'missing', reason: 'none'}),
      run: async (spec, context) => {
        if (!${beforeStarted}) await context.emit({type: 'started', ref: spec.ref, sequence: 0, at: new Date().toISOString(), resourceId: 'crash-fixture-resource'});
        process.send(spec);
        return new Promise(() => {});
      }
    };
    const kernel = createHarnessKernel({dataDirectory: ${JSON.stringify(directory)}, worker,
      author: {author: async () => ({status: 'completed', draft, usage: used})}});
    await kernel.initialize();
    const room = await kernel.createRoom({requestId: 'r', title: 'Crash fixture', description: '', policy});
    await kernel.authorPlan(room.id, {requestId: 'a', expectedRoomRevision: 1, goal: draft.goal});
    let state;
    do { await new Promise(resolve => setImmediate(resolve)); state = await kernel.state(); } while (!state.plans.length);
    const plan = await kernel.acceptPlan(room.id, state.plans[0].id, {expectedRevision: 1});
    await kernel.startRun(room.id, {requestId: 's', planId: plan.id, expectedPlanRevision: 1, planDigest: plan.digest});
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], env: {},
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const received = deferred<WorkerSpec>();
  let errors = "";
  child.stderr!.on("data", (chunk) => { errors = (errors + chunk).slice(-4_000); });
  child.once("message", (spec) => received.resolve(spec as WorkerSpec));
  child.once("error", received.reject);
  child.once("exit", (code, signal) => { if (code !== null && code !== 0) received.reject(new Error(errors || `child exited ${code}/${signal}`)); });
  const spec = await received.promise;
  const exited = deferred<void>();
  child.once("exit", () => exited.resolve());
  child.kill("SIGKILL");
  await exited.promise;
  return { directory, spec };
}

for (const beforeStarted of [false, true]) {
  test(`SIGKILL recovery adopts scoped durable results without replay (${beforeStarted ? "intent" : "started"} window)`, { timeout: 10_000 }, async (t) => {
    const { directory, spec } = await crashAtIntent(t, beforeStarted);
    const worker = new ControlledWorker();
    const reconciled = deferred<Reconciliation>();
    const entered = deferred<void>();
    worker.reconciled = () => { entered.resolve(); return reconciled.promise; };
    const kernel = createHarnessKernel({ dataDirectory: directory, worker, author: { author: async () => { throw new Error("No author replay"); } } });
    const initialized = kernel.initialize();
    await entered.promise;
    assert.equal((await kernel.state()).ready, false);
    assert.equal(worker.calls.length, 0);
    reconciled.resolve({ state: "settled", ref: spec.ref, result: {
      status: "completed", ref: spec.ref, usage: usage(), artifacts: [artifact(spec)], summary: "Durable worker result",
    } });
    await initialized;
    t.after(() => kernel.shutdown());
    assert.equal((await kernel.state()).runs[0].status, "completed");
    assert.equal(worker.calls.length, 0);
    assert.equal(worker.cancellations.length, 0);
    await kernel.shutdown();
  });
}

for (const recovered of ["running", "missing", "unknown"] as const) {
  test(`SIGKILL recovery reaps ${recovered} attempts before readiness and never replays`, { timeout: 10_000 }, async (t) => {
    const { directory, spec } = await crashAtIntent(t);
    const worker = new ControlledWorker();
    worker.reconciled = async (ref) => recovered === "running" ? { state: "running", ref } : { state: recovered, ref, reason: "Uncertain resource state" };
    const cleanup = deferred<Cancellation>();
    const called = deferred<void>();
    worker.cancelled = () => { called.resolve(); return cleanup.promise; };
    const kernel = createHarnessKernel({ dataDirectory: directory, worker, author: { author: async () => { throw new Error("No author replay"); } } });
    const initialized = kernel.initialize();
    await called.promise;
    assert.equal((await kernel.state()).ready, false);
    cleanup.resolve({ ref: spec.ref, confirmed: recovered === "running", reason: null });
    await initialized;
    t.after(() => kernel.shutdown());
    const state = await kernel.state();
    assert.equal(state.runs[0].status, "interrupted");
    assert.equal(state.runs[0].cancelConfirmed, false);
    assert.equal(state.runs[0].usage.accounting, "unknown");
    assert.equal(worker.calls.length, 0);
    assert.ok(worker.cancellations.some((ref) => ref.attemptId === spec.ref.attemptId));
    await kernel.shutdown();
  });
}

test("persisted answer behind pause creates only one continuation after restart", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  const { run } = await start(f, r);
  const first = await f.worker.next();
  question(first);
  await f.store.waitFor((db) => db.state.questions.length === 1);
  const live = await current(f.kernel, run.id);
  await f.kernel.pauseRun(r.id, run.id, { expectedRevision: live.revision });
  const q = (await f.kernel.state()).questions[0];
  const answer: AnswerQuestionRequest = { binding: questionBinding(q), text: "Blue", choiceId: null, source: "text" };
  await f.kernel.answerQuestion(answer);
  assert.equal(f.worker.calls.length, 1);
  await f.kernel.shutdown();
  const store = new ObservedStore(f.directory);
  const kernel = new HarnessKernel({ dataDirectory: f.directory, worker: f.worker, author: f.author }, store);
  await kernel.initialize();
  t.after(() => kernel.shutdown());
  assert.equal(f.worker.calls.length, 1);
  const paused = await current(kernel, run.id);
  await kernel.resumeRun(r.id, run.id, { expectedRevision: paused.revision });
  const resumed = await f.worker.next();
  await assert.rejects(kernel.answerQuestion(answer), /Stale|pending/);
  assert.deepEqual(resumed.spec.answer, answer);
  complete(resumed, usage(2, 40));
  await store.waitFor((db) => db.state.runs[0].status === "completed");
  await kernel.shutdown();
});

test("per-room caps apply across multiple runs while another room continues", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { maximum: 3 });
  const a = await f.kernel.createRoom({ requestId: "a", title: "A", description: "", policy: { ...policy(), maxConcurrentWorkers: 1 } });
  const b = await room(f.kernel, "b");
  const { request } = await start(f, a);
  const first = await f.worker.next();
  await f.kernel.startRun(a.id, { ...request, requestId: "a_again" });
  await start(f, b);
  const second = await f.worker.next();
  assert.equal(second.spec.ref.roomId, b.id);
  assert.equal(f.worker.calls.length, 2);
  complete(first);
  const third = await f.worker.next();
  assert.equal(third.spec.ref.roomId, a.id);
  complete(second); complete(third);
  await f.store.waitFor((db) => db.state.runs.every((run) => run.status === "completed"));
});

test("cumulative wall reservations prevent parallel overspend and exclude human waiting", { timeout: 10_000 }, async (t) => {
  let time = new Date("2026-11-06T19:00:00.000Z");
  const f = await fixture(t, { now: () => time, draft: draft([node("a"), node("b")]) });
  const p = policy(); p.runBudget.maxWallTimeMs = 30_000;
  const r = await f.kernel.createRoom({ requestId: "clock", title: "Clock", description: "", policy: p });
  await start(f, r);
  const a = await f.worker.next();
  assert.equal(f.worker.calls.length, 1);
  time = new Date(time.getTime() + 1_000);
  question(a);
  await f.store.waitFor((db) => db.state.questions.length === 1);
  const b = await f.worker.next();
  assert.equal(f.store.value.attempts[1].wallReservationMs, 29_000);
  complete(b);
  await f.store.waitFor((db) => db.state.runs[0].nodes[1].status === "completed");
  time = new Date(time.getTime() + 3_600_000);
  const q = (await f.kernel.state()).questions[0];
  await f.kernel.answerQuestion({ binding: questionBinding(q), source: "text", text: "Blue", choiceId: null });
  const resumed = await f.worker.next();
  assert.equal(f.store.value.attempts[2].wallReservationMs, 29_000);
  complete(resumed, usage(2, 40));
  await f.store.waitFor((db) => db.state.runs[0].status === "completed");
});

test("unavailable workers and unconfigured image never fall back to host execution", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await f.kernel.createRoom({ requestId: "unconfigured", title: "No image", description: "", policy: defaultRoomPolicy() });
  const p = await plan(f, r);
  const accepted = await f.kernel.acceptPlan(r.id, p.id, { expectedRevision: p.revision });
  await assert.rejects(f.kernel.startRun(r.id, { requestId: "notAllowed", planId: p.id, expectedPlanRevision: p.revision, planDigest: accepted.digest! }), /pinned isolated worker/);
  assert.equal(f.worker.calls.length, 0);
});

test("oversized cumulative model usage is rejected, cleanup is requested, and no artifact escapes", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  await start(f, r);
  const call = await f.worker.next();
  complete(call, usage(5, 2_000));
  const db = await f.store.waitFor((db) => db.state.runs[0].status === "interrupted");
  assert.equal(db.state.artifacts.length, 0);
  assert.equal(db.state.runs[0].usage.accounting, "unknown");
  assert.equal(f.worker.cancellations.length, 1);
});

test("model-authored aggregate budget excess and authority-shaped output are rejected", { timeout: 10_000 }, async (t) => {
  let malicious = false;
  const oversize = draft([node("a"), node("b")]);
  for (const n of oversize.nodes) n.limits.maxSteps = 24;
  const f = await fixture(t, { author: { author: async () => ({ status: "completed", usage: usage(),
    draft: malicious ? { ...draft(), policy: policy(), status: "accepted" } : oversize }) } });
  const a = await room(f.kernel, "a");
  await f.kernel.authorPlan(a.id, { requestId: "over", expectedRoomRevision: 1, goal: "Oversized graph" });
  await f.store.waitFor((db) => db.state.authorings[0].status === "failed");
  malicious = true;
  const b = await room(f.kernel, "b");
  await f.kernel.authorPlan(b.id, { requestId: "authority", expectedRoomRevision: 1, goal: "Authority is not model selectable" });
  await f.store.waitFor((db) => db.state.authorings[1].status === "failed");
  assert.equal((await f.kernel.state()).plans.length, 0);
  assert.equal(f.worker.calls.length, 0);
});

test("cancelled authoring aborts its invocation and retains unknown spend without publishing late drafts", { timeout: 10_000 }, async (t) => {
  const pending = deferred<AuthoringResult>();
  const entered = deferred<AbortSignal>();
  const f = await fixture(t, { author: { author: async (_input, context) => { entered.resolve(context.signal); return pending.promise; } } });
  const r = await room(f.kernel);
  const author = await f.kernel.authorPlan(r.id, { requestId: "cancel", expectedRoomRevision: 1, goal: "Cancel this authoring" });
  const signal = await entered.promise;
  const cancelled = await f.kernel.cancelAuthoring(r.id, author.id, { expectedRevision: author.revision });
  assert.equal(signal.aborted, true);
  assert.equal(cancelled.usage.accounting, "unknown");
  assert.equal(cancelled.usage.reservedTokens, r.policy.authoringBudget.maxTokens);
  pending.resolve({ status: "completed", draft: draft(), usage: usage() });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await f.kernel.state()).plans.length, 0);
  assert.equal((await f.kernel.state()).authorings[0].status, "cancelled");
});

test("wall-time watchdog requests actual cleanup rather than only changing UI state", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const r = await room(f.kernel);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await start(f, r);
  const call = await f.worker.next();
  t.mock.timers.tick(30_001);
  const db = await f.store.waitFor((db) => db.state.runs[0].status === "interrupted");
  assert.equal(call.context.signal.aborted, true);
  assert.equal(f.worker.cancellations.length, 1);
  assert.equal(db.state.runs[0].nodes[0].error, "Worker wall-time budget exhausted");
  assert.equal(db.state.runs[0].usage.accounting, "unknown");
  t.mock.timers.reset();
});

test("run fairness survives interleaved room turns instead of always favoring the first run", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { maximum: 1, draft: draft([node("first"), node("second")]) });
  const a = await room(f.kernel, "a");
  const { request } = await start(f, a);
  const firstA = await f.worker.next();
  const secondRun = await f.kernel.startRun(a.id, { ...request, requestId: "another_a" });
  const b = await room(f.kernel, "b");
  await start(f, b);
  complete(firstA);
  const firstB = await f.worker.next();
  assert.equal(firstB.spec.ref.roomId, b.id);
  complete(firstB);
  const secondA = await f.worker.next();
  assert.equal(secondA.spec.ref.runId, secondRun.id);
});
