import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HarnessStateSchema, type HarnessState, type QuestionRouterOptions } from "../bridge/harness-contracts/service.ts";
import { assertAnswerMatches, questionBinding, type Question, type AnswerQuestionRequest } from "../bridge/harness-contracts/interactions.ts";
import { createQuestionRouter, createSpokenQuestionQueue, normalizeVoiceAnswer, inspectEveInteraction, createEveConversationGate } from "../bridge/harness-interactions/index.ts";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/harness-v1.json", import.meta.url), "utf8"));
const now = new Date("2026-11-06T18:00:00.000Z");
function state(): HarnessState { return HarnessStateSchema.parse(structuredClone(fixture.state)); }
function authorQuestion(data: HarnessState): Question {
  const question: Question = structuredClone(fixture.authoringQuestion);
  if (question.target.scope !== "authoring") assert.fail();
  data.authorings.push({ id: question.target.authoringId, roomId: question.target.roomId, requestId: "author-request", revision: 1,
    policyRevision: data.rooms[0].policy.revision, goal: "Describe the goal", status: "waiting_question", planId: null,
    usage: { steps: 1, modelCalls: 1, inputTokens: 100, outputTokens: 50, reservedTokens: 0, accounting: "measured", estimatedUsd: null },
    createdAt: question.createdAt, updatedAt: question.createdAt, error: null });
  data.questions.push(question); return question;
}
function service(data: HarnessState): QuestionRouterOptions["harness"] & { received: AnswerQuestionRequest[] } {
  const received: AnswerQuestionRequest[] = [];
  return {
    received,
    async state() { return structuredClone(data); },
    async answerQuestion(input) {
      const current = data.questions.find((question) => question.id === input.binding.questionId)!;
      assertAnswerMatches(current, input, now);
      received.push(input);
      current.status = "answered";
      current.revision++;
      current.answer = { text: input.text, choiceId: input.choiceId, answeredAt: now.toISOString() };
      return structuredClone(current);
    },
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

test("attention prioritizes blocked workers then authorings and deduplicates state replay", async () => {
  const data = state(); const authored = authorQuestion(data);
  data.questions.push(structuredClone(data.questions[0]));
  const router = createQuestionRouter({ harness: service(data), now: () => now });
  const attention = await router.attention();
  assert.equal(attention.length, 2); assert.equal(attention[0].target.scope, "node"); assert.equal(attention[1].id, authored.id);
  assert.deepEqual(await router.attention(), attention);
});

test("quiet rooms retain authoritative inbox questions but are excluded from spoken attention", async () => {
  const data = state(); data.rooms[0].policy.attention = "quiet";
  const harness = service(data); const router = createQuestionRouter({ harness, now: () => now });
  assert.deepEqual(await router.attention(), []);
  assert.equal((await harness.state()).questions.length, 1);
  const answered = await router.answerVoice({ binding: questionBinding(data.questions[0]), transcript: "dark" });
  assert.equal(answered.status, "answered");
});

test("expired, terminal, orphaned and previous-attempt questions are never attention targets", async () => {
  for (const mutate of [
    (v: HarnessState) => { v.questions[0].expiresAt = now.toISOString(); },
    (v: HarnessState) => { v.questions[0].status = "answered"; },
    (v: HarnessState) => { v.rooms[0].status = "archived"; },
    (v: HarnessState) => { v.runs[0].status = "cancel_requested"; },
    (v: HarnessState) => { v.runs[0].nodes.find((n) => n.status === "waiting_question")!.attemptId = "next-attempt"; },
    (v: HarnessState) => { v.questions[0].target.roomId = "other"; },
  ]) {
    const data = state(); mutate(data); const harness = service(data);
    const router = createQuestionRouter({ harness, now: () => now });
    assert.deepEqual(await router.attention(), []);
    await assert.rejects(router.answerVoice({ binding: questionBinding(data.questions[0]), transcript: "dark" }));
    assert.equal(harness.received.length, 0);
  }
});

test("conflicting duplicates are ambiguous and fail closed", async () => {
  const data = state(); const duplicate = structuredClone(data.questions[0]); duplicate.revision++;
  data.questions.push(duplicate);
  const router = createQuestionRouter({ harness: service(data), now: () => now });
  assert.deepEqual(await router.attention(), []);
  await assert.rejects(router.answerVoice({ binding: questionBinding(data.questions[0]), transcript: "dark" }));
});

test("captured room/run/node/attempt/question/revision binding is never retargeted", async () => {
  const data = state(); const harness = service(data); const router = createQuestionRouter({ harness, now: () => now });
  const question = data.questions[0];
  for (const key of ["roomId", "runId", "nodeId", "attemptId"] as const) {
    const binding = structuredClone(questionBinding(question));
    if (binding.target.scope !== "node") assert.fail();
    binding.target[key] = "other";
    await assert.rejects(router.answerVoice({ binding, transcript: "dark" }), /cross-scope/);
  }
  for (const binding of [{ ...questionBinding(question), revision: 999 }, { ...questionBinding(question), questionId: "other" }]) {
    await assert.rejects(router.answerVoice({ binding, transcript: "dark" }));
  }
  assert.equal(harness.received.length, 0);
  const captured = questionBinding(question);
  data.rooms.unshift({ ...structuredClone(data.rooms[0]), id: "newly-selected-room" });
  await router.answerVoice({ binding: captured, transcript: " DaRK " });
  assert.deepEqual(harness.received[0].binding, captured);
});

test("authoring answer is exact and cannot be routed to another authoring", async () => {
  const data = state(); const question = authorQuestion(data); const harness = service(data);
  const router = createQuestionRouter({ harness, now: () => now });
  const wrong = questionBinding(question);
  if (wrong.target.scope !== "authoring") assert.fail(); wrong.target.authoringId = "another-authoring";
  await assert.rejects(router.answerVoice({ binding: wrong, transcript: "A local notes utility" }));
  const answer = await router.answerVoice({ binding: questionBinding(question), transcript: "A local notes utility" });
  assert.equal(answer.answer?.text, "A local notes utility"); assert.equal(harness.received[0].source, "voice");
});

test("exact labels/IDs may normalize casing/spacing; fuzzy yes, punctuation and multiple choices are never guessed", () => {
  const question = state().questions[0]; question.question.allowText = false;
  const binding = questionBinding(question);
  for (const transcript of ["yes", "dark please", "dark.", "dark or light", "approve"]) {
    assert.throws(() => normalizeVoiceAnswer(question, { binding, transcript }, now), /exact choice/);
  }
  assert.equal(normalizeVoiceAnswer(question, { binding, transcript: "  DARK  " }, now).choiceId, "dark");
});

test("choice ID/label collisions never pick the first and free text stays text", () => {
  const question = state().questions[0]; question.question = { prompt: "Which?", allowText: true,
    choices: [{ id: "one", label: "Alpha" }, { id: "alpha", label: "Beta" }] };
  const binding = questionBinding(question);
  assert.throws(() => normalizeVoiceAnswer(question, { binding, transcript: "alpha" }, now), /Ambiguous/);
  const response = normalizeVoiceAnswer(question, { binding, transcript: "A different format" }, now);
  assert.equal(response.text, "A different format"); assert.equal(response.choiceId, null);
});

test("spoken yes can answer only a structurally valid clarification, never an approval or optionId", async () => {
  const data = state(); const question = data.questions[0]; question.question = { prompt: "Use headings?", allowText: false, choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };
  const harness = service(data); const router = createQuestionRouter({ harness, now: () => now });
  const approvalId = data.approvals[0].id;
  await assert.rejects(router.answerVoice({ binding: { ...questionBinding(question), questionId: approvalId }, transcript: "yes" }), /approvals/);
  assert.throws(() => normalizeVoiceAnswer({ ...question, kind: "approval" } as unknown as Question, { binding: questionBinding(question), transcript: "yes" }, now));
  await assert.rejects(router.answerVoice({ binding: questionBinding(question), transcript: "yes", optionId: "approve" } as any));
  await router.answerVoice({ binding: questionBinding(question), transcript: "yes" });
  assert.equal(harness.received[0].choiceId, "yes"); assert.equal("optionId" in harness.received[0], false);
  assert.equal(data.approvals[0].status, "pending");
});

test("parallel duplicate speech submits once while stale repeats fail after kernel confirmation", async () => {
  const data = state(); const stored = service(data); const latch = deferred<void>();
  const harness = { state: stored.state, async answerQuestion(input: AnswerQuestionRequest) { await latch.promise; return stored.answerQuestion(input); } };
  const router = createQuestionRouter({ harness, now: () => now });
  const input = { binding: questionBinding(data.questions[0]), transcript: "dark" };
  const first = router.answerVoice(input);
  await assert.rejects(router.answerVoice(input), /already being submitted/);
  latch.resolve(); await first;
  await assert.rejects(router.answerVoice(input), /pending/);
  assert.equal(stored.received.length, 1);
});

test("race between snapshot and another consumer is rejected by kernel, not silently sent to next question", async () => {
  const data = state(); const stored = service(data); const input = { binding: questionBinding(data.questions[0]), transcript: "dark" };
  const router = createQuestionRouter({ now: () => now, harness: { state: stored.state, async answerQuestion(answer) {
    data.questions[0].status = "cancelled";
    return stored.answerQuestion(answer);
  } } });
  await assert.rejects(router.answerVoice(input), /pending/);
  assert.equal(stored.received.length, 0);
});

test("submission failure releases only transient lock and leaves authoritative question pending", async () => {
  const data = state(); const stored = service(data); let fail = true;
  const router = createQuestionRouter({ now: () => now, harness: { state: stored.state, async answerQuestion(answer) {
    if (fail) { fail = false; throw new Error("storage unavailable"); } return stored.answerQuestion(answer);
  } } });
  const input = { binding: questionBinding(data.questions[0]), transcript: "dark" };
  await assert.rejects(router.answerVoice(input), /storage unavailable/);
  assert.equal(data.questions[0].status, "pending"); await router.answerVoice(input);
  assert.equal(stored.received.length, 1);
});

test("spoken queue speaks only one exact binding, suppresses refresh duplicates, ignores stale release", () => {
  const data = state(); const authored = authorQuestion(data); const node = data.questions[0];
  const queue = createSpokenQuestionQueue();
  const next = queue.next([node, authored]); assert.equal(next?.id, node.id);
  const captured = queue.capturedBinding()!; captured.target.roomId = "mutated";
  assert.notEqual(queue.capturedBinding()?.target.roomId, "mutated");
  assert.equal(queue.next([authored, node]), null);
  queue.release(questionBinding(authored)); assert.equal(queue.next([node, authored]), null);
  queue.release(questionBinding(node)); assert.equal(queue.next([node, authored])?.id, authored.id);
  queue.release(questionBinding(authored)); assert.equal(queue.next([node, authored]), null);
  assert.equal(queue.next([]), null); assert.equal(queue.capturedBinding(), null);
});

test("quiet/expired/answered attention removal releases active speech context without retargeting", () => {
  const data = state(); const authored = authorQuestion(data); const queue = createSpokenQuestionQueue();
  queue.next([data.questions[0], authored]); const old = queue.capturedBinding()!;
  assert.equal(queue.next([authored])?.id, authored.id);
  queue.release(old); assert.equal(queue.capturedBinding()?.questionId, authored.id);
});

test("Eve interaction kind and exact ID survive; unknown kinds do not become approvals", () => {
  for (const kind of ["approval", "question", "sign-in", "budget", "future-kind"]) {
    assert.deepEqual(inspectEveInteraction({ interactionId: "exact-eve-id", request: { kind, title: "Approve?" } }),
      { interactionId: "exact-eve-id", kind: kind === "approval" || kind === "question" ? kind : "other" });
  }
  assert.throws(() => inspectEveInteraction({ id: "guessed", request: { kind: "approval" } }));
});

test("Eve ambient yes/text never reaches send while ANY prompt is waiting, including unknown kinds", async () => {
  for (const kind of ["approval", "question", "budget", "sign-in", "future-kind"]) {
    const gate = createEveConversationGate({ async inspect() { return { idle: true, interactions: [{ interactionId: "exact", request: { kind } }] }; },
      async send() { assert.fail("ambient text must not answer an Eve prompt"); } });
    await assert.rejects(gate.send("session-a", "yes"), /exact question or approval/);
  }
});

test("Eve gate rejects concurrent/busy-session sends and allows independent idle sessions", async () => {
  const latch = deferred<void>(); const sent: string[] = [];
  const gate = createEveConversationGate({ async inspect(id) { if (id === "session-a") await latch.promise; return { idle: id !== "busy", interactions: [] }; },
    async send(id, text) { sent.push(id); return text; } });
  const first = gate.send("session-a", "goal");
  await assert.rejects(gate.send("session-a", "yes"), /busy/);
  await assert.rejects(gate.send("busy", "goal"), /busy/);
  assert.equal(await gate.send("session-b", "independent"), "independent");
  latch.resolve(); assert.equal(await first, "goal"); assert.deepEqual(sent, ["session-b", "session-a"]);
});

test("worker-origin secret questions are not spoken and credential-shaped voice answers are not persisted", async () => {
  const data = state(); const question = data.questions[0]; const harness = service(data);
  const router = createQuestionRouter({ harness, now: () => now });
  question.question = { prompt: "What is your API key?", choices: [], allowText: true };
  assert.deepEqual(await router.attention(), []);
  await assert.rejects(router.answerVoice({ binding: questionBinding(question), transcript: "no" }));
  question.question.prompt = "What file format?";
  await assert.rejects(router.answerVoice({ binding: questionBinding(question), transcript: "api_key=not-a-real-fixture-value" }), /Secrets/);
  assert.equal(harness.received.length, 0); assert.equal(question.status, "pending");
});
