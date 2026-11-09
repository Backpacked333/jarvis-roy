import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { HarnessKernel } from "../bridge/harness-kernel/kernel.ts";
import { SqliteKernelStore } from "../bridge/harness-kernel/store.ts";
import { zeroUsage } from "../bridge/harness-kernel/model.ts";
import { defaultRoomPolicy, type ArtifactManifest, type PlanDraft } from "../bridge/harness-contracts/domain.ts";
import { artifactDigest, sha256 } from "../bridge/harness-contracts/validation.ts";
import type { WorkerRunner, WorkerSpec } from "../bridge/harness-contracts/worker.ts";
import { archiveRoute } from "../bridge/archive-routes.ts";

const policy = () => defaultRoomPolicy(`sha256:${"1".repeat(64)}`);
const draft: PlanDraft = { goal: "Create a result", nodes: [{ id: "build", title: "Build", role: "builder", instructions: "Write result", dependencies: [], inputFrom: [], outputPaths: ["result.txt"], limits: { maxSteps: 4, maxModelCalls: 4, maxTokens: 2_000, maxOutputTokensPerCall: 256, maxWallTimeMs: 30_000, estimatedUsdLimit: null } }] };
const author = { async author() { return { status: "completed" as const, draft, usage: zeroUsage() }; } };
function artifact(spec: WorkerSpec): ArtifactManifest {
  const result: ArtifactManifest = { version: 1, id: `artifact_${spec.ref.attemptId}`, ...spec.ref, planDigest: spec.planDigest, digest: "0".repeat(64), createdAt: new Date().toISOString(),
    files: [{ path: "result.txt", sha256: sha256("verified fixture"), bytes: 16, mediaType: "text/plain" }], inputDigests: [], verification: "unverified", verificationSummary: "Fixture metadata" };
  result.digest = artifactDigest(result); return result;
}
const worker: WorkerRunner = {
  async availability() { return { available: true, reason: null }; },
  async run(spec, context) {
    await context.emit({ type: "started", ref: spec.ref, sequence: 0, at: new Date().toISOString(), resourceId: `fixture-${spec.ref.attemptId}` });
    return { status: "completed", ref: spec.ref, usage: zeroUsage(), artifacts: [artifact(spec)], summary: "Fixture done" };
  },
  async cancel(ref) { return { ref, confirmed: true, reason: null }; },
  async reconcile(ref) { return { state: "missing", ref, reason: "No fixture process" }; },
  artifacts: { async read() { throw new Error("Archive fixtures validate manifests; they do not impersonate worker artifact storage"); } },
};
async function directory(t: { after: (f: () => Promise<void>) => void }) {
  const value = await mkdtemp(path.join(tmpdir(), "jarvis-archive-"));
  t.after(() => rm(value, { recursive: true, force: true })); return value;
}
async function waitFor(kernel: HarnessKernel, predicate: (state: Awaited<ReturnType<HarnessKernel["state"]>>) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { const state = await kernel.state(); if (predicate(state)) return state; await delay(5); }
  throw new Error("Fixture did not settle");
}

test("settled room archive preserves scoped artifacts and deduplication across restart", async t => {
  const dataDirectory = await directory(t);
  let kernel = new HarnessKernel({ dataDirectory, worker, author });
  t.after(() => kernel.shutdown()); await kernel.initialize();
  const input = { requestId: "create-original", title: "Archived project", description: "", policy: policy() };
  const room = await kernel.createRoom(input);
  const unrelated = await kernel.createRoom({ ...input, requestId: "unrelated", title: "Keep active" });
  await kernel.authorPlan(room.id, { requestId: "author", expectedRoomRevision: room.revision, goal: draft.goal });
  const authored = await waitFor(kernel, state => state.plans.length === 1);
  const accepted = await kernel.acceptPlan(room.id, authored.plans[0].id, { expectedRevision: authored.plans[0].revision });
  const run = await kernel.startRun(room.id, { requestId: "start", planId: accepted.id, expectedPlanRevision: accepted.revision, planDigest: accepted.digest! });
  const completed = await waitFor(kernel, state => state.runs.some(value => value.id === run.id && value.status === "completed"));
  // Let the runner's settled callback remove its transient execution handle.
  await delay(10);
  const inactive = await kernel.updateRoom(room.id, { expectedRevision: room.revision, status: "archived" });
  const summary = await kernel.archiveRoom(room.id, inactive.revision);
  assert.equal(summary.counts.runs, 1); assert.equal(summary.counts.artifacts, 1);
  assert.deepEqual((await kernel.state()).rooms.map(value => value.id), [unrelated.id]);
  const archive = await kernel.readArchive(summary.id, room.id);
  assert.deepEqual(archive.snapshot.state.rooms.map(value => value.id), [room.id]);
  assert.equal(archive.snapshot.attempts.length, 1);
  assert.equal((await kernel.artifact(room.id, run.id, completed.artifacts[0].id)).digest, completed.artifacts[0].digest);
  await assert.rejects(kernel.readArchive(summary.id, unrelated.id), /not found/);
  await assert.rejects(kernel.createRoom(input), /archived history/);
  await kernel.shutdown();
  kernel = new HarnessKernel({ dataDirectory, worker, author }); await kernel.initialize();
  assert.equal((await kernel.listArchives(room.id))[0].id, summary.id);
  assert.equal((await kernel.readArchive(summary.id, room.id)).summary.digest, summary.digest);
  await assert.rejects(kernel.createRoom(input), /archived history/);
  const snapshot = new DatabaseSync(path.join(dataDirectory, "harness-kernel", "kernel.sqlite"));
  // The kernel's exclusive lock also prevents bypassing the archive transaction.
  assert.throws(() => snapshot.prepare("SELECT body FROM snapshot").get(), /locked/); snapshot.close();
});

test("archive requires exact revision, explicitly archived room and settled authoring", async t => {
  const dataDirectory = await directory(t);
  let release!: (value: { status: "completed"; draft: PlanDraft; usage: ReturnType<typeof zeroUsage> }) => void;
  const kernel = new HarnessKernel({ dataDirectory, worker, author: { async author() { return new Promise(resolve => { release = resolve; }); } } });
  t.after(() => kernel.shutdown()); await kernel.initialize();
  const room = await kernel.createRoom({ requestId: "create", title: "Busy room", description: "", policy: policy() });
  await assert.rejects(kernel.archiveRoom(room.id, room.revision), /Mark the room archived/);
  await kernel.authorPlan(room.id, { requestId: "author", expectedRoomRevision: room.revision, goal: draft.goal });
  await waitFor(kernel, state => state.authorings.some(value => value.status === "authoring"));
  const inactive = await kernel.updateRoom(room.id, { expectedRevision: room.revision, status: "archived" });
  await assert.rejects(kernel.archiveRoom(room.id, room.revision), /Stale revision/);
  await assert.rejects(kernel.archiveRoom(room.id, inactive.revision), /active, uncertain/);
  release({ status: "completed", draft, usage: zeroUsage() });
  await waitFor(kernel, state => state.authorings[0].status === "completed"); await delay(5);
  const summary = await kernel.archiveRoom(room.id, inactive.revision);
  assert.equal(summary.counts.plans, 1);
});

test("archive persistence failure retains live history and immutable export without publishing catalog", async t => {
  const dataDirectory = await directory(t), store = new SqliteKernelStore(dataDirectory);
  let kernel = new HarnessKernel({ dataDirectory, worker, author }, store);
  t.after(() => kernel.shutdown()); await kernel.initialize();
  const room = await kernel.createRoom({ requestId: "create", title: "Keep on failure", description: "", policy: policy() });
  const inactive = await kernel.updateRoom(room.id, { expectedRevision: room.revision, status: "archived" });
  (store as unknown as { connection: DatabaseSync }).connection.exec("PRAGMA query_only=ON");
  await assert.rejects(kernel.archiveRoom(room.id, inactive.revision));
  assert.equal((await kernel.state()).rooms[0].id, room.id);
  assert.equal((await readdir(path.join(dataDirectory, "harness-kernel", "archives"))).length, 1);
  await kernel.shutdown(); kernel = new HarnessKernel({ dataDirectory, worker, author }); await kernel.initialize();
  assert.equal((await kernel.listArchives()).length, 0);
  assert.equal((await kernel.state()).rooms[0].id, room.id);
  assert.equal((await kernel.archiveRoom(room.id, inactive.revision)).roomId, room.id);
});

test("unknown provider accounting cannot be discarded by archiving a failed author", async t => {
  const dataDirectory = await directory(t);
  const kernel = new HarnessKernel({ dataDirectory, worker, author: { async author() { return { status: "failed", error: "Provider outcome unconfirmed", usage: { ...zeroUsage(), accounting: "unknown" } }; } } });
  t.after(() => kernel.shutdown()); await kernel.initialize();
  const room = await kernel.createRoom({ requestId: "create", title: "Uncertain cost", description: "", policy: policy() });
  await kernel.authorPlan(room.id, { requestId: "author", expectedRoomRevision: room.revision, goal: draft.goal });
  await waitFor(kernel, state => state.authorings[0]?.status === "failed");
  const inactive = await kernel.updateRoom(room.id, { expectedRevision: room.revision, status: "archived" });
  await assert.rejects(kernel.archiveRoom(room.id, inactive.revision), /uncertain/);
  assert.equal((await kernel.state()).authorings[0].usage.accounting, "unknown");
  assert.equal((await kernel.listArchives()).length, 0);
});

test("archive digest tampering fails closed and a v1 store is backed up before migration", async t => {
  const dataDirectory = await directory(t); let kernel = new HarnessKernel({ dataDirectory, worker, author });
  t.after(() => kernel.shutdown()); await kernel.initialize();
  const room = await kernel.createRoom({ requestId: "create", title: "Migrate", description: "", policy: policy() });
  await kernel.shutdown();
  const file = path.join(dataDirectory, "harness-kernel", "kernel.sqlite"), database = new DatabaseSync(file);
  database.exec("DROP TABLE room_archives; DROP TABLE archive_requests; DROP TABLE archive_entities; PRAGMA user_version=1;"); database.close();
  kernel = new HarnessKernel({ dataDirectory, worker, author }); await kernel.initialize();
  assert.ok((await readFile(path.join(dataDirectory, "harness-kernel", "kernel-v1.before-archives.sqlite"))).length > 0);
  const inactive = await kernel.updateRoom(room.id, { expectedRevision: room.revision, status: "archived" });
  const summary = await kernel.archiveRoom(room.id, inactive.revision);
  const archivePath = path.join(dataDirectory, "harness-kernel", "archives", `${summary.id}.json`);
  const original = JSON.parse(await readFile(archivePath, "utf8")); original.snapshot.state.rooms[0].title = "tampered";
  await writeFile(archivePath, JSON.stringify(original));
  await assert.rejects(kernel.readArchive(summary.id, room.id), /integrity/);
});

test("archive routes require native authority and root-work clearance before exact room archival", async t => {
  const dataDirectory = await directory(t), kernel = new HarnessKernel({ dataDirectory, worker, author });
  t.after(() => kernel.shutdown()); await kernel.initialize();
  const room = await kernel.createRoom({ requestId: "create", title: "Route room", description: "", policy: policy() });
  const inactive = await kernel.updateRoom(room.id, { expectedRevision: room.revision, status: "archived" });
  const url = (path: string) => new URL(`http://127.0.0.1:39202${path}`);
  const context = { nativeAuthenticated: true, enabled: true, hasUnsettledProjectWork: () => false };
  await assert.rejects(archiveRoute("GET", url("/v1/harness/archives"), undefined, kernel, { ...context, nativeAuthenticated: false }), /native controls/);
  await assert.rejects(archiveRoute("GET", url("/v1/harness/archives"), undefined, kernel, { ...context, enabled: false }), /Enable/);
  const target = url(`/v1/harness/rooms/${room.id}/archive`);
  await assert.rejects(archiveRoute("POST", target, { expectedRevision: inactive.revision }, kernel, { ...context, hasUnsettledProjectWork: async () => true }), /root work/);
  assert.equal((await kernel.state()).rooms.length, 1);
  const reply = await archiveRoute("POST", target, { expectedRevision: inactive.revision }, kernel, context);
  assert.equal(reply?.status, 201);
  const archives = await kernel.listArchives();
  const listing = await archiveRoute("GET", url(`/v1/harness/archives?roomId=${room.id}`), undefined, kernel, context);
  assert.equal((listing?.body as { archives: unknown[] }).archives.length, 1);
  assert.equal((await archiveRoute("GET", url(`/v1/harness/archives/${archives[0].id}?roomId=${room.id}`), undefined, kernel, context))?.status, 200);
  await assert.rejects(archiveRoute("GET", url(`/v1/harness/archives/${archives[0].id}?roomId=another-room`), undefined, kernel, context), /not found/);
  await assert.rejects(archiveRoute("GET", target, undefined, kernel, context), /Unsupported/);
  assert.equal(await archiveRoute("GET", url("/v1/harness/state"), undefined, kernel, context), null);
});
