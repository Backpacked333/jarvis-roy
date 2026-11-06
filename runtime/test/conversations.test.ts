import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "eve/client";
import { BridgeError } from "../bridge/errors.ts";
import { createBridgeServer } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import { TaskStore } from "../bridge/store.ts";
import type { BridgeState, Conversation, EveClient, EveDelivery, EveSession, Task, TaskRecord } from "../bridge/types.ts";
import { event, FakeDelivery } from "./helpers.ts";

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture state did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FixtureSession implements EveSession {
  readonly id = randomUUID();
  readonly history: string[] = [];
  readonly modelInputs: string[][] = [];
  readonly deliveries: FakeDelivery[] = [];
  readonly cancellations: Array<{ turnId?: string | null }> = [];
  autoComplete = true;
  confirmCancellation = true;
  wrongCancellationTurn = false;
  private line = 0;

  async send(message: string): Promise<EveDelivery> {
    this.modelInputs.push([...this.history, message]);
    this.history.push(message);
    const turnId = `turn-${this.deliveries.length + 1}`;
    const delivery = new FakeDelivery();
    this.deliveries.push(delivery);
    delivery.emit(event("turn.started", { turnId }, ++this.line));
    if (this.autoComplete) {
      const reply = `Fixture reply ${this.deliveries.length}`;
      const content = event("content.completed", {
        partId: `reply-${turnId}`, kind: "text", phase: "reply", value: reply,
      }, ++this.line);
      delivery.emit(content);
      delivery.emit(content);
      delivery.emit(event("turn.settled", { turnId, outcome: "completed" }, ++this.line));
      this.history.push(reply);
      delivery.finish({ status: "completed", outcome: "handled", reply });
    }
    return delivery;
  }

  async respond(): Promise<EveDelivery> {
    throw new Error("No approval is pending in this fixture.");
  }

  async cancel(options?: { turnId?: string | null }): Promise<EveDelivery> {
    this.cancellations.push({ turnId: options?.turnId });
    const turnId = this.wrongCancellationTurn ? "unrelated-turn" :
      options?.turnId ?? `turn-${this.deliveries.length}`;
    return new FakeDelivery(this.confirmCancellation ? [
      event("turn.settled", { turnId, outcome: "cancelled" }, ++this.line),
    ] : [], { status: "completed", outcome: "applied" });
  }
}

class FixtureClient implements EveClient {
  readonly instances = new Map<string, FixtureSession>();
  readonly attached: string[] = [];
  autoComplete = true;
  createGate?: Promise<void>;
  health = async () => ({ status: "ready", ok: true });
  readonly sessions = {
    create: async ({ message }: { message: string }) => {
      if (this.createGate) await this.createGate;
      const session = new FixtureSession();
      session.autoComplete = this.autoComplete;
      this.instances.set(session.id, session);
      return { session, delivery: await session.send(message) };
    },
    attach: (id: string) => {
      this.attached.push(id);
      const session = this.instances.get(id);
      if (!session) throw new Error("Fixture session unavailable; restore the runtime session store.");
      return session;
    },
  };
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-conversations-"));
  const client = new FixtureClient();
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }));
  return { directory, client, service };
}

async function completed(service: JarvisService, id: string): Promise<Task> {
  await until(async () => (await service.state()).tasks.find((task) => task.id === id)?.status === "completed");
  return (await service.state()).tasks.find((task) => task.id === id)!;
}

function bridgeStatus(status: number) {
  return (error: unknown) => error instanceof BridgeError && error.status === status;
}

test("follow-up attaches the same SDK session, retaining turn history and deduplicated transcript", async (t) => {
  const { service, client, directory } = await setup(t);
  const conversation = await service.createConversation("A real thread");
  const first = await service.createTask("My fixture project is Cedar.", conversation.id);
  await completed(service, first.id);
  const second = await service.createTask("What did I call it?", conversation.id);
  await completed(service, second.id);
  const session = [...client.instances.values()][0]!;
  assert.deepEqual(client.attached, [session.id]);
  assert.equal(client.instances.size, 1);
  assert.deepEqual(session.modelInputs[1], [
    "My fixture project is Cedar.", "Fixture reply 1", "What did I call it?",
  ]);
  const state = await service.state();
  assert.deepEqual(state.conversations[0]!.messages.map(({ role, text, taskId }) => ({ role, text, taskId })), [
    { role: "user", text: "My fixture project is Cedar.", taskId: first.id },
    { role: "assistant", text: "Fixture reply 1", taskId: first.id },
    { role: "user", text: "What did I call it?", taskId: second.id },
    { role: "assistant", text: "Fixture reply 2", taskId: second.id },
  ]);
  assert.equal(first.userMessage, "My fixture project is Cedar.");
  assert.equal(JSON.stringify(state).includes(session.id), false);
  const saved = JSON.parse(await readFile(path.join(directory, "tasks.json"), "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(saved.conversations[0].sessionId, session.id);
  assert.equal((await stat(path.join(directory, "tasks.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("independent compatibility tasks become isolated threads and never share history", async (t) => {
  const { service, client } = await setup(t);
  const first = await service.createTask("Thread A.");
  await completed(service, first.id);
  const second = await service.createTask("Thread B.");
  await completed(service, second.id);
  assert.notEqual(first.conversationId, second.conversationId);
  assert.equal(client.instances.size, 2);
  assert.deepEqual([...client.instances.values()].map((session) => session.modelInputs[0]), [
    ["Thread A."], ["Thread B."],
  ]);
  assert.equal((await service.state()).conversations.length, 2);
});

test("bundled Eve client creates once and sends follow-ups to the same persisted HTTP session", async (t) => {
  const { directory } = await setup(t);
  const wireSessions = new Map<string, { history: string[]; modelInputs: string[][]; lines: string[] }>();
  const submissions: string[] = [];
  const fixtureToken = "fixture-sdk-token-at-least-32-characters";
  const transport = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${fixtureToken}`);
      const url = new URL(request.url!, "http://127.0.0.1");
      if (url.pathname === "/eve/v1/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, status: "ready", workflowId: "fixture-workflow" }));
        return;
      }
      if (request.method === "POST") {
        submissions.push(url.pathname);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(typeof body.message, "string");
        const isCreate = url.pathname === "/eve/v1/session";
        const id = isCreate ? randomUUID() : url.pathname.split("/").at(-1)!;
        if (isCreate) wireSessions.set(id, { history: [], modelInputs: [], lines: [] });
        const session = wireSessions.get(id)!;
        assert.ok(session);
        session.modelInputs.push([...session.history, body.message]);
        const turnId = `turn_${session.lines.length}`;
        const deliveryId = randomUUID();
        const partId = randomUUID();
        const reply = `Wire fixture reply ${session.modelInputs.length}`;
        session.history.push(body.message, reply);
        session.lines.push(JSON.stringify({ at: new Date().toISOString(), facts: [
          { type: "delivery.admitted", data: { deliveryId, source: { kind: "message" } } },
          { type: "turn.started", scope: { turnId }, data: { turnId } },
          { type: "delivery.consumed", scope: { turnId }, data: {
            deliveryId, turnId, parts: [{ type: "text", text: body.message }],
          } },
          { type: "content.completed", scope: { turnId }, data: {
            partId, kind: "text", phase: "reply", value: reply,
          } },
          { type: "turn.settled", scope: { turnId }, data: { turnId, outcome: "completed", reply: [partId] } },
          { type: "delivery.settled", data: { deliveryId, turnId, outcome: "handled" } },
        ] }));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ sessionId: id, deliveryId }));
        return;
      }
      const id = url.pathname.split("/").at(-2)!;
      const session = wireSessions.get(id)!;
      assert.ok(session);
      const start = Number(url.searchParams.get("startIndex") ?? 0);
      response.writeHead(200, {
        "content-type": "application/x-ndjson", "x-eve-stream-version": "27",
      });
      response.end(`${session.lines.slice(start).join("\n")}\n${JSON.stringify({ $eve: "stream.ended" })}\n`);
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  }).listen(0, "127.0.0.1");
  await once(transport, "listening");
  t.after(() => new Promise<void>((resolve) => transport.close(() => resolve())));
  const address = transport.address();
  assert.ok(address && typeof address !== "string");
  const client: EveClient = new Client({
    baseUrl: `http://127.0.0.1:${address.port}`, auth: { bearer: fixtureToken }, redirect: "error",
  });
  const service = await JarvisService.create({ client, dataDirectory: directory });
  const first = await service.createTask("Wire context Cedar.");
  await completed(service, first.id);
  const restarted = await JarvisService.create({ client, dataDirectory: directory });
  const second = await restarted.createTask("Wire follow-up.", first.conversationId);
  await completed(restarted, second.id);
  assert.equal(wireSessions.size, 1);
  const [id, session] = [...wireSessions][0]!;
  assert.deepEqual(submissions, ["/eve/v1/session", `/eve/v1/session/${id}`]);
  assert.deepEqual(session.modelInputs[1], ["Wire context Cedar.", "Wire fixture reply 1", "Wire follow-up."]);
  assert.deepEqual((await restarted.state()).conversations[0]!.messages.map((message) => message.text), [
    "Wire context Cedar.", "Wire fixture reply 1", "Wire follow-up.", "Wire fixture reply 2",
  ]);
});

test("restart preserves session identity, transcript IDs, and uses attach for the next turn", async (t) => {
  const { service, client, directory } = await setup(t);
  const first = await service.createTask("Persist this context.");
  await completed(service, first.id);
  const before = (await service.state()).conversations[0]!;
  const restarted = await JarvisService.create({ client, dataDirectory: directory });
  assert.deepEqual((await restarted.state()).conversations[0], before);
  const second = await restarted.createTask("Continue that context.", first.conversationId);
  await completed(restarted, second.id);
  assert.equal(client.instances.size, 1);
  assert.deepEqual([...client.instances.values()][0]!.modelInputs[1], [
    "Persist this context.", "Fixture reply 1", "Continue that context.",
  ]);
});

test("simultaneous submits reserve a thread before any await and enforce the global four limit", async (t) => {
  const { service, client } = await setup(t);
  let release!: () => void;
  client.createGate = new Promise<void>((resolve) => { release = resolve; });
  const conversation = await service.createConversation();
  const results = await Promise.allSettled([
    service.createTask("First wins.", conversation.id),
    service.createTask("Second must conflict.", conversation.id),
  ]);
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  if (results[1]!.status === "rejected") assert.ok(bridgeStatus(409)(results[1]!.reason));
  const other = await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
    service.createTask(`Independent fixture ${index}.`)));
  assert.equal(other.filter((result) => result.status === "fulfilled").length, 3);
  assert.equal(other.filter((result) => result.status === "rejected").length, 1);
  release();
  await until(async () => (await service.state()).tasks.every((task) => task.status === "completed"));
});

test("restart blocks an uncertain turn until cancellation is confirmed, then continues the same session", async (t) => {
  const { service, client, directory } = await setup(t);
  client.autoComplete = false;
  const first = await service.createTask("Pause this fixture.");
  await until(async () => (await service.state()).tasks[0]?.status === "running");
  const session = [...client.instances.values()][0]!;
  session.deliveries[0]!.finish({ status: "awaiting-input" });
  await until(async () => (await service.state()).tasks[0]?.status === "waiting");
  const restarted = await JarvisService.create({ client, dataDirectory: directory });
  await assert.rejects(restarted.createTask("Cannot overlap.", first.conversationId), bridgeStatus(409));
  session.confirmCancellation = false;
  const unconfirmed = await restarted.cancel(first.id);
  assert.equal(unconfirmed.status, "interrupted");
  assert.match(unconfirmed.error!, /did not confirm/);
  await assert.rejects(restarted.createTask("Still cannot overlap.", first.conversationId), bridgeStatus(409));
  session.confirmCancellation = true;
  assert.equal((await restarted.cancel(first.id)).status, "cancelled");
  assert.deepEqual(session.cancellations, [{ turnId: "turn-1" }, { turnId: "turn-1" }]);
  session.autoComplete = true;
  const next = await restarted.createTask("Now continue safely.", first.conversationId);
  await completed(restarted, next.id);
  assert.equal(client.instances.size, 1);
});

test("cancellation is turn-scoped, retains late text once, and cannot cancel another conversation", async (t) => {
  const { service, client } = await setup(t);
  client.autoComplete = false;
  const first = await service.createTask("Thread A work.");
  const second = await service.createTask("Thread B work.");
  await until(async () => (await service.state()).tasks.every((task) => task.status === "running"));
  const [a, b] = [...client.instances.values()];
  const stopping = service.cancel(first.id);
  await until(async () => (await service.state()).tasks.find((task) => task.id === first.id)?.status === "cancelled");
  await assert.rejects(service.createTask("Do not race cancellation.", first.conversationId), bridgeStatus(409));
  const late = event("content.completed", {
    partId: "late-part", kind: "text", phase: "reply", value: "Late fixture answer.",
  }, 100);
  a!.deliveries[0]!.emit(late);
  a!.deliveries[0]!.emit(late);
  a!.deliveries[0]!.finish({ status: "completed", reply: "Late fixture answer." });
  const cancelled = await stopping;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.reply, "");
  assert.equal(cancelled.lateReply, "Late fixture answer.");
  assert.deepEqual(a!.cancellations, [{ turnId: "turn-1" }]);
  assert.deepEqual(b!.cancellations, []);
  let state = await service.state();
  assert.equal(state.tasks.find((task) => task.id === second.id)!.status, "running");
  assert.deepEqual(state.conversations.find((thread) => thread.id === first.conversationId)!.messages.map((message) => message.text), [
    "Thread A work.", "Late fixture answer.",
  ]);
  a!.autoComplete = true;
  const next = await service.createTask("Next A turn.", first.conversationId);
  await completed(service, next.id);
  assert.equal((await service.cancel(first.id)).status, "cancelled");
  assert.equal(a!.cancellations.length, 1);
  b!.deliveries[0]!.finish({ status: "completed", reply: "B only." });
  await completed(service, second.id);
  state = await service.state();
  assert.equal(state.conversations.find((thread) => thread.id === second.conversationId)!.messages[1]!.text, "B only.");
});

test("a cancellation receipt for another turn is not confirmation", async (t) => {
  const { service, client } = await setup(t);
  client.autoComplete = false;
  const task = await service.createTask("Keep this exact turn.");
  await until(async () => (await service.state()).tasks[0]?.status === "running");
  const session = [...client.instances.values()][0]!;
  session.wrongCancellationTurn = true;
  const result = await service.cancel(task.id);
  assert.equal(result.status, "running");
  assert.match(result.error!, /did not confirm/);
  session.deliveries[0]!.finish({ status: "completed", reply: "Not cancelled." });
  await completed(service, task.id);
});

test("unknown or malformed conversation IDs never create threads; validation rejects secrets and overlong input", async (t) => {
  const { service, client } = await setup(t);
  for (const id of [randomUUID(), "../thread", "", "x".repeat(1000)]) {
    await assert.rejects(service.createTask("Hello.", id), bridgeStatus(404));
  }
  for (const title of ["", " ", "x".repeat(121), "password=fixture"]) {
    await assert.rejects(service.createConversation(title), bridgeStatus(400));
  }
  for (const message of ["", "x".repeat(20_001), "api_key=fixture"]) {
    await assert.rejects(service.createTask(message), bridgeStatus(400));
  }
  assert.deepEqual((await service.state()).conversations, []);
  assert.equal(client.instances.size, 0);
});

function legacyTask(id: string, status: TaskRecord["status"] = "completed"): TaskRecord {
  return {
    id, title: `Legacy ${id}`, status, reply: "An actual saved reply.",
    createdAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
    events: ["Actual saved event."], approvals: [], childTasks: {}, sessionId: `session-${id}`,
  };
}

test("legacy migration preserves history, creates one thread per task, and never invents missing user text", async (t) => {
  const { directory, client } = await setup(t);
  const legacy = [legacyTask("completed"), legacyTask("uncertain", "running")];
  await writeFile(path.join(directory, "tasks.json"), JSON.stringify(legacy));
  const service = await JarvisService.create({ client, dataDirectory: directory });
  const state = await service.state();
  assert.equal(state.tasks.length, 2);
  assert.equal(state.conversations.length, 2);
  assert.notEqual(state.tasks[0]!.conversationId, state.tasks[1]!.conversationId);
  for (const original of legacy) {
    const task = state.tasks.find((item) => item.id === original.id)!;
    assert.equal(task.reply, original.reply);
    assert.deepEqual(task.events, original.events);
    assert.equal(task.userMessage, null);
    const thread = state.conversations.find((item) => item.id === task.conversationId)!;
    assert.deepEqual(thread.messages.map((message) => [message.role, message.text]), [["assistant", original.reply]]);
  }
  assert.equal(state.tasks.find((task) => task.id === "uncertain")!.status, "interrupted");
  const again = await JarvisService.create({ client, dataDirectory: directory });
  assert.deepEqual((await again.state()).conversations, state.conversations);
});

test("retention prunes completed task messages atomically without orphaning or pruning uncertain threads", async (t) => {
  const { directory } = await setup(t);
  const store = new TaskStore(directory);
  await store.initialize();
  const uncertain = legacyTask("uncertain", "interrupted");
  await store.add(uncertain);
  for (let index = 0; index < 110; index++) {
    await store.add({ ...legacyTask(`done-${index}`), createdAt: new Date(Date.UTC(2025, 0, 1) + index).toISOString() });
  }
  assert.equal(store.values().length, 100);
  assert.equal(store.conversations().length, 100);
  assert.equal(store.get("done-0"), undefined);
  assert.ok(store.get("uncertain"));
  assert.ok(store.conversation(uncertain.conversationId!));
  for (const thread of store.conversations()) {
    for (const message of thread.messages) {
      assert.equal(store.get(message.taskId)!.conversationId, thread.id);
    }
  }
  const restarted = new TaskStore(directory);
  await restarted.initialize();
  assert.equal(restarted.values().length, 100);
  assert.ok(restarted.conversation(uncertain.conversationId!));
});

test("history refuses symlinks both on load and on subsequent writes", async (t) => {
  const { directory, service } = await setup(t);
  const stateFile = path.join(directory, "tasks.json");
  const target = path.join(directory, "do-not-touch.json");
  await writeFile(target, "[]");
  await rm(stateFile);
  await symlink(target, stateFile);
  await assert.rejects(service.createConversation(), /regular files/);
  const store = new TaskStore(directory);
  await assert.rejects(store.initialize(), /regular files/);
  assert.equal(await readFile(target, "utf8"), "[]");
});

test("empty conversation retention keeps the newly returned ID and every uncertain conversation", async (t) => {
  const { directory, service } = await setup(t);
  const task = await service.createTask("Keep my live identity.");
  await completed(service, task.id);
  let newest!: Conversation;
  for (let index = 0; index < 105; index++) newest = await service.createConversation(`Empty thread ${index}`);
  let state = await service.state();
  assert.equal(state.conversations.length, 100);
  assert.ok(state.conversations.some((thread) => thread.id === newest.id));
  const next = await service.createTask("Returned ID is still usable.", newest.id);
  await completed(service, next.id);
  state = await service.state();
  const store = new TaskStore(directory);
  await store.initialize();
  const uncertain = legacyTask("uncertain-retention", "interrupted");
  await store.add(uncertain);
  for (let index = 0; index < 110; index++) {
    await store.addConversation({
      id: randomUUID(), title: "Empty", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), messages: [],
    });
  }
  assert.ok(store.conversation(uncertain.conversationId!));
  assert.ok(store.get(uncertain.id));
  assert.equal(store.conversations().length, 100);
});

test("pruning cannot discard a confirmed-cancelled task while its late transcript is still observed", async (t) => {
  const { directory } = await setup(t);
  const store = new TaskStore(directory);
  await store.initialize();
  const observing = { ...legacyTask("still-observing", "cancelled"), observingDeliveries: 1, cancelConfirmed: true };
  await store.add(observing);
  for (let index = 0; index < 105; index++) {
    await store.add({ ...legacyTask(`later-${index}`), createdAt: new Date(Date.UTC(2025, 0, 1) + index).toISOString() });
  }
  assert.ok(store.get(observing.id));
  assert.ok(store.conversation(observing.conversationId!));
  await store.update(observing.id, (task) => { task.lateReply = "Late preserved fixture."; });
  assert.equal(store.conversation(observing.conversationId!)!.messages[0]!.text, "Late preserved fixture.");
});

test("authenticated HTTP exposes conversations, validates bodies, and preserves legacy task submissions", async (t) => {
  const { service } = await setup(t);
  const token = "fixture-local-token-at-least-32-characters";
  process.env.JARVIS_LOCAL_TOKEN = token;
  const server = createBridgeServer(service, "127.0.0.1", 0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (route: string, body: unknown, headers = {}) => fetch(`${base}${route}`, {
    method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", ...headers,
    }, body: JSON.stringify(body),
  });
  assert.equal((await post("/v1/conversations", {}, { origin: "http://localhost" })).status, 403);
  assert.equal((await post("/v1/conversations", {}, { authorization: "Bearer invalid" })).status, 401);
  assert.equal((await post("/v1/conversations", { title: 42 })).status, 400);
  const response = await post("/v1/conversations", { title: "HTTP thread" });
  assert.equal(response.status, 201);
  const conversation = await response.json() as Conversation;
  const sent = await post("/v1/tasks", { message: "HTTP turn.", conversationId: conversation.id });
  assert.equal(sent.status, 202);
  const task = await sent.json() as Task;
  assert.equal(task.conversationId, conversation.id);
  await completed(service, task.id);
  assert.equal((await post("/v1/tasks", { message: "Unknown.", conversationId: randomUUID() })).status, 404);
  assert.equal((await post("/v1/tasks", { message: "Wrong type.", conversationId: null })).status, 400);
  const legacy = await post("/v1/tasks", { message: "Compatible single task." });
  assert.equal(legacy.status, 202);
  await completed(service, (await legacy.json() as Task).id);
  const stateResponse = await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${token}` } });
  const state = await stateResponse.json() as BridgeState;
  assert.equal(state.ready, true);
  assert.equal(state.model, "fixture/model");
  assert.equal(state.tasks.length, 2);
  assert.equal(state.conversations.length, 2);
  assert.deepEqual(state.memories, []);
});
