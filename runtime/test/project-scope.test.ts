import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { TaskStore } from "../bridge/store.ts";
import { JarvisService } from "../bridge/service.ts";
import type { ConversationRecord, EveClient, EveSession, TaskRecord } from "../bridge/types.ts";
import { FakeDelivery } from "./helpers.ts";

const at = new Date(1_700_000_000_000).toISOString();
function conversation(): ConversationRecord {
  return { id: randomUUID(), title: "Scope fixture", createdAt: at, updatedAt: at, messages: [] };
}
function task(conversationId: string, projectId?: string, sequence = 0): TaskRecord {
  return { id: randomUUID(), conversationId, ...(projectId ? { projectId } : {}), title: "Scope fixture",
    userMessage: "Fixture message", status: "completed", reply: "Fixture reply",
    createdAt: new Date(1_700_000_000_000 + sequence).toISOString(), events: [], approvals: [], childTasks: {} };
}
async function directory(t: TestContext) {
  const value = await mkdtemp(path.join(tmpdir(), "jarvis-project-scope-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("retention and restart preserve project binding after a conversation loses all tasks", async t => {
  const root = await directory(t), store = new TaskStore(root);
  await store.initialize();
  const old = conversation(), other = conversation();
  const initial = { ...task(old.id, "project-original"), sessionId: "original-eve-session" };
  await store.add(initial);
  for (let index = 1; index <= 100; index++) await store.add(task(other.id, "project-other", index));
  assert.equal(store.values().filter(record => record.conversationId === old.id).length, 0);
  assert.equal(store.conversation(old.id)?.projectId, "project-original");
  const saved = JSON.parse(await readFile(path.join(root, "tasks.json"), "utf8"));
  assert.equal(saved.conversations.find((record: ConversationRecord) => record.id === old.id).projectId, "project-original");

  const attached: string[] = [];
  const session: EveSession = { id: "original-eve-session", async send() {
    return new FakeDelivery([], { status: "completed", outcome: "handled", reply: "Follow-up" });
  }, async respond() { throw new Error("No approval pending"); }, async cancel() { throw new Error("No cancellation pending"); } };
  const client: EveClient = { health: async () => ({ status: "ready" }), sessions: {
    async create() { throw new Error("Must preserve the original session"); },
    attach(id) { attached.push(id); return session; },
  } };
  const service = await JarvisService.create({ dataDirectory: root, client });
  await assert.rejects(service.createTask("Different private project", old.id, "project-new"), /cannot change.*project scope/);
  assert.deepEqual(attached, []);
  const followup = await service.createTask("Continue in original scope", old.id);
  await service.drain();
  assert.equal(service.contextForEveSession(session.id)?.projectId, "project-original");
  assert.equal(service.taskSnapshot().find(record => record.id === followup.id)?.status, "completed");
  assert.deepEqual(attached, [session.id]);
});

test("first task binds an unused conversation once and later omitted scopes inherit it", async t => {
  const store = new TaskStore(await directory(t)); await store.initialize();
  const thread = conversation(); await store.addConversation(thread);
  assert.equal(thread.projectId, undefined);
  await store.add(task(thread.id, "selected-project"));
  assert.equal(thread.projectId, "selected-project");
  const followup = task(thread.id); await store.add(followup);
  assert.equal(followup.projectId, "selected-project");
  await assert.rejects(store.add(task(thread.id, "other-project")), /cannot change.*project scope/);
  await assert.rejects(store.update(followup.id, record => { record.projectId = "other-project"; }), /cannot change.*project scope/);
  assert.equal(store.get(followup.id)?.projectId, "selected-project");
});

test("legacy migration recovers an explicit task scope independent of task order", async t => {
  const root = await directory(t), thread = conversation();
  const unscoped = task(thread.id), scoped = task(thread.id, "recovered-project", 1);
  await writeFile(path.join(root, "tasks.json"), JSON.stringify({ version: 2, conversations: [thread], tasks: [unscoped, scoped] }));
  const store = new TaskStore(root); await store.initialize();
  assert.equal(store.conversation(thread.id)?.projectId, "recovered-project");
  assert.ok(store.values().every(record => record.projectId === "recovered-project"));
  const reloaded = new TaskStore(root); await reloaded.initialize();
  assert.equal(reloaded.conversation(thread.id)?.projectId, "recovered-project");
});

test("legacy session without a surviving scoped task defaults permanently to its conversation ID", async t => {
  const root = await directory(t), thread = { ...conversation(), sessionId: "legacy-session" };
  await writeFile(path.join(root, "tasks.json"), JSON.stringify({ version: 2, conversations: [thread], tasks: [] }));
  const store = new TaskStore(root); await store.initialize();
  assert.equal(store.conversation(thread.id)?.projectId, thread.id);
  await assert.rejects(store.add(task(thread.id, "different-project")), /cannot change.*project scope/);
  const followup = task(thread.id); await store.add(followup);
  assert.equal(followup.projectId, thread.id);
});

test("conflicting persisted project scopes fail migration without rewriting history", async t => {
  const root = await directory(t);
  const cases = [
    { thread: conversation(), scopes: ["project-a", "project-b"] },
    { thread: { ...conversation(), projectId: "conversation-project" }, scopes: ["different-task-project"] },
  ];
  for (const { thread, scopes } of cases) {
    const file = path.join(root, "tasks.json");
    const original = JSON.stringify({ version: 2, conversations: [thread], tasks: scopes.map((scope, index) => task(thread.id, scope, index)) });
    await writeFile(file, original);
    const store = new TaskStore(root);
    await assert.rejects(store.initialize(), /inconsistent private project scopes/);
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(store.conversations(), []);
    assert.deepEqual(store.values(), []);
  }
});
