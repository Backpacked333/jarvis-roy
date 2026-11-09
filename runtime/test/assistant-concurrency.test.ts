import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createAssistantRuntime } from "../bridge/assistant-runtime.ts";
import type { AssistantIntent, AssistantSession, AssistantTurn } from "../bridge/assistant/contracts.ts";
import type { HarnessRuntime } from "../bridge/harness-runtime.ts";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import type { EveClient, EveSession } from "../bridge/types.ts";
import { event, FakeDelivery } from "./helpers.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) { assert.ok(Date.now() < deadline, "Assistant concurrency fixture timed out"); await delay(5); }
}

class ConcurrentSession implements EveSession {
  readonly id = randomUUID();
  readonly initial = new FakeDelivery([event("turn.started", { turnId: "turn-1" }, 1)]);
  readonly messages: string[] = [];
  cancelCalls = 0;
  cancelGate?: Promise<void>;
  confirmCancellation = true;
  async send(message: string) {
    this.messages.push(message);
    return new FakeDelivery([], { status: "completed", reply: "Follow-up result" });
  }
  async respond(): Promise<never> { throw new Error("Concurrency fixture has no approval"); }
  async cancel() {
    this.cancelCalls++;
    await this.cancelGate;
    if (!this.confirmCancellation) return new FakeDelivery([], { status: "completed", outcome: "applied" });
    const cancelled = event("turn.settled", { turnId: "turn-1", outcome: "cancelled" }, 20);
    this.initial.emit(cancelled);
    this.initial.finish({ status: "cancelled" });
    return new FakeDelivery([cancelled], { status: "completed", outcome: "applied" });
  }
}

async function fixture(t: TestContext) {
  const environment = { JARVIS_ENABLE_ASSISTANT: "1",
    JARVIS_LOCAL_TOKEN: "concurrency-local-token-at-least-32-characters",
    JARVIS_NATIVE_TOKEN: "concurrency-native-token-at-least-32-characters" };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const directory = await mkdtemp(join(tmpdir(), "jarvis-assistant-concurrency-"));
  const sessions = new Map<string, ConcurrentSession>(), cancelGate = deferred();
  const client: EveClient = {
    async health() { return { ok: true }; },
    sessions: {
      async create({ message }) {
        const session = new ConcurrentSession();
        session.messages.push(message); sessions.set(session.id, session);
        return { session, delivery: session.initial };
      },
      attach(id) { const session = sessions.get(id); assert.ok(session); return session; },
    },
  };
  const service = await JarvisService.create({ dataDirectory: directory, model: "fixture/model", client });
  const roomId = "concurrent-room";
  // Exercise the real bridge, coordinator, and task service without worker/provider dependencies.
  const harness = { harness: { async state() {
    return { ready: true, rooms: [{ id: roomId }], runs: [], authorings: [] };
  } } } as unknown as HarnessRuntime;
  const assistant = await createAssistantRuntime(directory, service, harness);
  const server = createBridgeServer(service, "127.0.0.1", 0, undefined, { stopTimeoutMs: 2_000,
    extensions: { assistant: assistant.coordinator, close: () => assistant.close() } });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    cancelGate.resolve();
    for (const session of sessions.values()) session.confirmCancellation = true;
    try { await shutdownBridge(server); }
    finally {
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  async function request(path: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: {
      authorization: `Bearer ${environment.JARVIS_LOCAL_TOKEN}`, "x-jarvis-native-token": environment.JARVIS_NATIVE_TOKEN,
      "content-type": "application/json",
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const created = await request("/v1/assistant/sessions", { title: "Concurrent work", focus: { kind: "room", roomId } });
  assert.equal(created.status, 201);
  const session = created.body as AssistantSession;
  async function turn(text: string, intent: AssistantIntent) {
    return request(`/v1/assistant/sessions/${session.id}/turns`, { expectedRevision: session.revision, text, intent });
  }
  async function startMainAndSide() {
    const [mainResponse, sideResponse] = await Promise.all([
      turn("Main investigation", "continue"), turn("Side question", "side_question"),
    ]);
    assert.equal(mainResponse.status, 202); assert.equal(sideResponse.status, 202);
    const main = mainResponse.body as AssistantTurn, side = sideResponse.body as AssistantTurn;
    assert.equal(main.status, "running"); assert.equal(side.status, "running");
    assert.notEqual(main.conversationId, side.conversationId);
    await until(() => service.taskSnapshot().length === 2 && service.taskSnapshot().every(task => task.status === "running"));
    assert.equal(sessions.size, 2);
    for (const eve of sessions.values()) assert.equal(service.contextForEveSession(eve.id)?.projectId, roomId);
    return { main, side };
  }
  return { request, turn, startMainAndSide, service, sessions, cancelGate, roomId };
}

test("room Stop this work cancels concurrent main and side tasks while preserving other projects", async t => {
  const f = await fixture(t);
  const { main, side } = await f.startMainAndSide();
  const unrelated = await f.service.createTask("Independent work", undefined, "other-project");
  await until(() => f.service.taskSnapshot().find(task => task.id === unrelated.id)?.status === "running");
  const stop = await f.turn("Stop this work", "stop_work");
  assert.equal(stop.status, 202);
  assert.equal((stop.body as AssistantTurn).status, "completed");
  for (const taskId of [main.taskId, side.taskId]) {
    assert.equal(f.service.taskSnapshot().find(task => task.id === taskId)?.status, "cancelled",
      "A completed room Stop must confirm cancellation of its assistant tasks");
  }
  assert.equal(f.service.taskSnapshot().find(task => task.id === unrelated.id)?.status, "running");
  for (const session of f.sessions.values()) {
    assert.equal(session.cancelCalls, f.service.contextForEveSession(session.id)?.projectId === f.roomId ? 1 : 0);
  }
});

test("Stop all fences a concurrent late turn and later continues the original main conversation", async t => {
  const f = await fixture(t);
  const { main } = await f.startMainAndSide();
  for (const session of f.sessions.values()) session.cancelGate = f.cancelGate.promise;
  const stopping = f.request("/v1/stop", {});
  await until(() => [...f.sessions.values()].every(session => session.cancelCalls === 1));
  const late = await f.turn("Do not admit this while stopping", "side_question");
  assert.equal(late.status, 409);
  assert.equal(f.sessions.size, 2);
  f.cancelGate.resolve();
  const stopped = await stopping;
  assert.equal(stopped.status, 200);
  assert.ok(f.service.taskSnapshot().every(task => task.status === "cancelled"));
  const followup = await f.turn("Continue main after stop", "continue");
  assert.equal(followup.status, 202);
  assert.equal((followup.body as AssistantTurn).conversationId, main.conversationId);
  await f.service.drain();
  assert.equal(f.sessions.size, 2, "The main Eve session must be reused");
  assert.equal(f.service.taskSnapshot().find(task => task.id === (followup.body as AssistantTurn).taskId)?.status, "completed");
  assert.deepEqual([...f.sessions.values()].flatMap(session => session.messages).sort(),
    ["Main investigation", "Side question", "Continue main after stop"].sort());
});

test("room Stop remains failed when Eve acknowledges the request without confirming cancellation", async t => {
  const f = await fixture(t);
  const { main, side } = await f.startMainAndSide();
  const mainSession = [...f.sessions.values()].find(session => f.service.contextForEveSession(session.id)?.taskId === main.taskId)!;
  mainSession.confirmCancellation = false;
  const stop = await f.turn("Stop this work", "stop_work");
  assert.equal(stop.status, 202);
  assert.equal((stop.body as AssistantTurn).status, "failed");
  assert.equal(f.service.taskSnapshot().find(task => task.id === main.taskId)?.status, "running");
  assert.equal(f.service.taskSnapshot().find(task => task.id === side.taskId)?.status, "cancelled");
  assert.equal(f.service.hasUnsettledProjectWork(f.roomId), true);
  assert.equal(mainSession.cancelCalls, 1);
  mainSession.confirmCancellation = true;
  const retried = await f.turn("Retry stopping this work", "stop_work");
  assert.equal(retried.status, 202);
  assert.equal((retried.body as AssistantTurn).status, "completed");
  assert.equal(f.service.hasUnsettledProjectWork(f.roomId), false);
  assert.equal(mainSession.cancelCalls, 2);
});
