import { QuestionSchema, VoiceAnswerRequestSchema, assertAnswerMatches, questionBinding,
  type Question, type QuestionBinding, type VoiceAnswerRequest } from "../harness-contracts/interactions.ts";
import type { HarnessState, QuestionRouter, QuestionRouterOptions } from "../harness-contracts/service.ts";
import { canonicalJson } from "../harness-contracts/validation.ts";
import { BridgeError } from "../errors.ts";
import { isSafeClarification, isSafeClarificationText } from "./clarification-safety.ts";

export class QuestionRoutingError extends BridgeError {
  constructor(message: string, status = 409) { super(message, status); }
}

function liveTarget(question: Question, state: HarnessState): boolean {
  const target = question.target;
  const room = state.rooms.find((room) => room.id === target.roomId);
  if (!room || room.status === "archived") return false;
  if (target.scope === "authoring") return state.authorings.some((authoring) =>
    authoring.id === target.authoringId && authoring.roomId === target.roomId && authoring.status === "waiting_question");
  return state.runs.some((run) => run.id === target.runId && run.roomId === target.roomId &&
    ["waiting_question", "running", "paused"].includes(run.status) && run.nodes.some((node) =>
      node.nodeId === target.nodeId && node.attemptId === target.attemptId && node.status === "waiting_question"));
}

function pendingQuestions(state: HarnessState, now: Date): Question[] {
  const counts = new Map<string, number>();
  for (const question of state.questions) counts.set(question.id, (counts.get(question.id) ?? 0) + 1);
  const unique = new Map<string, Question>();
  for (const value of state.questions) {
    const result = QuestionSchema.safeParse(value);
    if (!result.success) continue;
    const question = result.data;
    if (counts.get(question.id)! > 1) {
      const entries = state.questions.filter((item) => item.id === question.id);
      if (entries.some((item) => canonicalJson(item) !== canonicalJson(question))) continue;
    }
    if (question.status === "pending" && Date.parse(question.expiresAt) > now.getTime() && liveTarget(question, state) &&
        isSafeClarification(question.question)) unique.set(question.id, question);
  }
  return [...unique.values()];
}

function normalized(value: string): string { return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"); }

export function normalizeVoiceAnswer(question: Question, input: VoiceAnswerRequest, now = new Date()) {
  question = QuestionSchema.parse(question);
  const parsed = VoiceAnswerRequestSchema.parse(input);
  if (!isSafeClarification(question.question) || !isSafeClarificationText(parsed.transcript)) {
    throw new QuestionRoutingError("Secrets cannot be requested or supplied through voice clarifications", 400);
  }
  const transcript = normalized(parsed.transcript);
  const matches = question.question.choices.filter((choice) => normalized(choice.id) === transcript || normalized(choice.label) === transcript);
  if (matches.length > 1) throw new QuestionRoutingError("Ambiguous choice; select an exact choice in the inbox");
  if (matches.length === 0 && !question.question.allowText) throw new QuestionRoutingError("Speech did not match an exact choice; no answer submitted");
  try {
    return assertAnswerMatches(question, { binding: parsed.binding, source: "voice",
      text: matches.length ? null : parsed.transcript, choiceId: matches[0]?.id ?? null }, now);
  } catch { throw new QuestionRoutingError("Stale, expired or cross-scope question answer"); }
}

export function createQuestionRouter(options: QuestionRouterOptions): QuestionRouter {
  const now = options.now ?? (() => new Date());
  const submitting = new Set<string>();
  return {
    async attention() {
      const state = await options.harness.state();
      return pendingQuestions(state, now()).filter((question) =>
        state.rooms.find((room) => room.id === question.target.roomId)?.policy.attention === "normal")
        .sort((a, b) => Number(a.target.scope === "authoring") - Number(b.target.scope === "authoring") ||
          Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    },
    async answerVoice(raw) {
      const input = VoiceAnswerRequestSchema.parse(raw);
      const id = input.binding.questionId;
      if (submitting.has(id)) throw new QuestionRoutingError("Answer already being submitted");
      submitting.add(id);
      try {
        const state = await options.harness.state();
        const question = pendingQuestions(state, now()).find((question) => question.id === id);
        if (!question) throw new QuestionRoutingError("Exact pending question not found; approvals require their review card");
        const answer = normalizeVoiceAnswer(question, input, now());
        // The kernel must compare-and-consume this binding atomically; this snapshot is not authorization.
        return await options.harness.answerQuestion(answer);
      } finally { submitting.delete(id); }
    },
  };
}

/** Ephemeral playback coordination only; authoritative questions and answers remain in the kernel. */
export function createSpokenQuestionQueue() {
  const spoken = new Set<string>();
  let active: QuestionBinding | null = null;
  const key = (binding: QuestionBinding) => canonicalJson(binding);
  return {
    next(attention: readonly Question[]): Question | null {
      const bindings = new Set(attention.map((question) => key(questionBinding(question))));
      for (const item of spoken) if (!bindings.has(item)) spoken.delete(item);
      if (active && !bindings.has(key(active))) active = null;
      if (active) return null;
      const next = attention.find((question) => !spoken.has(key(questionBinding(question))));
      if (!next) return null;
      active = questionBinding(next);
      spoken.add(key(active));
      return structuredClone(next);
    },
    capturedBinding(): QuestionBinding | null { return active ? structuredClone(active) : null; },
    release(binding: QuestionBinding) {
      if (active && key(binding) === key(active)) active = null;
    },
    reset() { active = null; spoken.clear(); },
  };
}
