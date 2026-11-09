import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudConversationRuntime, type CloudConversationOptions } from "../bridge/cloud-conversation-runtime.ts";
import { OutboxInputSchema, type InboundTelegram } from "../bridge/integrations/contracts.ts";

const at = "2026-11-09T12:00:00.000Z", expiresAt = "2026-11-09T12:05:00.000Z";
const message = (updateId: number, text: string, question: InboundTelegram["question"] = null): InboundTelegram => ({ updateId, text, messageId: updateId, chatId: "123", question });
const task = (id: string, conversationId: string, patch: Record<string, unknown> = {}) => ({ id, conversationId, projectId: "project", status: "running", reply: "", createdAt: at, approvals: [], questions: [], ...patch });
const clarification = { id: "question", kind: "question", revision: 2, expiresAt, reviewable: true, allowText: false, title: "Which format?", detail: "Choose the output format.", options: [{ id: "pdf", label: "PDF" }, { id: "markdown", label: "Markdown" }] };
function fixture() {
  const cursors = new Map<string, unknown>(), outbox: ReturnType<typeof OutboxInputSchema.parse>[] = [], tasks = new Map<string, ReturnType<typeof task>>();
  const calls: { operation: string; payload: any }[] = [], proposals: unknown[] = [];
  let sequence = 0, conv = 0, stopped = false, disclose = false, verified = true, liveProject = "project", liveSid = "call", postError = false;
  let afterPost: (() => void) | undefined;
  const integrations = { readCursor<T>(name: string): T | undefined { return structuredClone(cursors.get(name)) as T | undefined; },
    writeCursor(name: string, value: unknown) { cursors.set(name, structuredClone(value)); }, status: () => ({ stopped }),
    async verifiedCall(callSid: string) { return verified ? { callSid: liveSid, projectId: liveProject, status: "in_progress" as const } : null; },
    telegram: { paired: () => true, outbox: () => structuredClone(outbox), enqueue(raw: unknown) {
      const item = OutboxInputSchema.parse(raw), existing = outbox.find(value => value.id === item.id);
      if (existing) assert.deepEqual(item, existing); else outbox.push(item); return item;
    } },
  };
  const options: CloudConversationOptions = { origin: "https://jarvis.example", projectId: "project", telegramDestination: "123", phoneDestination: "+15555550100", now: () => new Date(at), phoneWaitMs: 20,
    integrations: () => integrations, control: { authorizeDisclosure: () => disclose, async createActionProposal(raw) { proposals.push(raw); return {}; } },
    async rpc(operation, raw) {
      const payload = raw as any; calls.push({ operation, payload });
      if (operation === "conversations") return { id: `conversation-${++conv}` };
      if (operation === "tasks" && payload.method === "POST") {
        if (postError) throw new Error("Transport lost after possible admission");
        const value = task(`task-${++sequence}`, payload.conversationId); tasks.set(value.id, value); afterPost?.(); return structuredClone(value);
      }
      if (operation === "tasks") { const value = tasks.get(payload.id); if (!value) throw new Error("Task absent"); return structuredClone(value); }
      if (operation === "respond_question") { const value = tasks.get(payload.taskId)!; value.status = "running"; value.questions = []; return value; }
      throw new Error(`Unexpected operation ${operation}`);
    } };
  return { options, runtime: createCloudConversationRuntime(options), cursors, outbox, tasks, calls, proposals,
    details(value: boolean) { disclose = value; }, verified(value: boolean) { verified = value; }, project(value: string) { liveProject = value; }, sid(value: string) { liveSid = value; },
    stopped(value: boolean) { stopped = value; }, failPosts(value: boolean) { postError = value; }, onPost(value: () => void) { afterPost = value; },
    posts: () => calls.filter(call => call.operation === "tasks" && call.payload.method === "POST"), state: () => [...cursors.values()][0] as any };
}

test("Telegram normal chat persists scoped conversations, opens side conversations while busy, and never replays a request after restart", async () => {
  const f = fixture(); await f.runtime.onTelegramMessage(message(1, "Research fatigue"));
  const first = f.posts()[0]; assert.equal(first.payload.projectId, "project");
  await f.runtime.onTelegramMessage(message(2, "Discuss tomorrow while that runs"));
  assert.notEqual(f.posts()[1].payload.conversationId, first.payload.conversationId);
  assert.equal(f.posts().length, 2);
  const restarted = createCloudConversationRuntime(f.options);
  await restarted.onTelegramMessage(message(2, "Discuss tomorrow while that runs")); assert.equal(f.posts().length, 2);
  await restarted.onTelegramMessage(message(3, "/new")); assert.equal(f.posts().length, 2);
  assert.equal(f.outbox.every(item => item.disclosure === "minimal"), true);
  await assert.rejects(restarted.onTelegramMessage({ ...message(4, "foreign chat"), chatId: "999" }), /Paired/);
});
test("uncertain task POST is durable and is not automatically retried; newer input uses a different conversation", async () => {
  const f = fixture(); f.failPosts(true); await f.runtime.onTelegramMessage(message(1, "Start research"));
  assert.equal(f.state().entries[0].phase, "unknown"); assert(f.outbox[0].text.includes("not automatically retried"));
  f.failPosts(false); const restarted = createCloudConversationRuntime(f.options);
  await restarted.onTelegramMessage(message(1, "Start research")); assert.equal(f.posts().length, 1);
  await restarted.onTelegramMessage(message(2, "A separate request")); assert.equal(f.posts().length, 2);
  assert.notEqual(f.posts()[0].payload.conversationId, f.posts()[1].payload.conversationId);
});
test("bound question replies require exact live project, revision and option, with no approval execution route", async () => {
  const f = fixture(); await f.runtime.onTelegramMessage(message(1, "Draft a brief"));
  const current = f.tasks.get("task-1")!; current.status = "waiting"; current.questions = [clarification] as never[];
  const bound = { kind: "task" as const, projectId: "project", taskId: current.id, questionId: "question", revision: 2, expiresAt };
  await f.runtime.onTelegramMessage(message(2, "pdf", { ...bound, revision: 1 }));
  await f.runtime.onTelegramMessage(message(3, "yes", bound));
  assert.equal(f.calls.filter(call => call.operation === "respond_question").length, 0);
  await f.runtime.onTelegramMessage(message(4, "PDF", bound));
  assert.deepEqual(f.calls.find(call => call.operation === "respond_question")!.payload, { taskId: "task-1", interactionId: "question", expectedRevision: 2, optionId: "pdf" });
  await createCloudConversationRuntime(f.options).onTelegramMessage(message(4, "PDF", bound));
  assert.equal(f.calls.filter(call => call.operation === "respond_question").length, 1);
  current.questions = [{ ...clarification, kind: "approval" }] as never[];
  await f.runtime.onTelegramMessage(message(5, "PDF", bound)); assert.equal(f.calls.filter(call => call.operation === "respond_question").length, 1);
  assert.equal(f.calls.some(call => call.operation.includes("execute")), false);
});
test("pending questions and results use stable outbox identities; detail requires disclosure and approvals use existing proposal authority", async () => {
  const f = fixture(); await f.runtime.onTelegramMessage(message(1, "Prepare evidence"));
  const current = f.tasks.get("task-1")!; current.status = "waiting"; current.questions = [clarification] as never[];
  current.approvals = [{ ...clarification, id: "action", kind: "approval", options: [{ id: "approve", label: "Approve" }] }] as never[];
  await f.runtime.notifyPending(); const count = f.outbox.length; await f.runtime.notifyPending(); assert.equal(f.outbox.length, count);
  assert.deepEqual(f.proposals[0], { projectId: "project", deviceId: "cloud-runtime", ref: { taskId: "task-1", interactionId: "action", revision: 2, optionId: "approve" } });
  assert.equal(f.outbox.at(-1)!.disclosure, "minimal"); assert(!f.outbox.at(-1)!.text.includes("Which format"));
  await f.runtime.onTelegramMessage(message(2, "yes")); assert.equal(f.posts().length, 1);
  f.details(true); current.status = "completed"; current.reply = "PRIVATE research answer"; current.approvals = []; current.questions = [];
  await f.runtime.notifyPending(); assert.equal(f.outbox.at(-1)!.disclosure, "project_details"); assert(f.outbox.at(-1)!.text.includes("PRIVATE"));
  const terminalCount = f.outbox.length; await createCloudConversationRuntime(f.options).notifyPending(); assert.equal(f.outbox.length, terminalCount);
});
test("verified phone requires exact live call, project and disclosure before admission and before returning private text", async () => {
  const f = fixture(), input = { callSid: "call", projectId: "project", objectiveId: null, text: "Explain the result" };
  assert.equal(await f.runtime.onVerifiedCallTranscript(input), null); assert.equal(f.posts().length, 0);
  f.details(true); f.verified(false); assert.equal(await f.runtime.onVerifiedCallTranscript(input), null);
  f.verified(true); f.sid("different"); assert.equal(await f.runtime.onVerifiedCallTranscript(input), null);
  f.sid("call"); f.project("foreign"); assert.equal(await f.runtime.onVerifiedCallTranscript(input), null);
  f.project("project"); f.onPost(() => { const current = f.tasks.get("task-1")!; current.status = "completed"; current.reply = "PRIVATE phone answer"; f.details(false); });
  assert.equal(await f.runtime.onVerifiedCallTranscript(input), null);
  assert.equal(f.posts().length, 1);
});
test("phone returns concise completed answers or bounded background status; generic agreement never submits an approval", async () => {
  const f = fixture(); f.details(true);
  assert.match((await f.runtime.onVerifiedCallTranscript({ callSid: "call", projectId: "project", objectiveId: null, text: "yes" }))!, /cannot authorize/); assert.equal(f.posts().length, 0);
  f.onPost(() => { const current = f.tasks.get("task-1")!; current.status = "completed"; current.reply = "A verified-channel answer."; });
  assert.equal(await f.runtime.onVerifiedCallTranscript({ callSid: "call", projectId: "project", objectiveId: null, text: "Explain this" }), "A verified-channel answer.");
  f.onPost(() => {}); const started = Date.now();
  assert.match((await f.runtime.onVerifiedCallTranscript({ callSid: "call", projectId: "project", objectiveId: null, text: "Keep researching" }))!, /background/); assert(Date.now() - started < 500);
  assert.equal(f.calls.some(call => call.operation.includes("execute")), false);
});
test("phone call expiry during conversation admission prevents a later task POST", async () => {
  const f = fixture(); f.details(true);
  const original = f.options.rpc;
  f.options.rpc = async (operation, payload) => { const value = await original(operation, payload); if (operation === "conversations") f.verified(false); return value; };
  assert.equal(await createCloudConversationRuntime(f.options).onVerifiedCallTranscript({ callSid: "call", projectId: "project", objectiveId: null, text: "Read my project notes" }), null);
  assert.equal(f.posts().length, 0);
});
test("notification polling refuses a task that moved project and never leaks its result", async () => {
  const f = fixture(); f.details(true); await f.runtime.onTelegramMessage(message(1, "Read the selected project"));
  const current = f.tasks.get("task-1")!; current.projectId = "foreign"; current.status = "completed"; current.reply = "FOREIGN PRIVATE CONTENT";
  await f.runtime.notifyPending(); assert(!f.outbox.some(item => item.text.includes("FOREIGN")));
  assert.equal(f.state().entries[0].phase, "tracked");
});
test("read-only polling and concurrent channel submissions preserve each other's durable entries", async () => {
  const f = fixture(); f.details(true);
  await Promise.all([f.runtime.onTelegramMessage(message(1, "First Telegram turn")), f.runtime.onVerifiedCallTranscript({ callSid: "call", projectId: "project", objectiveId: null, text: "A separate phone turn" }), f.runtime.notifyPending()]);
  const entries = f.state().entries;
  assert.equal(entries.length, 2); assert.deepEqual(new Set(entries.map((item: any) => item.channel)), new Set(["telegram", "phone"]));
  assert(entries.every((item: any) => item.taskId && item.conversationId));
});
test("waiting question details honor proactive channel permission before enqueue", async () => {
  const f = fixture(); f.options.control.authorizeDisclosure = input => !input.proactive;
  const runtime = createCloudConversationRuntime(f.options); await runtime.onTelegramMessage(message(1, "Clarify output"));
  const current = f.tasks.get("task-1")!; current.status = "waiting"; current.questions = [clarification] as never[];
  await runtime.notifyPending(); const notification = f.outbox.at(-1)!;
  assert.equal(notification.kind, "question"); assert.equal(notification.disclosure, "minimal"); assert(!notification.text.includes("Choose the output"));
});
test("unresolved admission records are bounded and never pruned to admit new work", async () => {
  const f = fixture(); f.failPosts(true); await f.runtime.onTelegramMessage(message(1, "Uncertain initial request"));
  const key = [...f.cursors.keys()][0], current = f.state(), original = current.entries[0];
  current.entries = Array.from({ length: 100 }, (_, index) => ({ ...original, id: `unresolved-${index}` })); f.cursors.set(key, current);
  await f.runtime.onTelegramMessage(message(2, "This must not overflow the durable queue"));
  assert.equal(f.posts().length, 1); assert.equal(f.state().entries.length, 100);
  assert(f.state().entries.every((item: any) => item.phase === "unknown"));
});
test("late phone clarification is not bound when only the background status was spoken", async () => {
  const f = fixture(); f.details(true); f.options.phoneWaitMs = 5;
  const original = f.options.rpc;
  f.options.rpc = async (operation, payload) => {
    const value = await original(operation, payload);
    if (operation === "tasks" && (payload as any).method === "GET") { await new Promise(resolve => setTimeout(resolve, 25)); return { ...(value as object), status: "waiting", questions: [clarification] }; }
    return value;
  };
  const runtime = createCloudConversationRuntime(f.options);
  assert.match((await runtime.onVerifiedCallTranscript({ callSid: "call", projectId: "project", objectiveId: null, text: "Create a brief" }))!, /background/);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.state().phone.question, null);
});
test("a clarification read during one verified call cannot capture a later call's utterance", async () => {
  const f = fixture(); f.details(true);
  f.onPost(() => { const current = [...f.tasks.values()].at(-1)!; current.status = "waiting"; current.questions = [clarification] as never[]; });
  const first = await f.runtime.onVerifiedCallTranscript({ callSid: "call", projectId: "project", objectiveId: null, text: "Prepare a draft" });
  assert.match(first!, /Which format/); assert.equal(f.state().phone.questionCallSid, "call");
  f.sid("new-call");
  await f.runtime.onVerifiedCallTranscript({ callSid: "new-call", projectId: "project", objectiveId: null, text: "Markdown" });
  assert.equal(f.calls.filter(call => call.operation === "respond_question").length, 0);
  assert.equal(f.posts().length, 2);
});
test("an uncertain clarification response reconciles its known task read-only without replaying the response", async () => {
  const f = fixture(); await f.runtime.onTelegramMessage(message(1, "Prepare a draft"));
  const current = f.tasks.get("task-1")!; current.status = "waiting"; current.questions = [clarification] as never[];
  const original = f.options.rpc;
  f.options.rpc = async (operation, payload) => { const value = await original(operation, payload); if (operation === "respond_question") throw new Error("Lost answer response"); return value; };
  const runtime = createCloudConversationRuntime(f.options);
  await runtime.onTelegramMessage(message(2, "PDF", { kind: "task", projectId: "project", taskId: "task-1", questionId: "question", revision: 2, expiresAt }));
  assert.equal(f.state().entries.find((item: any) => item.id === "telegram-2").phase, "unknown");
  current.status = "completed"; current.reply = "The draft is ready.";
  await runtime.notifyPending(); assert.equal(f.calls.filter(call => call.operation === "respond_question").length, 1);
  assert.equal(f.state().entries.find((item: any) => item.id === "telegram-2").phase, "done");
});
