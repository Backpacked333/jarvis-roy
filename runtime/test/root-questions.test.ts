import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BridgeError } from "../bridge/errors.ts";
import { JarvisService } from "../bridge/service.ts";
import { TaskStore } from "../bridge/store.ts";
import type { Approval, TaskRecord } from "../bridge/types.ts";
import { FakeDelivery, FakeEveClient, event } from "./helpers.ts";

const ordinary = { kind: "question", title: "Choose a label", prompt: "Which label?", allowFreeform: true,
  options: [{ id: "dark", label: "Dark" }, { id: "deny", label: "Neither" }] };
const canary = "sk-rootquestionfixtureonly000000000";
const blocked = (card: Approval) => {
  assert.equal(card.kind, "question");
  assert.equal(card.title, "Question blocked");
  assert.equal(card.allowText, false);
  assert.equal(card.reviewable, false);
  assert.deepEqual(card.options, []);
  assert.match(card.detail, /Stop the task/);
};
const status = (expected: number) => (error: unknown) => error instanceof BridgeError && error.status === expected;

async function fixture(t: TestContext, request: Record<string, unknown> = ordinary) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-root-question-"));
  const client = new FakeEveClient();
  client.session.initial = new FakeDelivery([
    event("turn.started", { turnId: "turn-1" }, 1),
    event("interaction.opened", { interactionId: "exact-question", request }, 2),
  ], { status: "awaiting-input", outcome: "awaiting-input" });
  client.session.responseDelivery = new FakeDelivery([], { status: "completed", reply: "Fixture acknowledgement" });
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture-only" });
  t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  const task = await service.createTask("Ask an inert fixture question");
  await client.session.initial.streamComplete;
  await service.waitForObservedDelivery(task.id);
  const card = (await service.state()).tasks[0].questions![0];
  return { directory, client, service, task, card };
}

for (const [name, changes, forbidden] of [
  ["prompt solicitation", { prompt: "What is your password?" }, "What is your password?"],
  ["title solicitation", { title: "Supply a recovery code" }, "Supply a recovery code"],
  ["option ID solicitation", { options: [{ id: "api_key", label: "Use this" }] }, "api_key"],
  ["option label solicitation", { options: [{ id: "use", label: "Share your seed phrase" }] }, "Share your seed phrase"],
  ["raw prompt before redaction", { prompt: canary }, canary],
  ["raw title before redaction", { title: canary }, canary],
  ["raw option ID before redaction", { options: [{ id: canary, label: "Safe label" }] }, canary],
  ["raw option label before redaction", { options: [{ id: "use", label: canary }] }, canary],
  ["prompt tail before truncation", { prompt: "Ordinary context. ".repeat(600) + "Your password?" }, "Your password?"],
  ["title tail before truncation", { title: "Ordinary context. ".repeat(40) + "Your password?" }, "Your password?"],
  ["normalized prompt", { prompt: "What is your ｐａｓｓｗｏｒｄ?" }, "ｐａｓｓｗｏｒｄ"],
  ["invisible prompt separator", { prompt: "What is your pass\u200Bword?" }, "pass\u200Bword"],
  ["redacted legacy-shaped prompt", { prompt: "[REDACTED]" }, "[REDACTED]"],
] as const) {
  test(`root question blocks ${name} before durable projection, without any response`, async (t) => {
    const f = await fixture(t, { ...ordinary, ...changes });
    blocked(f.card);
    assert.deepEqual((await f.service.state()).tasks[0].approvals, []);
    assert.deepEqual(f.service.harnessApprovals(), []);
    const persisted = await readFile(join(f.directory, "tasks.json"), "utf8");
    assert.ok(!persisted.includes(forbidden), "Rejected question data must not enter cards or event history");
    assert.ok(!JSON.stringify(await f.service.state()).includes(forbidden));
    for (const answer of [{ option: "", text: "synthetic-ordinary-looking-answer" }, { option: "dark" }, { option: "deny" }]) {
      await assert.rejects(f.service.respond(f.task.id, f.card.id, answer.option, f.card.revision, answer.text), status(409));
    }
    await assert.rejects(f.service.createTask("yes", f.task.conversationId), status(409));
    assert.deepEqual(f.client.session.responses, []);
    assert.equal(f.client.session.cancelCalls, 0, "Blocking a question must not silently cancel or deny");
  });
}

test("root question rejects sensitive prose and choice IDs without consuming the exact pending card", async (t) => {
  const f = await fixture(t);
  for (const answer of ["My password is synthetic-only-value", "My pass\u200Bword is synthetic-only-value", "My ｐａｓｓｗｏｒｄ is synthetic-only-value", "My one-time code is 000000", canary]) {
    await assert.rejects(f.service.respond(f.task.id, f.card.id, "", f.card.revision, answer), status(400));
    await assert.rejects(f.service.respond(f.task.id, f.card.id, answer, f.card.revision), status(400));
  }
  assert.deepEqual(f.client.session.responses, []);
  assert.deepEqual((await f.service.state()).tasks[0].questions![0], f.card);
  const persisted = await readFile(join(f.directory, "tasks.json"), "utf8");
  assert.ok(!persisted.includes("synthetic-only-value"));
  await f.service.respond(f.task.id, f.card.id, "", f.card.revision, "A midnight blue label");
  await f.client.session.responseDelivery.streamComplete;
  await f.service.waitForObservedDelivery(f.task.id);
  assert.deepEqual(f.client.session.responses, [[{ interactionId: f.card.id, text: "A midnight blue label" }]]);
});

test("ordinary root question choices retain exact IDs, revisions and one-shot responses", async (t) => {
  const f = await fixture(t, { ...ordinary, allowFreeform: false });
  await assert.rejects(f.service.respond(f.task.id, "wrong-card", "dark", f.card.revision), status(409));
  await assert.rejects(f.service.respond(f.task.id, f.card.id, "dark", f.card.revision! + 1), status(409));
  await f.service.respond(f.task.id, f.card.id, "dark", f.card.revision);
  await f.client.session.responseDelivery.streamComplete;
  await f.service.waitForObservedDelivery(f.task.id);
  await assert.rejects(f.service.respond(f.task.id, f.card.id, "dark", f.card.revision), status(409));
  assert.deepEqual(f.client.session.responses, [[{ interactionId: f.card.id, optionId: "dark" }]]);
});

for (const detail of ["What is your password?", "[REDACTED]"]) {
  test(`recovered terminal root questions are inert and cannot forward responses: ${detail}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-root-question-recovery-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new TaskStore(directory);
    await store.initialize();
    const legacy: TaskRecord = { id: "legacy-task", title: "Historical task", status: "completed", reply: "", createdAt: new Date().toISOString(),
      events: [], childTasks: {}, approvals: [{ id: "legacy-question", kind: "question", title: "Choose", detail,
        options: [{ id: "deny", label: "Neither" }], allowText: true, revision: 1 }] };
    await store.add(legacy);
    const client = new FakeEveClient();
    const service = await JarvisService.create({ client, dataDirectory: directory });
    const state = await service.state(), card = state.tasks[0].questions![0];
    blocked(card);
    assert.ok(!JSON.stringify(state).includes(detail));
    for (const option of ["", "deny"]) {
      await assert.rejects(service.respond(legacy.id, card.id, option, 1, option ? undefined : "synthetic-answer"),
        (error: unknown) => error instanceof BridgeError && error.status === 409 && /non-sensitive clarification/.test(error.message));
    }
    assert.deepEqual(client.session.responses, []);
    assert.ok((await readFile(join(directory, "tasks.json"), "utf8")).includes(detail), "Projection is not secure erasure of historical data");
  });
}

test("blocked-question policy does not remove explicit denial of unreviewable approvals", async (t) => {
  const f = await fixture(t, { kind: "approval", title: "Save password?", prompt: "Inspect this action", options: ordinary.options });
  const approval = (await f.service.state()).tasks[0].approvals[0];
  assert.equal(approval.kind, "approval");
  assert.equal(approval.reviewable, false);
  assert.deepEqual(approval.options, [{ id: "deny", label: "Neither" }]);
  await assert.rejects(f.service.respond(f.task.id, approval.id, "dark", approval.revision), status(409));
  await f.service.respond(f.task.id, approval.id, "deny", approval.revision);
  await f.client.session.responseDelivery.streamComplete;
  await f.service.waitForObservedDelivery(f.task.id);
  assert.deepEqual(f.client.session.responses, [[{ interactionId: approval.id, optionId: "deny" }]]);
});

test("normal chat may discuss credential safety without becoming a question-card response", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-normal-chat-"));
  const client = new FakeEveClient();
  client.session.initial = new FakeDelivery([], { status: "completed", reply: "Use a password manager." });
  const service = await JarvisService.create({ client, dataDirectory: directory });
  t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  let received = "";
  client.sessions.create = async ({ message }) => {
    received = message;
    return { session: client.session, delivery: client.session.initial };
  };
  const chat = await service.createTask("How do password managers work?");
  await client.session.initial.streamComplete;
  await service.waitForObservedDelivery(chat.id);
  assert.equal(received, "How do password managers work?");
  assert.equal((await service.state()).tasks.find((task) => task.id === chat.id)?.reply, "Use a password manager.");
});
