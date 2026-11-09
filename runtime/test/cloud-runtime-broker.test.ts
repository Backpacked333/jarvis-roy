import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCloudRuntimeBroker, cloudRuntimeClient } from "../bridge/cloud-runtime-broker.ts";
import { createObjectiveRuntime } from "../bridge/objective-runtime.ts";
import { JarvisService } from "../bridge/service.ts";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { BridgeError } from "../bridge/errors.ts";
import type { ContinuityService } from "../bridge/continuity/index.ts";
import { FakeDelivery, FakeEveClient, approvalEvents, event } from "./helpers.ts";

const status = (expected: number) => (error: unknown) => error instanceof BridgeError && error.status === expected;
const request = (operation: string, payload: unknown) => ({ version: 1, operation, payload });
async function fixture(t: TestContext, budgeted?: () => boolean) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-cloud-broker-")), client = new FakeEveClient();
  client.session.initial = new FakeDelivery([], { status: "completed", outcome: "handled" });
  client.session.responseDelivery = new FakeDelivery([], { status: "completed", outcome: "handled" });
  const service = await JarvisService.create({ dataDirectory: directory, client });
  const objectives = await createObjectiveRuntime({ dataDirectory: directory, enabled: true });
  const broker = createCloudRuntimeBroker({ service, objectives, continuity: {} as ContinuityService,
    authority: { async readAction() { return null; }, async executeAction() { throw new Error("Question route must not execute an action"); } },
    ...(budgeted ? { cloudConversationReady: budgeted } : {}) });
  t.after(async () => { client.session.confirmCancellation = true; client.session.initial.finish({ status: "cancelled" }); client.session.responseDelivery.finish({ status: "cancelled" });
    await service.stop().catch(() => {}); await service.drain(); await objectives.service.close(); await rm(directory, { recursive: true, force: true }); });
  return { broker, service, objectives, client };
}

test("cloud conversation and task admission require the explicit budget authority callback", async t => {
  const f = await fixture(t), conversation = await f.service.createConversation("Existing", "project-a");
  await assert.rejects(f.broker(request("conversations", { method: "POST", title: "Unbudgeted", projectId: "project-a" })), status(503));
  await assert.rejects(f.broker(request("tasks", { method: "POST", message: "Unbudgeted", conversationId: conversation.id, projectId: "project-a" })), status(503));
  assert.equal(f.service.conversationSnapshot().length, 1); assert.equal(f.service.taskSnapshot().length, 0);
  const read = await f.broker(request("conversations", { method: "GET", projectId: "project-a" })) as { conversations: unknown[] };
  assert.equal(read.conversations.length, 1);
});

test("cloud project selection is immutable before first task and reads remain scoped", async t => {
  let ready = true; const f = await fixture(t, () => ready);
  const first = await f.broker(request("conversations", { method: "POST", title: "A", projectId: "project-a" })) as { id: string };
  await f.broker(request("conversations", { method: "POST", title: "B", projectId: "project-b" }));
  await assert.rejects(f.broker(request("tasks", { method: "POST", message: "Wrong project", conversationId: first.id, projectId: "project-b" })), status(403));
  await assert.rejects(f.broker(request("conversations", { method: "GET", id: first.id, projectId: "project-b" })), status(404));
  const task = await f.broker(request("tasks", { method: "POST", message: "Analyze this project", conversationId: first.id, projectId: "project-a" })) as { id: string };
  await f.service.drain();
  const read = await f.broker(request("tasks", { method: "GET", id: task.id })) as { projectId: string };
  assert.equal(read.projectId, "project-a"); assert.equal(f.service.conversationProject(first.id), "project-a");
  ready = false;
  await assert.rejects(f.broker(request("tasks", { method: "POST", message: "Another turn", conversationId: first.id, projectId: "project-a" })), status(503));
  assert.equal(f.service.taskSnapshot().length, 1);
});

test("cloud clarification answers bind the exact current question and cannot approve effects", async t => {
  await t.test("effect approval denied", async t => {
    const f = await fixture(t, () => true);
    f.client.session.initial = new FakeDelivery(approvalEvents(), { status: "awaiting-input", outcome: "awaiting-input" });
    const conversation = await f.service.createConversation("Effect", "project-a"), task = await f.service.createTask("Propose an action", conversation.id, "project-a"); await f.service.drain();
    await assert.rejects(f.broker(request("respond_question", { taskId: task.id, interactionId: "interaction-1", expectedRevision: 1, optionId: "approve" })), status(403));
    assert.equal(f.client.session.responses.length, 0);
  });
  await t.test("clarification only", async t => {
    const f = await fixture(t, () => true);
    f.client.session.initial = new FakeDelivery([
      event("turn.started", { turnId: "turn-1" }, 1),
      event("interaction.opened", { interactionId: "question-1", request: { kind: "question", title: "Choose the comparison year", prompt: "Which baseline year?", allowFreeform: true, options: [] } }, 2),
      event("turn.paused", { turnId: "turn-1", awaiting: [{ interactionId: "question-1" }] }, 3),
    ], { status: "awaiting-input", outcome: "awaiting-input" });
    const conversation = await f.service.createConversation("Question", "project-a"), task = await f.service.createTask("Compare the data", conversation.id, "project-a"); await f.service.drain();
    assert.equal(f.service.taskSnapshot()[0].questions?.[0].reviewable, true, "Channel binding uses the freshly safety-checked public question");
    await assert.rejects(f.broker(request("respond_question", { taskId: task.id, interactionId: "question-1", expectedRevision: 2, text: "2024" })), status(403));
    await assert.rejects(f.broker(request("respond_question", { taskId: task.id, interactionId: "question-1", expectedRevision: 1, text: "My password is fixture-only" })), status(400));
    assert.equal(f.client.session.responses.length, 0);
    await f.broker(request("respond_question", { taskId: task.id, interactionId: "question-1", expectedRevision: 1, text: "2024" })); await f.service.drain();
    assert.deepEqual(f.client.session.responses, [[{ interactionId: "question-1", text: "2024" }]]);
  });
});

test("private broker HTTP rejects model credentials and preserves reads during an uncertain Stop", async t => {
  const f = await fixture(t, () => true), keys = ["JARVIS_LOCAL_TOKEN", "JARVIS_CLOUD_RUNTIME_TOKEN", "JARVIS_RUNTIME_PROFILE"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.JARVIS_LOCAL_TOKEN = "broker-fixture-local-token-32-characters";
  process.env.JARVIS_CLOUD_RUNTIME_TOKEN = "broker-fixture-runtime-token-32-characters"; process.env.JARVIS_RUNTIME_PROFILE = "cloud";
  f.client.session.initial = new FakeDelivery(approvalEvents(), { status: "awaiting-input", outcome: "awaiting-input" });
  const conversation = await f.service.createConversation("Inspect after Stop", "project-a"), task = await f.service.createTask("Propose an action", conversation.id, "project-a"); await f.service.drain();
  f.client.session.confirmCancellation = false;
  const pauseObjectives = f.objectives.service.pauseAll.bind(f.objectives.service);
  f.objectives.service.pauseAll = async () => { await pauseObjectives(); throw new BridgeError("Fixture objective cancellation remains unknown", 503); };
  const server = createBridgeServer(f.service, "127.0.0.1", 0, undefined, { stopTimeoutMs: 1000, extensions: { cloudBroker: f.broker, objectives: f.objectives } }); await once(server, "listening");
  t.after(async () => { f.client.session.confirmCancellation = true; await shutdownBridge(server); for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/cloud/runtime`;
  const headers = { authorization: `Bearer ${process.env.JARVIS_LOCAL_TOKEN}`, "content-type": "application/json", "x-jarvis-cloud-runtime-token": process.env.JARVIS_CLOUD_RUNTIME_TOKEN! };
  const post = (operation: string, payload: unknown, supplied = headers) => fetch(url, { method: "POST", headers: supplied, body: JSON.stringify(request(operation, payload)), signal: AbortSignal.timeout(3000) });
  assert.equal((await post("conversations", { method: "GET" }, { ...headers, "x-jarvis-cloud-runtime-token": "model-cannot-select-owner-authority" })).status, 403);
  const directResearch = await fetch(new URL("/v1/research/runs", url), { method: "POST", headers: { ...headers, "x-jarvis-eve-session": f.client.session.id }, body: "{}" });
  assert.equal(directResearch.status, 409); assert.match((await directResearch.json()).error, /capped objective/);
  assert.equal((await post("stop", {})).status, 503);
  assert.ok(f.client.session.cancelCalls > 0, "An uncertain objective must not prevent cancellation of independent Eve tasks");
  assert.equal((await post("tasks", { method: "POST", message: "Must stay fenced", conversationId: conversation.id, projectId: "project-a" })).status, 409);
  assert.equal((await post("conversations", { method: "GET", projectId: "project-a" })).status, 200);
  const read = await post("tasks", { method: "GET", id: task.id }); assert.equal(read.status, 200);
  assert.equal((await read.json()).projectId, "project-a");
});

test("private runtime client never retries an ambiguous mutation and forwards no native authority", async () => {
  let calls = 0;
  const client = cloudRuntimeClient({ localToken: "local".repeat(8), runtimeToken: "runtime".repeat(6), fetch: (async (_url, init) => {
    calls++; assert.equal(new Headers(init!.headers).has("x-jarvis-native-token"), false); throw new Error("Lost after dispatch");
  }) as typeof fetch });
  await assert.rejects(client("tasks", { method: "POST", message: "One attempt" }), /Lost after dispatch/); assert.equal(calls, 1);
});
