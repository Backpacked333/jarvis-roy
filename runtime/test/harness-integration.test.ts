import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import { createHarnessKernel } from "../bridge/harness-kernel/index.ts";
import { createWorkerRunner } from "../bridge/harness-worker/index.ts";
import { createPlanAuthor, createQuestionRouter } from "../bridge/harness-interactions/index.ts";
import { createVoiceBridge } from "../bridge/harness-voice/index.ts";
import { createHarnessRuntime, type HarnessRuntime } from "../bridge/harness-runtime.ts";
import { defaultRoomPolicy, type AttemptRef, type PlanDraft } from "../bridge/harness-contracts/domain.ts";
import { HarnessStateSchema, type HarnessState, type PlanAuthor } from "../bridge/harness-contracts/service.ts";
import type { Cancellation, WorkerContext, WorkerResult, WorkerRunner, WorkerSpec } from "../bridge/harness-contracts/worker.ts";
import { questionBinding } from "../bridge/harness-contracts/interactions.ts";
import { FakeDelivery, FakeEveClient, approvalEvents, event } from "./helpers.ts";

const token = "harness-integration-token-at-least-32-characters";
const image = process.env.JARVIS_WORKER_IMAGE ?? "python@sha256:2986c55feb36e6cae00fa1fefb454283e4b33f35e75ff8bdd123b134130be301";
const enabled = process.env.JARVIS_WORKER_DOCKER_TESTS === "1";
const policy = () => {
  const p = defaultRoomPolicy(image);
  p.runBudget = { ...p.runBudget, maxSteps: 20, maxModelCalls: 20, maxTokens: 150_000, maxWallTimeMs: 240_000 };
  return p;
};
const node = (id: string, dependencies: string[] = []): PlanDraft["nodes"][number] => ({ id, title: id, role: dependencies.length ? "tester" : "builder",
  instructions: `Integration ${id}: create and check a harmless text file.`, dependencies, inputFrom: dependencies,
  outputPaths: id === "question" ? ["output.txt", "once.txt"] : ["output.txt"],
  limits: { maxSteps: 6, maxModelCalls: 6, maxTokens: 50_000, maxOutputTokensPerCall: 512, maxWallTimeMs: 90_000, estimatedUsdLimit: null } });

function scriptedProvider(): typeof fetch {
  const counts = new Map<string, number>();
  return (async (_url, init) => {
    const request = JSON.parse(init!.body as string), serialized = JSON.stringify(request.messages);
    const role = ["build", "verify", "question", "independent", "cancel"].find((id) => serialized.includes(`Integration ${id}:`));
    assert.ok(role, "Worker request must retain its scoped node instructions");
    const index = counts.get(role) ?? 0;
    counts.set(role, index + 1);
    let tool: [string, Record<string, string>];
    if (role === "question") {
      const steps: [string, Record<string, string>][] = [
        ["write_file", { path: "once.txt", content: "written before question" }],
        ["ask_question", { prompt: "Which greeting should the artifact contain?" }],
        ["write_file", { path: "output.txt", content: "Hello Roy" }],
        ["run_check", { command: "python -I -S -c 'assert open(\"once.txt\").read()==\"written before question\"; assert open(\"output.txt\").read()==\"Hello Roy\"'" }],
        ["final_answer", { answer: "Verified the resumed files." }],
      ];
      if (index >= 2) assert.match(serialized, /Bound clarification answer/);
      tool = steps[index];
    } else if (role === "cancel") {
      tool = ["run_check", { command: "python -I -S -c 'import time; time.sleep(20)'" }];
    } else {
      const content = role === "verify" ? "reviewed exact upstream bytes" : "real scoped bytes";
      const steps: [string, Record<string, string>][] = role === "verify" ? [
        ["run_check", { command: "python -I -S -c 'assert open(\"output.txt\").read()==\"real scoped bytes\"'" }],
        ["write_file", { path: "output.txt", content }],
        ["run_check", { command: "python -I -S -c 'assert open(\"output.txt\").read()==\"reviewed exact upstream bytes\"'" }],
        ["final_answer", { answer: "Checked immutable upstream bytes and report." }],
      ] : [
        ["write_file", { path: "output.txt", content }],
        ["run_check", { command: "python -I -S -c 'assert open(\"output.txt\").read()==\"real scoped bytes\"'" }],
        ["final_answer", { answer: "Checked real bytes." }],
      ];
      tool = steps[index];
    }
    assert.ok(tool, "No unexpected model calls");
    return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 30 }, choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: `call_${role}_${index}`, type: "function", function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }],
    } }] });
  }) as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class StopWorker implements WorkerRunner {
  launches = 0;
  cancellations = 0;
  started = deferred<void>();
  stopping = deferred<void>();
  cleanup: (ref: AttemptRef) => Promise<Cancellation> = async (ref) => ({ ref, confirmed: true, reason: null });
  artifacts = { read: async (): Promise<never> => { throw new Error("No artifacts in cancellation fixture"); } };
  async availability() { return { available: true, reason: null }; }
  async reconcile(ref: AttemptRef) { return { state: "unknown" as const, ref, reason: "Unconfirmed fixture resource" }; }
  async run(spec: WorkerSpec, context: WorkerContext): Promise<WorkerResult> {
    this.launches++;
    await context.emit({ type: "started", ref: spec.ref, sequence: 0, at: new Date().toISOString(), resourceId: "controlled-stop-resource" });
    this.started.resolve();
    return new Promise(() => {});
  }
  async cancel(ref: AttemptRef) {
    this.cancellations++;
    this.stopping.resolve();
    return this.cleanup(ref);
  }
}

async function fixture(t: TestContext, live = false, options: { worker?: WorkerRunner; author?: PlanAuthor; stopTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-integrated-"));
  const worker = options.worker ?? createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: scriptedProvider() });
  const author = options.author ?? createPlanAuthor({ model: "fixture/model", modelClient: { async complete(input) {
    const goal = JSON.parse(input.prompt).untrustedData.goal;
    const nodes = goal === "graph" ? [node("build"), node("verify", ["build"])] : [node(goal)];
    return { text: JSON.stringify({ kind: "plan", draft: { goal, nodes } }), inputTokens: 50, outputTokens: 150 };
  } } });
  const client = new FakeEveClient();
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  let runtime: HarnessRuntime;
  let server: ReturnType<typeof createBridgeServer>;
  let base: string;
  async function start() {
    if (live) runtime = await createHarnessRuntime(directory, process.env.JARVIS_WORKER_MODEL!);
    else {
      const harness = createHarnessKernel({ dataDirectory: directory, worker, author, defaultPolicy: policy(), maxActiveWorkers: 2 });
      await harness.initialize();
      runtime = { harness, worker, questions: createQuestionRouter({ harness }), voice: createVoiceBridge({}), stopping: false };
    }
    process.env.JARVIS_LOCAL_TOKEN = token;
    server = createBridgeServer(service, "127.0.0.1", 0, runtime, { stopTimeoutMs: options.stopTimeoutMs });
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  await start();
  t.after(async () => { await shutdownBridge(server); await rm(directory, { recursive: true, force: true }); });
  async function request(path: string, method = "GET", body?: unknown, expected = 200) {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    assert.equal(response.status, expected, raw);
    return JSON.parse(raw);
  }
  const state = async () => HarnessStateSchema.parse(await request("/v1/harness/state"));
  async function wait(predicate: (s: HarnessState) => boolean) {
    const deadline = Date.now() + 90_000;
    let snapshot = await state();
    while (!predicate(snapshot)) {
      assert.ok(snapshot.runs.every((r) => !["failed", "interrupted"].includes(r.status)), JSON.stringify(snapshot.runs));
      assert.ok(Date.now() < deadline, `Integrated state deadline: ${JSON.stringify(snapshot.runs.map((r) => ({ status: r.status, nodes: r.nodes })))}`);
      await delay(35); snapshot = await state();
    }
    return snapshot;
  }
  async function createRoom(title: string) {
    return request("/v1/harness/rooms", "POST", { requestId: `room-${title}`, title, description: "Harmless integration fixture", policy: policy() }, 201);
  }
  let authorRequest = 0;
  async function accept(room: any, goal: string) {
    const authoring = await request(`/v1/harness/rooms/${room.id}/author`, "POST", { requestId: `author-${++authorRequest}`, expectedRoomRevision: room.revision, goal }, 202);
    const snapshot = await wait((s) => s.authorings.some((a) => a.id === authoring.id && a.status !== "authoring"));
    const a = snapshot.authorings.find((a) => a.id === authoring.id)!;
    assert.equal(a.status, "completed", a.error ?? "authoring");
    const draft = snapshot.plans.find((p) => p.id === a.planId)!;
    return request(`/v1/harness/rooms/${room.id}/plans/${draft.id}/accept`, "POST", { expectedRevision: draft.revision });
  }
  async function run(room: any, plan: any) {
    return request(`/v1/harness/rooms/${room.id}/runs`, "POST", { requestId: `start-${plan.id}`, planId: plan.id, expectedPlanRevision: plan.revision, planDigest: plan.digest }, 202);
  }
  return { directory, service, client, request, state, wait, createRoom, accept, run,
    get base() { return base; }, get runtime() { return runtime; }, get server() { return server; },
    restart: async () => { await shutdownBridge(server); await start(); } };
}

test("integrated HTTP boundaries, scoped drafting, separate accept/start and exact WS auth", async (t) => {
  const f = await fixture(t);
  const room = await f.createRoom("one"), other = await f.createRoom("two");
  const plan = await f.accept(room, "graph");
  assert.equal((await f.state()).runs.length, 0, "Accepted plan does not execute itself");
  await f.request(`/v1/harness/rooms/${other.id}/plans/${plan.id}/accept`, "POST", { expectedRevision: plan.revision }, 404);
  await f.request(`/v1/harness/rooms/${room.id}`, "PATCH", { expectedRevision: 999, title: "stale" }, 409);
  await f.request("/v1/harness/events?after=-1", "GET", undefined, 400);
  await f.request("/v1/harness/rooms", "POST", { title: "invalid" }, 400);
  for (const path of ["/v1/harness/state", "/v1/voice/status"]) {
    assert.equal((await fetch(f.base + path)).status, 401);
    assert.equal((await fetch(f.base + path, { headers: { authorization: `Bearer ${token}`, origin: "http://localhost" } })).status, 403);
  }
  async function rejected(headers: Record<string, string>, path = "/v1/voice/stream") {
    const socket = new WebSocket(f.base.replace("http:", "ws:") + path, { headers });
    socket.on("error", () => {});
    const [, response] = await once(socket, "unexpected-response");
    socket.terminate();
    return response.statusCode;
  }
  assert.equal(await rejected({}), 401);
  assert.equal(await rejected({ authorization: `Bearer ${token}`, origin: "http://localhost" }), 403);
  assert.equal(await rejected({ authorization: `Bearer ${token}`, host: "attacker.invalid" }), 403);
  assert.equal(await rejected({ authorization: `Bearer ${token}` }, "/v1/voice/stream?token=invalid"), 404);
  const socket = new WebSocket(f.base.replace("http:", "ws:") + "/v1/voice/stream", { headers: { authorization: `Bearer ${token}` } });
  await once(socket, "open");
  const closed = once(socket, "close");
  await f.request("/v1/stop", "POST");
  await closed;
  assert.equal((await f.request("/v1/voice/status")).status, "unavailable");
});

test("authorized live production composition authors and executes a harmless plan through HTTP", {
  skip: process.env.JARVIS_HARNESS_LIVE_TEST !== "1", timeout: 120_000,
}, async (t) => {
  assert.ok(process.env.AI_GATEWAY_API_KEY && process.env.JARVIS_WORKER_MODEL && process.env.JARVIS_WORKER_IMAGE,
    "Live proof requires an authorized Gateway key, explicit model and pinned image");
  const f = await fixture(t, true), room = await f.createRoom("live-proof");
  const plan = await f.accept(room, "Draft exactly one builder node, no dependencies, outputPaths exactly [hello.txt], no clarification. " +
    "Limits maxSteps=4 maxModelCalls=4 maxTokens=24000 maxOutputTokensPerCall=512 maxWallTimeMs=60000 estimatedUsdLimit=null. " +
    "Instruct worker to use exactly three tool calls, one per response: write_file hello.txt with content Hello from integrated Jarvis followed by a newline; " +
    "run_check with python -I -S -c 'assert open(\"hello.txt\").read() == \"Hello from integrated Jarvis\\n\"; print(\"passed\")'; " +
    "final_answer with a brief factual result. No other actions, network, files or questions.");
  assert.equal(plan.nodes.length, 1);
  console.log(JSON.stringify({ livePlanLimits: plan.nodes[0].limits }));
  assert.ok(plan.nodes[0].limits.maxModelCalls <= 4 && plan.nodes[0].limits.maxTokens <= 24_000);
  const run = await f.run(room, plan);
  const done = await f.wait((s) => s.runs.find((r) => r.id === run.id)?.status === "completed");
  const manifest = done.artifacts.find((a) => a.runId === run.id)!;
  assert.equal(manifest.verification, "passed");
  const response = await fetch(f.base + `/v1/harness/rooms/${room.id}/runs/${run.id}/artifacts/${manifest.id}/content?path=hello.txt&digest=${manifest.digest}`,
    { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Hello from integrated Jarvis\n");
  console.log(JSON.stringify({ liveIntegratedProof: "passed", authorUsage: done.authorings[0].usage, workerUsage: done.runs[0].usage }));
});

test("generic Eve questions have exact card text responses; ambient text and speech never approve", async (t) => {
  const f = await fixture(t);
  f.client.session.initial = new FakeDelivery([
    event("turn.started", { turnId: "turn-question" }, 1),
    event("interaction.opened", { interactionId: "question-exact", request: { kind: "question", prompt: "Which label?", allowFreeform: true } }, 2),
  ], { status: "awaiting-input", outcome: "awaiting-input" });
  const task = await f.service.createTask("Ask an explicit question");
  await f.client.session.initial.streamComplete;
  await f.service.waitForObservedDelivery(task.id);
  let root = await f.request("/v1/state");
  assert.equal(root.tasks[0].approvals.length, 0);
  assert.equal(root.tasks[0].questions[0].kind, "question");
  assert.deepEqual((await f.state()).approvals, []);
  await f.request("/v1/tasks", "POST", { conversationId: task.conversationId, message: "yes" }, 409);
  await f.request(`/v1/tasks/${task.id}/respond`, "POST", { interactionId: "question-exact", text: "Roy", expectedRevision: 2 }, 409);
  f.client.session.responseDelivery = new FakeDelivery([], { status: "completed", reply: "Answer acknowledged" });
  await f.request(`/v1/tasks/${task.id}/respond`, "POST", { interactionId: "question-exact", text: "Roy", expectedRevision: 1 });
  assert.deepEqual(f.client.session.responses, [[{ interactionId: "question-exact", text: "Roy" }]]);
  await f.client.session.responseDelivery.streamComplete;
  await f.service.waitForObservedDelivery(task.id);
  root = await f.request("/v1/state");
  assert.equal(root.tasks[0].status, "completed");
});

test("Stop all holds a common admission barrier until both roots and rooms finish", async (t) => {
  const f = await fixture(t);
  let release!: () => void, began!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { began = resolve; });
  const original = f.service.stop.bind(f.service);
  f.service.stop = async () => { began(); await stopped; return original(); };
  const stopping = f.request("/v1/stop", "POST");
  await started;
  try {
    await f.request("/v1/harness/rooms", "POST", { requestId: "race", title: "Blocked room" }, 409);
    await f.request("/v1/tasks", "POST", { message: "Blocked task" }, 409);
    await f.request("/v1/stop", "POST", undefined, 409);
    await f.request("/v1/state");
    const socket = new WebSocket(f.base.replace("http:", "ws:") + "/v1/voice/stream", { headers: { authorization: `Bearer ${token}` } });
    socket.on("error", () => {});
    const [, response] = await once(socket, "unexpected-response");
    socket.terminate();
    assert.equal(response.statusCode, 404);
  } finally { release(); await stopping; }
  assert.equal((await f.state()).rooms.length, 0);
  await f.createRoom("after-stop");
});

for (const timing of ["during", "after"] as const) {
  for (const kind of ["run", "root", "approval", "author"] as const) {
    test(`Stop all rejects a pre-stop partial ${kind} body completed ${timing} stop`, async (t) => {
      const worker = new StopWorker(), f = await fixture(t, false, { worker });
      const room = await f.createRoom("partial");
      const plan = await f.accept(room, "independent");
      let path = `/v1/harness/rooms/${room.id}/runs`;
      let body: unknown = { requestId: "late-run", planId: plan.id, expectedPlanRevision: plan.revision, planDigest: plan.digest };
      let rootDispatches = 0;
      if (kind === "root") {
        path = "/v1/tasks"; body = { message: "Late root work" };
        const original = f.service.createTask.bind(f.service);
        f.service.createTask = async (...args) => { rootDispatches++; return original(...args); };
      } else if (kind === "approval") {
        f.client.session.initial = new FakeDelivery(approvalEvents(), { status: "awaiting-input", outcome: "awaiting-input" });
        const task = await f.service.createTask("Wait for exact approval");
        await f.client.session.initial.streamComplete;
        await f.service.waitForObservedDelivery(task.id);
        path = `/v1/tasks/${task.id}/respond`;
        body = { interactionId: "interaction-1", optionId: "approve", expectedRevision: 1 };
        const original = f.service.respond.bind(f.service);
        f.service.respond = async (...args) => { rootDispatches++; return original(...args); };
      } else if (kind === "author") {
        path = `/v1/harness/rooms/${room.id}/author`;
        body = { requestId: "late-root-tool-author", expectedRoomRevision: room.revision, goal: "independent" };
      }
      const serialized = JSON.stringify(body), entered = once(f.server, "request");
      const response = deferred<{ status: number; text: string }>();
      const pending = httpRequest(f.base + path, { method: "POST", headers: { authorization: `Bearer ${token}`,
        "content-type": "application/json", "content-length": Buffer.byteLength(serialized) } }, (incoming) => {
        let text = ""; incoming.on("data", (chunk) => { text += chunk; });
        incoming.on("end", () => response.resolve({ status: incoming.statusCode!, text }));
      });
      t.after(() => pending.destroy());
      pending.write(serialized.slice(0, 1));
      const [incoming] = await entered;
      const release = deferred<void>(), began = deferred<void>();
      const originalStop = f.service.stop.bind(f.service);
      f.service.stop = async () => { began.resolve(); await release.promise; return originalStop(); };
      const stopped = f.request("/v1/stop", "POST");
      await began.promise;
      if (timing === "after") { release.resolve(); await stopped; }
      const ended = once(incoming, "end");
      pending.end(serialized.slice(1));
      await ended;
      release.resolve();
      await stopped;
      const late = await response.promise;
      assert.equal(late.status, 409, late.text);
      assert.equal(rootDispatches, 0, "Stale task/approval requests must never reach Eve dispatch");
      assert.equal(worker.launches, 0);
      const snapshot = await f.state();
      assert.equal(snapshot.runs.length, 0);
      assert.equal(snapshot.authorings.length, 1, "Late root-tool authoring was not created");
      await f.createRoom("fresh-request");
    });
  }
}

test("Stop all snapshots only after already admitted run dispatch and confirms its cleanup", async (t) => {
  const worker = new StopWorker(), f = await fixture(t, false, { worker });
  const room = await f.createRoom("admitted"), plan = await f.accept(room, "independent");
  const entered = deferred<void>(), release = deferred<void>();
  const start = f.runtime.harness.startRun.bind(f.runtime.harness);
  f.runtime.harness.startRun = async (...args) => { entered.resolve(); await release.promise; return start(...args); };
  const run = f.run(room, plan);
  await entered.promise;
  let snapshotTaken = false;
  const stop = f.service.stop.bind(f.service);
  f.service.stop = async () => { snapshotTaken = true; return stop(); };
  const stopEntered = once(f.server, "request");
  const stopped = f.request("/v1/stop", "POST");
  await stopEntered;
  assert.equal(snapshotTaken, false);
  release.resolve();
  await run; await stopped;
  const result = (await f.state()).runs[0];
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelConfirmed, true);
});

test("Stop all rejects root-created authoring until root cancellation has finished", async (t) => {
  const f = await fixture(t), room = await f.createRoom("root-tool");
  const original = f.service.stop.bind(f.service);
  f.service.stop = async () => {
    await f.request(`/v1/harness/rooms/${room.id}/author`, "POST",
      { requestId: "root-still-running", expectedRoomRevision: room.revision, goal: "independent" }, 409);
    return original();
  };
  await f.request("/v1/stop", "POST");
  assert.equal((await f.state()).authorings.length, 0);
  f.service.stop = original;
});

test("Stop all drains admitted root approvals before taking cancellation snapshots", async (t) => {
  const f = await fixture(t);
  f.client.session.initial = new FakeDelivery(approvalEvents(), { status: "awaiting-input", outcome: "awaiting-input" });
  f.client.session.responseDelivery = new FakeDelivery([], { status: "awaiting-input", outcome: "awaiting-input" });
  const task = await f.service.createTask("Explicit approval dispatch fixture");
  await f.client.session.initial.streamComplete;
  await f.service.waitForObservedDelivery(task.id);
  const release = deferred<void>(), entered = deferred<void>();
  const respond = f.service.respond.bind(f.service);
  f.service.respond = async (...args) => { entered.resolve(); await release.promise; return respond(...args); };
  const response = f.request(`/v1/tasks/${task.id}/respond`, "POST", { interactionId: "interaction-1", optionId: "approve", expectedRevision: 1 });
  await entered.promise;
  let snapshotTaken = false;
  const originalStop = f.service.stop.bind(f.service);
  f.service.stop = async () => { snapshotTaken = true; return originalStop(); };
  const stopEntered = once(f.server, "request"), stopped = f.request("/v1/stop", "POST");
  await stopEntered;
  assert.equal(snapshotTaken, false);
  release.resolve();
  await response; await stopped;
  assert.equal((await f.request("/v1/state")).tasks[0].status, "cancelled");
  assert.equal(f.client.session.responses.length, 1, "Admitted explicit action is drained, never replayed");
});

test("Stop all includes an admitted authoring created after the stop request arrived", async (t) => {
  let aborted = false;
  const author: PlanAuthor = { async author(_input, { signal }) {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("Authoring cancelled")); }, { once: true });
    });
  } };
  const f = await fixture(t, false, { author }), room = await f.createRoom("admitted-author");
  const entered = deferred<void>(), release = deferred<void>();
  const original = f.runtime.harness.authorPlan.bind(f.runtime.harness);
  f.runtime.harness.authorPlan = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const authoring = f.request(`/v1/harness/rooms/${room.id}/author`, "POST",
    { requestId: "admitted-author", expectedRoomRevision: room.revision, goal: "independent" }, 202);
  await entered.promise;
  const stopEntered = once(f.server, "request"), stopped = f.request("/v1/stop", "POST");
  await stopEntered;
  release.resolve();
  await authoring; await stopped;
  assert.equal((await f.state()).authorings[0].status, "cancelled");
  assert.equal(aborted, true);
});

test("Stop all times out behind admitted dispatch without opening the gate when it later drains", async (t) => {
  const f = await fixture(t, false, { stopTimeoutMs: 100 });
  const entered = deferred<void>(), release = deferred<void>();
  const settled = deferred<void>(), originalStop = f.service.stop.bind(f.service);
  f.service.stop = async () => { const result = await originalStop(); settled.resolve(); return result; };
  const create = f.service.createTask.bind(f.service);
  f.service.createTask = async (...args) => { entered.resolve(); await release.promise; return create(...args); };
  const task = f.request("/v1/tasks", "POST", { message: "Already admitted before Stop" }, 202);
  await entered.promise;
  await f.request("/v1/stop", "POST", undefined, 503);
  await f.request("/v1/stop", "POST", undefined, 409);
  await f.request("/v1/tasks", "POST", { message: "No new work while dispatch is draining" }, 409);
  release.resolve();
  await task;
  await settled.promise;
  assert.equal((await f.request("/v1/state")).tasks[0].status, "cancelled");
  await f.request("/v1/tasks", "POST", { message: "Late cleanup does not silently reopen admission" }, 409);
  await f.request("/v1/stop", "POST");
  await f.createRoom("dispatch-reconciled");
});

test("Stop all waits for delayed worker cleanup rather than a cancel_requested acknowledgement", async (t) => {
  const worker = new StopWorker(), cleanup = deferred<void>();
  worker.cleanup = async (ref) => { await cleanup.promise; return { ref, confirmed: true, reason: null }; };
  const f = await fixture(t, false, { worker });
  const room = await f.createRoom("delay"), plan = await f.accept(room, "independent");
  await f.run(room, plan); await worker.started.promise;
  let returned = false;
  const stopped = f.request("/v1/stop", "POST").then((result) => { returned = true; return result; });
  await worker.stopping.promise;
  try {
    const pending = (await f.state()).runs[0];
    assert.equal(pending.status, "cancel_requested");
    assert.equal(pending.cancelConfirmed, false);
    assert.equal(returned, false);
    await f.request("/v1/tasks", "POST", { message: "Cannot start during teardown" }, 409);
  } finally { cleanup.resolve(); await stopped; }
  assert.equal((await f.state()).runs[0].cancelConfirmed, true);
  await f.createRoom("confirmed");
});

for (const outcome of ["false", "missing", "timeout"] as const) {
  test(`Stop all retains its fence after ${outcome} cleanup until explicit reconciliation`, async (t) => {
    const worker = new StopWorker(), cleanup = deferred<void>();
    worker.cleanup = async (ref) => {
      if (outcome === "timeout") await cleanup.promise;
      if (outcome === "missing") throw new Error("Resource not found; cleanup unknown");
      return { ref, confirmed: outcome === "timeout", reason: outcome === "false" ? "Unconfirmed cleanup" : null };
    };
    const f = await fixture(t, false, { worker, stopTimeoutMs: 150 });
    const room = await f.createRoom("unconfirmed"), plan = await f.accept(room, "independent");
    await f.run(room, plan); await worker.started.promise;
    const failed = await f.request("/v1/stop", "POST", undefined, 503);
    assert.match(failed.error, /unconfirmed.*Admission remains closed|unconfirmed.*admission remains closed/);
    const pending = (await f.state()).runs[0];
    assert.equal(pending.cancelConfirmed, false);
    assert.ok(["interrupted", "cancel_requested"].includes(pending.status));
    await f.request("/v1/tasks", "POST", { message: "Must remain fenced" }, 409);
    await f.request("/v1/harness/rooms", "POST", { requestId: "fenced", title: "No new room" }, 409);
    await f.request("/v1/state");
    const socket = new WebSocket(f.base.replace("http:", "ws:") + "/v1/voice/stream", { headers: { authorization: `Bearer ${token}` } });
    socket.on("error", () => {});
    const [, rejected] = await once(socket, "unexpected-response");
    socket.terminate(); assert.equal(rejected.statusCode, 404);
    worker.cleanup = async (ref) => ({ ref, confirmed: true, reason: null });
    cleanup.resolve();
    let snapshot = (await f.state()).runs[0];
    if (outcome !== "timeout") await f.request(`/v1/harness/rooms/${room.id}/runs/${snapshot.id}/cancel`, "POST", { expectedRevision: snapshot.revision });
    for (let attempt = 0; attempt < 100 && !(snapshot = (await f.state()).runs[0]).cancelConfirmed; attempt++) await delay(5);
    assert.equal(snapshot.cancelConfirmed, true);
    await f.request("/v1/tasks", "POST", { message: "Late success alone cannot reopen admission" }, 409);
    await f.request("/v1/stop", "POST");
    await f.createRoom("reconciled");
  });
}

for (const stage of ["initial snapshot", "cleanup confirmation"] as const) {
  test(`Stop all rejects an empty unavailable state during ${stage}`, async (t) => {
    const worker = new StopWorker();
    const f = await fixture(t, false, { worker });
    const room = await f.createRoom("unavailable"), plan = await f.accept(room, "independent");
    await f.run(room, plan); await worker.started.promise;
    let unavailable = stage === "initial snapshot";
    const state = f.runtime.harness.state.bind(f.runtime.harness);
    f.runtime.harness.state = async () => {
      const current = await state();
      return unavailable ? { ...current, ready: false, rooms: [], plans: [], runs: [], authorings: [], questions: [], artifacts: [] } : current;
    };
    worker.cleanup = async (ref) => {
      unavailable = true;
      return { ref, confirmed: true, reason: null };
    };
    try {
      await f.request("/v1/stop", "POST", undefined, 503);
      assert.equal((await f.state()).ready, false);
      assert.equal(worker.cancellations, stage === "initial snapshot" ? 0 : 1);
      await f.request("/v1/tasks", "POST", { message: "Unavailable is not an empty confirmed stop" }, 409);
    } finally { f.runtime.harness.state = state; }
    await f.request("/v1/tasks", "POST", { message: "Recovery does not silently reopen admission" }, 409);
    await f.request("/v1/stop", "POST");
    assert.equal((await f.state()).runs[0].cancelConfirmed, true);
    await f.createRoom("available-again");
  });
}

test("Stop all reports unconfirmed root cancellation and requires an explicit successful retry", async (t) => {
  const f = await fixture(t);
  f.client.session.initial.emit(event("turn.started", { turnId: "turn-1" }, 1));
  const task = await f.request("/v1/tasks", "POST", { message: "Root cancellation fixture" }, 202);
  f.client.session.confirmCancellation = false;
  await f.request("/v1/stop", "POST", undefined, 503);
  await f.request("/v1/tasks", "POST", { message: "Root uncertainty fences new work" }, 409);
  f.client.session.confirmCancellation = true;
  await f.request(`/v1/tasks/${task.id}/cancel`, "POST");
  await f.request("/v1/tasks", "POST", { message: "Individual cancel does not lift global fence" }, 409);
  await f.request("/v1/stop", "POST");
  await f.createRoom("root-reconciled");
});

test("real HTTP → kernel → smolagents → Docker: two rooms, DAG handoff, exact question resume across restart, cancellation", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.state()).worker.available, true);
  const room = await f.createRoom("graph"), other = await f.createRoom("independent");
  const plan = await f.accept(room, "graph"), independent = await f.accept(other, "independent");
  const [run, run2] = await Promise.all([f.run(room, plan), f.run(other, independent)]);
  const done = await f.wait((s) => [run.id, run2.id].every((id) => s.runs.find((r) => r.id === id)?.status === "completed"));
  assert.equal(done.rooms.length, 2);
  const upstream = done.artifacts.find((a) => a.runId === run.id && a.nodeId === "build")!;
  const downstream = done.artifacts.find((a) => a.runId === run.id && a.nodeId === "verify")!;
  assert.deepEqual(downstream.inputDigests, [upstream.digest]);
  assert.equal(downstream.verification, "passed");
  const artifactPath = `/v1/harness/rooms/${room.id}/runs/${run.id}/artifacts/${downstream.id}/content?path=output.txt&digest=${downstream.digest}`;
  const content = await fetch(f.base + artifactPath, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(content.status, 200); assert.equal(await content.text(), "reviewed exact upstream bytes");
  assert.equal(content.headers.get("x-content-type-options"), "nosniff");
  assert.match(content.headers.get("content-security-policy")!, /sandbox/);
  await f.request(artifactPath.replace(room.id, other.id), "GET", undefined, 404);
  await f.request(artifactPath.replace("path=output.txt", "path=..%2Fsecret"), "GET", undefined, 400);
  await f.request(artifactPath.replace(downstream.digest, "0".repeat(64)), "GET", undefined, 409);
  const questionPlan = await f.accept(room, "question");
  const questionRun = await f.run(room, questionPlan);
  const waiting = await f.wait((s) => s.questions.some((q) => q.target.scope === "node" && q.target.runId === questionRun.id && q.status === "pending"));
  const question = waiting.questions.find((q) => q.target.scope === "node" && q.target.runId === questionRun.id)!;
  await f.restart();
  const pending = (await f.state()).questions.find((q) => q.id === question.id)!;
  assert.deepEqual(questionBinding(pending), questionBinding(question));
  const answer = { binding: questionBinding(question), transcript: "Hello Roy" };
  await f.request(`/v1/harness/questions/${question.id}/voice-answer`, "POST", { ...answer, binding: { ...answer.binding, target: { ...answer.binding.target, roomId: other.id } } }, 409);
  await f.request(`/v1/harness/questions/${question.id}/voice-answer`, "POST", answer);
  await f.request(`/v1/harness/questions/${question.id}/voice-answer`, "POST", answer, 409);
  const resumed = await f.wait((s) => s.runs.find((r) => r.id === questionRun.id)?.status === "completed");
  const resumedNode = resumed.runs.find((r) => r.id === questionRun.id)!.nodes[0];
  assert.notEqual(resumedNode.attemptId, question.target.scope === "node" ? question.target.attemptId : "");
  assert.equal(resumedNode.usage.modelCalls, 5);
  const cancelPlan = await f.accept(other, "cancel"), cancelled = await f.run(other, cancelPlan);
  await f.wait((s) => s.runs.find((r) => r.id === cancelled.id)?.nodes.some((n) => n.status === "running") === true);
  await f.request("/v1/stop", "POST");
  await f.wait((s) => s.runs.find((r) => r.id === cancelled.id)?.status === "cancelled");
  await f.restart();
  assert.equal((await f.state()).runs.find((r) => r.id === cancelled.id)?.status, "cancelled");
});
