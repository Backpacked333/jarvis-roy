import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { writeJsonAtomically } from "../agent/lib/persistence.ts";
import { TaskStore } from "../bridge/store.ts";
import type { ConversationRecord, TaskRecord } from "../bridge/types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function conversation(): ConversationRecord {
  return { id: randomUUID(), title: "Transaction fixture", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), messages: [] };
}

function task(): TaskRecord {
  return { id: randomUUID(), title: "Transaction fixture", createdAt: new Date().toISOString(),
    status: "starting", userMessage: "A durable message", reply: "", events: [], approvals: [], childTasks: {} };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-store-transactions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failure = false;
  let barrier: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const store = new TaskStore(directory, { write: async (file, snapshot) => {
    if (failure) { failure = false; throw new Error("Injected storage failure"); }
    const activeBarrier = barrier;
    if (activeBarrier) {
      barrier = undefined;
      activeBarrier.entered.resolve();
      await activeBarrier.release.promise;
    }
    await writeJsonAtomically(file, snapshot);
  } });
  await store.initialize();
  return { store, directory, failNext: () => { failure = true; }, pauseNext: () => {
    barrier = { entered: deferred(), release: deferred() };
    return barrier;
  }, saved: async () => JSON.parse(await readFile(path.join(directory, "tasks.json"), "utf8")) as {
    tasks: TaskRecord[]; conversations: ConversationRecord[];
  } };
}

test("failed conversation creation is neither published nor included in a later successful write", async (t) => {
  const { store, directory, saved } = await fixture(t);
  const file = path.join(directory, "tasks.json");
  await rename(file, `${file}.saved`);
  await mkdir(file);
  const rejected = conversation();
  await assert.rejects(store.addConversation(rejected), /regular files/);
  assert.deepEqual(store.conversations(), []);
  await rm(file, { recursive: true });
  await rename(`${file}.saved`, file);
  const accepted = conversation();
  await store.addConversation(accepted);
  assert.deepEqual((await saved()).conversations.map((item) => item.id), [accepted.id]);
  assert.equal(store.conversation(accepted.id), accepted);
});

test("failed task creation leaves no task, transcript, or generated identity on the caller", async (t) => {
  const { store, failNext, saved } = await fixture(t);
  const rejected = task();
  failNext();
  await assert.rejects(store.add(rejected), /Injected storage failure/);
  assert.equal(rejected.conversationId, undefined);
  assert.equal(store.get(rejected.id), undefined);
  assert.deepEqual(store.conversations(), []);
  const accepted = task();
  await store.add(accepted);
  assert.equal(store.get(accepted.id), accepted);
  assert.ok(accepted.conversationId);
  assert.deepEqual((await saved()).tasks.map((item) => item.id), [accepted.id]);
});

test("failed nested updates keep live task references and transcripts at their committed values", async (t) => {
  const { store, failNext, saved } = await fixture(t);
  const record = task();
  await store.add(record);
  const thread = store.conversation(record.conversationId!)!;
  failNext();
  await assert.rejects(store.update(record.id, (draft) => {
    draft.reply = "Rejected reply";
    draft.events.push("Rejected event");
    draft.childTasks.child = { name: "Rejected child" };
    draft.error = "Rejected error";
  }), /Injected storage failure/);
  assert.equal(store.get(record.id), record);
  assert.equal(store.conversation(record.conversationId!), thread);
  assert.equal(record.reply, "");
  assert.deepEqual(record.events, []);
  assert.deepEqual(record.childTasks, {});
  assert.equal(record.error, undefined);
  assert.deepEqual(thread.messages.map((message) => message.text), ["A durable message"]);
  await store.update(record.id, (draft) => { draft.reply = "Accepted reply"; });
  assert.equal(record.reply, "Accepted reply");
  assert.equal(thread.messages[1]!.text, "Accepted reply");
  assert.equal((await saved()).tasks[0]!.error, undefined);
  assert.deepEqual((await saved()).tasks[0]!.events, []);
});

test("concurrent mutations serialize from committed state and publish only after the write barrier", async (t) => {
  const { store, pauseNext, saved } = await fixture(t);
  const record = task();
  await store.add(record);
  const barrier = pauseNext();
  const first = store.update(record.id, (draft) => {
    draft.observingDeliveries = (draft.observingDeliveries ?? 0) + 1;
    draft.events.push("First");
  });
  await barrier.entered.promise;
  let secondRan = false;
  const second = store.update(record.id, (draft) => {
    secondRan = true;
    draft.observingDeliveries = (draft.observingDeliveries ?? 0) + 1;
    draft.events.push("Second");
  });
  await Promise.resolve();
  assert.equal(secondRan, false);
  assert.equal(record.observingDeliveries, undefined);
  assert.deepEqual(record.events, []);
  assert.deepEqual((await saved()).tasks[0]!.events, []);
  barrier.release.resolve();
  await Promise.all([first, second]);
  assert.equal(record.observingDeliveries, 2);
  assert.deepEqual(record.events, ["First", "Second"]);
  assert.equal((await saved()).tasks[0]!.observingDeliveries, 2);
});

test("queued successful update does not inherit a failed candidate or callback exception", async (t) => {
  const { store, failNext, saved } = await fixture(t);
  const record = task();
  await store.add(record);
  failNext();
  const results = await Promise.allSettled([
    store.update(record.id, (draft) => { draft.events.push("Failed write"); }),
    store.update(record.id, (draft) => { draft.events.push("Failed callback"); throw new Error("Rejected mutation"); }),
    store.update(record.id, (draft) => { draft.events.push("Committed"); }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected", "fulfilled"]);
  assert.deepEqual(record.events, ["Committed"]);
  assert.deepEqual((await saved()).tasks[0]!.events, ["Committed"]);
});

test("failed session binding changes neither task nor conversation and permits a fresh valid binding", async (t) => {
  const { store, failNext, saved } = await fixture(t);
  const record = task();
  await store.add(record);
  failNext();
  await assert.rejects(store.bindSession(record.id, "failed-session"), /Injected storage failure/);
  assert.equal(record.sessionId, undefined);
  assert.equal(store.conversation(record.conversationId!)!.sessionId, undefined);
  await store.bindSession(record.id, "committed-session");
  assert.equal(record.sessionId, "committed-session");
  const snapshot = await saved();
  assert.equal(snapshot.tasks[0]!.sessionId, "committed-session");
  assert.equal(snapshot.conversations[0]!.sessionId, "committed-session");
});

test("failed migration does not publish recovered state", async (t) => {
  const { store, directory } = await fixture(t);
  const record = task();
  await store.add(record);
  const recovered = new TaskStore(directory, { write: async () => { throw new Error("Cannot save recovery"); } });
  await assert.rejects(recovered.initialize(), /Cannot save recovery/);
  assert.deepEqual(recovered.values(), []);
  assert.deepEqual(recovered.conversations(), []);
});

test("subscribers observe only committed snapshots and listener exceptions cannot reject a commit", async (t) => {
  const { store, failNext, pauseNext, saved } = await fixture(t);
  const observations: string[][] = [];
  const unsubscribe = store.subscribe(() => { observations.push(store.values().map((record) => record.reply)); });
  store.subscribe(() => { throw new Error("Broken observer"); });
  const record = task();
  const barrier = pauseNext();
  const creating = store.add(record);
  await barrier.entered.promise;
  assert.deepEqual(observations, []);
  barrier.release.resolve();
  await creating;
  assert.deepEqual(observations, [[""]]);
  failNext();
  await assert.rejects(store.update(record.id, (draft) => { draft.reply = "Rejected"; }), /Injected storage failure/);
  assert.deepEqual(observations, [[""]]);
  await store.update(record.id, (draft) => { draft.reply = "Committed"; });
  assert.deepEqual(observations, [[""], ["Committed"]]);
  assert.equal((await saved()).tasks[0]!.reply, "Committed");
  unsubscribe();
  await store.update(record.id, (draft) => { draft.reply = "After unsubscribe"; });
  assert.equal(observations.length, 2);
});
