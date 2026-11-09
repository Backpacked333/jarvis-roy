import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import { TaskStore } from "../bridge/store.ts";
import type { TaskRecord } from "../bridge/types.ts";
import { approvalEvents, completedEvents, FakeDelivery, FakeEveClient } from "./helpers.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "Task lifecycle deadline"); await delay(5); }
}

test("shutdown drains every delivery of a completed task before closing projections", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-shutdown-drain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeEveClient();
  // The original stream remains open while the response delivery settles the task.
  // The old per-task observer lookup then points only at the newer delivery.
  client.session.initial = new FakeDelivery(approvalEvents());
  client.session.responseDelivery = new FakeDelivery(completedEvents(), { status: "completed", reply: "Preference saved." });
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  let closed = false, persistedAtClose: { tasks: Array<{ observingDeliveries: number }> } | undefined;
  const server = createBridgeServer(service, "127.0.0.1", 0, undefined, { stopTimeoutMs: 1_000, extensions: {
    async close() { persistedAtClose = JSON.parse(await readFile(join(directory, "tasks.json"), "utf8")); closed = true; },
  } });
  await once(server, "listening");
  t.after(() => shutdownBridge(server));
  const task = await service.createTask("Save my preference", undefined, "project-lifecycle");
  assert.equal(service.hasUnsettledProjectWork("project-lifecycle"), true);
  assert.equal(service.hasUnsettledProjectWork("other-project"), false);
  await until(() => service.taskSnapshot()[0]?.status === "waiting");
  await service.respond(task.id, "interaction-1", "approve");
  await until(() => service.taskSnapshot()[0]?.status === "completed");
  assert.equal(service.hasUnsettledProjectWork("project-lifecycle"), true, "A completed status cannot hide a still-open delivery");
  await assert.rejects(service.createTask("Follow up before the old stream closes", task.conversationId),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
  const shutdown = shutdownBridge(server);
  try {
    await delay(30);
    assert.equal(closed, false, "Projection storage must stay open for the older stream's final commit");
  } finally {
    client.session.initial.finish({ status: "completed", reply: "Preference saved." });
    await shutdown;
  }
  assert.equal(closed, true);
  assert.equal(persistedAtClose!.tasks[0].observingDeliveries, 0);
  assert.equal(service.hasUnsettledProjectWork("project-lifecycle"), false);
});

test("drain includes session creation, durable binding and the initial observation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-session-drain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeEveClient(), gate = deferred();
  const create = client.sessions.create;
  client.sessions.create = async input => { await gate.promise; return create(input); };
  client.session.initial = new FakeDelivery([], { status: "completed", reply: "Finished after binding" });
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  await service.createTask("Wait for session creation");
  let drained = false;
  const drain = service.drain().then(() => { drained = true; });
  try { await delay(30); assert.equal(drained, false); }
  finally { gate.resolve(); await drain; }
  const persisted = JSON.parse(await readFile(join(directory, "tasks.json"), "utf8"));
  assert.equal(persisted.tasks[0].sessionId, client.session.id);
  assert.equal(persisted.tasks[0].status, "completed");
  assert.equal(persisted.tasks[0].observingDeliveries, 0);
});

test("Eve callbacks follow persisted admission order when timestamps tie or the clock moves backward", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-context-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory); await store.initialize();
  const conversationId = randomUUID();
  function task(createdAt: string): TaskRecord {
    return { id: randomUUID(), conversationId, projectId: "project-context", sessionId: "same-eve-session",
      title: "Completed turn", userMessage: "Message", createdAt, status: "completed", reply: "Done", events: [], approvals: [], childTasks: {} };
  }
  await store.add(task("2026-11-08T10:00:00.000Z"));
  const tied = task("2026-11-08T10:00:00.000Z"); await store.add(tied);
  let service = await JarvisService.create({ client: new FakeEveClient(), dataDirectory: directory });
  assert.equal(service.contextForEveSession("same-eve-session")!.taskId, tied.id);
  const afterRollback = task("2026-11-08T09:00:00.000Z"); await store.add(afterRollback);
  service = await JarvisService.create({ client: new FakeEveClient(), dataDirectory: directory });
  assert.deepEqual(service.contextForEveSession("same-eve-session"), {
    taskId: afterRollback.id, conversationId, projectId: "project-context",
  });
});
