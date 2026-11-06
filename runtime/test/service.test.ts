import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JarvisService } from "../bridge/service.ts";
import { BridgeError } from "../bridge/errors.ts";
import { TaskStore } from "../bridge/store.ts";
import type { TaskRecord } from "../bridge/types.ts";
import { FakeDelivery, FakeEveClient, approvalEvents, completedEvents, event } from "./helpers.ts";

async function makeService(client = new FakeEveClient()) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "jarvis-service-"));
  const service = await JarvisService.create({ client, dataDirectory, model: "test/model" });
  return {
    service,
    client,
    dataDirectory,
    close: () => rm(dataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 10,
    }),
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for service state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("tasks persist actual approval input, response, and completed result", async (t) => {
  const setup = await makeService();
  t.after(setup.close);
  const { service, client } = setup;
  client.session.initial = new FakeDelivery(
    approvalEvents(),
    { status: "awaiting-input", outcome: "awaiting-input", reply: undefined },
  );
  client.session.responseDelivery = new FakeDelivery(completedEvents(), {
    status: "completed",
    outcome: "handled",
    reply: "Preference saved.",
  });

  const task = await service.createTask("Please save this preference.");
  assert.equal(task.status, "starting");
  await waitFor(async () => (await service.state()).tasks[0]?.status === "waiting");
  let state = await service.state();
  const waitingTask = state.tasks[0];
  assert.equal(waitingTask?.approvals[0]?.id, "interaction-1");
  assert.match(waitingTask?.approvals[0]?.detail ?? "", /I prefer concise answers/);
  assert.deepEqual(waitingTask?.approvals[0]?.options.map((option) => option.id), ["approve", "deny"]);

  let releaseResponse!: () => void;
  client.session.respondGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const response = service.respond(task.id, "interaction-1", "approve");
  await waitFor(async () => client.session.responses.length === 1);
  await assert.rejects(
    service.respond(task.id, "interaction-1", "approve"),
    (error: unknown) => error instanceof BridgeError && error.status === 409,
  );
  releaseResponse();
  await response;
  await waitFor(async () => (await service.state()).tasks[0]?.status === "completed");
  state = await service.state();
  assert.equal(state.tasks[0]?.reply, "Preference saved.");
  const persisted = JSON.parse(await readFile(path.join(setup.dataDirectory, "tasks.json"), "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.tasks[0].reply, "Preference saved.");
  assert.equal(persisted.tasks[0].status, "completed");
});

test("cancellation waits for the eve turn-settled confirmation", async (t) => {
  const setup = await makeService();
  t.after(setup.close);
  const runningDelivery = new FakeDelivery();
  runningDelivery.emit(event("turn.started", { turnId: "turn-1" }, 1));
  setup.client.session.initial = runningDelivery;
  const task = await setup.service.createTask("Keep this task running.");
  await waitFor(async () => setup.service.state().then((state) => state.tasks[0]?.status === "running"));

  const result = await setup.service.cancel(task.id);
  assert.equal(setup.client.session.cancelCalls, 1);
  assert.equal(result.status, "cancelled");
  assert.match(result.events.join(" "), /Turn cancelled/);
  await setup.client.session.initial.streamComplete;
});

test("stop reattaches interrupted sessions and retries unconfirmed cancellation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-reattach-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  await store.initialize();
  await store.add({
    id: "interrupted-task",
    title: "Recover cancellation",
    status: "waiting",
    reply: "",
    error: "Runtime restarted before cancellation was confirmed.",
    createdAt: new Date().toISOString(),
    events: [],
    approvals: [{
      id: "saved-interaction",
      title: "Saved prompt",
      detail: "Do not approve automatically.",
      options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
    }],
    sessionId: "persisted-session-id",
    childTasks: {},
  });
  const client = new FakeEveClient();
  client.session.confirmCancellation = false;
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "test/model" });
  const restored = (await service.state()).tasks[0];
  assert.equal(restored?.status, "interrupted");
  assert.deepEqual(restored?.approvals, []);

  const [unconfirmed] = await service.stop();
  assert.equal(client.attachCalls[0], "persisted-session-id");
  assert.equal(client.session.cancelCalls, 1);
  assert.equal(unconfirmed?.status, "interrupted");
  assert.match(unconfirmed?.error ?? "", /did not confirm/);

  client.session.confirmCancellation = true;
  const [cancelled] = await service.stop();
  assert.deepEqual(client.attachCalls, ["persisted-session-id"]);
  assert.equal(client.session.cancelCalls, 2);
  assert.equal(cancelled?.status, "cancelled");
});

test("interrupted tasks without a saved Eve session ID remain unconfirmed", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-no-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  await store.initialize();
  await store.add({
    id: "interrupted-task",
    title: "No session ID",
    status: "interrupted",
    reply: "",
    createdAt: new Date().toISOString(),
    events: [],
    approvals: [],
    childTasks: {},
  });
  const client = new FakeEveClient();
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "test/model" });

  const [result] = await service.stop();
  assert.equal(result?.status, "interrupted");
  assert.match(result?.error ?? "", /no saved eve session ID/);
  assert.deepEqual(client.attachCalls, []);
  assert.equal(client.session.cancelCalls, 0);
});

test("late delivery results cannot overwrite cancellation or unknown child state", async (t) => {
  const setup = await makeService();
  t.after(setup.close);
  const runningDelivery = new FakeDelivery();
  runningDelivery.emit(event("turn.started", { turnId: "turn-1" }, 1));
  runningDelivery.emit(event("task.started", {
    taskId: "child-task",
    name: "analyst",
    kind: "agent",
  }, 2));
  setup.client.session.initial = runningDelivery;
  setup.client.session.postCancelResult = { status: "completed", reply: "Late result." };
  const task = await setup.service.createTask("Cancel while a child is active.");
  await waitFor(async () => (await setup.service.state()).tasks[0]?.status === "running");

  const result = await setup.service.cancel(task.id);
  assert.equal(result.status, "interrupted");
  assert.match(result.error ?? "", /child-task endings were not confirmed/);
  assert.equal(result.reply, "");
  await setup.client.session.initial.streamComplete;
});

test("duplicate or unknown approval responses are rejected", async (t) => {
  const setup = await makeService();
  t.after(setup.close);
  setup.client.session.initial = new FakeDelivery(
    approvalEvents(),
    { status: "awaiting-input", outcome: "awaiting-input" },
  );
  const task = await setup.service.createTask("Ask for approval.");
  await waitFor(async () => setup.service.state().then((state) => state.tasks[0]?.status === "waiting"));

  await assert.rejects(
    setup.service.respond(task.id, "wrong-interaction", "approve"),
    (error: unknown) => error instanceof BridgeError && error.status === 409,
  );
  await assert.rejects(
    setup.service.respond(task.id, "interaction-1", "wrong-option"),
    (error: unknown) => error instanceof BridgeError && error.status === 409,
  );
});

test("child-task and child-session lifecycle is represented in normalized progress", async (t) => {
  const setup = await makeService();
  t.after(setup.close);
  setup.client.session.initial = new FakeDelivery([
    event("turn.started", { turnId: "turn-1" }, 1),
    event("task.started", { taskId: "child-task", name: "analyst", kind: "agent" }, 2),
    event("child.opened", {
      sessionId: "child-session",
      name: "analyst",
      owner: { taskId: "child-task" },
      stream: "/eve/v1/session/child-session/stream",
    }, 3),
    event("task.ended", { taskId: "child-task", outcome: "completed" }, 4),
    event("turn.settled", { turnId: "turn-1", outcome: "completed" }, 5),
    event("delivery.settled", { deliveryId: "initial", outcome: "handled" }, 6),
  ], { status: "completed", reply: "Done." });
  const task = await setup.service.createTask("Use the analyst.");
  await waitFor(async () => setup.service.state().then((state) => state.tasks[0]?.status === "completed"));
  const events = (await setup.service.state()).tasks[0]?.events.join(" ") ?? "";
  assert.match(events, /Started analyst child task/);
  assert.match(events, /Opened child session: analyst/);
  assert.match(events, /analyst completed/);
  assert.ok(task.id);
});

test("failed call activity preserves bounded sanitized errors without exposing other error fields or successful outputs", async (t) => {
  const setup = await makeService();
  t.after(setup.close);
  setup.client.session.initial = new FakeDelivery([
    event("turn.started", { turnId: "turn-1" }, 1),
    event("call.requested", { callId: "failed-1", capability: { name: "control_app" }, input: {} }, 2),
    event("call.settled", { callId: "failed-1", outcome: "failed", error: { message: "STALE_TARGET: changed target; token=fixture-secret", stack: "PRIVATE STACK" } }, 3),
    event("call.requested", { callId: "failed-2", capability: { name: "inspect_app" }, input: {} }, 4),
    event("call.settled", { callId: "failed-2", outcome: "failed", error: `AX_UNAVAILABLE: ${"x".repeat(3_000)}` }, 5),
    event("call.settled", { callId: "ok-1", outcome: "completed", output: "PRIVATE OUTPUT" }, 6),
    event("turn.settled", { turnId: "turn-1", outcome: "completed" }, 7),
    event("delivery.settled", { deliveryId: "initial", outcome: "handled" }, 8),
  ], { status: "completed", reply: "The tool failed safely." });
  const task = await setup.service.createTask("Inspect the fixture.");
  await waitFor(async () => (await setup.service.state()).tasks[0]?.status === "completed");
  const events = (await setup.service.state()).tasks[0]!.events;
  const text = events.join("\n");
  assert.match(text, /control_app failed\. STALE_TARGET: changed target/);
  assert.match(text, /token=\[REDACTED\]/);
  assert.match(text, /inspect_app failed\. AX_UNAVAILABLE/);
  assert.doesNotMatch(text, /fixture-secret|PRIVATE STACK|PRIVATE OUTPUT/);
  assert.ok(events.every((item) => item.length <= 2_000));
  const persisted = JSON.parse(await readFile(path.join(setup.dataDirectory, "tasks.json"), "utf8"));
  assert.deepEqual(persisted.tasks.find((item: TaskRecord) => item.id === task.id).events, events);
});

test("active sessions from a previous process are marked interrupted, not cancelled", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record: TaskRecord = {
    id: "task-1",
    title: "Recover me",
    status: "running",
    reply: "",
    createdAt: new Date().toISOString(),
    events: [],
    approvals: [],
    childTasks: {},
  };
  const firstStore = new TaskStore(directory);
  await firstStore.initialize();
  await firstStore.add(record);
  const restartedStore = new TaskStore(directory);
  await restartedStore.initialize();
  assert.equal(restartedStore.get(record.id)?.status, "interrupted");
  assert.match(restartedStore.get(record.id)?.error ?? "", /not reported as cancelled/);
});

test("interrupted sessions count against the active task limit", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-active-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  await store.initialize();
  for (let index = 0; index < 4; index++) {
    await store.add({
      id: `interrupted-task-${index}`,
      title: "Unconfirmed task",
      status: "interrupted",
      reply: "",
      createdAt: new Date(Date.now() + index).toISOString(),
      events: [],
      approvals: [],
      sessionId: `persisted-session-${index}`,
      childTasks: {},
    });
  }
  const service = await JarvisService.create({
    client: new FakeEveClient(),
    dataDirectory: directory,
    model: "test/model",
  });
  await assert.rejects(
    service.createTask("Start another task."),
    (error: unknown) => error instanceof BridgeError && error.status === 409,
  );
});

test("history pruning preserves interrupted tasks while trimming completed history", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-pruning-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  await store.initialize();
  const start = Date.UTC(2024, 0, 1);
  for (let index = 0; index < 100; index++) {
    await store.add({
      id: `completed-task-${index}`,
      title: "Completed task",
      status: "completed",
      reply: "",
      createdAt: new Date(start + index * 1_000).toISOString(),
      events: [],
      approvals: [],
      childTasks: {},
    });
  }
  await store.add({
    id: "interrupted-task",
    title: "Unconfirmed task",
    status: "interrupted",
    reply: "",
    createdAt: new Date(start - 1_000).toISOString(),
    events: [],
    approvals: [],
    sessionId: "persisted-session-id",
    childTasks: {},
  });

  assert.equal(store.values().length, 100);
  assert.ok(store.get("interrupted-task"));
  assert.equal(store.get("completed-task-0"), undefined);
});
