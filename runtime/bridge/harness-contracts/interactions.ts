import { z } from "zod";
import { IdSchema, RevisionSchema, TextSchema, TimestampSchema } from "./domain.ts";

export const QuestionTargetSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("node"), roomId: IdSchema, runId: IdSchema, nodeId: IdSchema, attemptId: IdSchema }),
  z.strictObject({ scope: z.literal("authoring"), roomId: IdSchema, authoringId: IdSchema }),
]);
export type QuestionTarget = z.infer<typeof QuestionTargetSchema>;
export const QuestionChoiceSchema = z.strictObject({ id: IdSchema, label: z.string().trim().min(1).max(200) });
export const QuestionPromptSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(2_000),
  choices: z.array(QuestionChoiceSchema).max(8), allowText: z.boolean(),
}).superRefine((value, ctx) => {
  if (!value.allowText && value.choices.length === 0) ctx.addIssue({ code: "custom", message: "Question needs an answer mode" });
  if (new Set(value.choices.map((choice) => choice.id)).size !== value.choices.length) ctx.addIssue({ code: "custom", message: "Duplicate choice ID" });
});
export type QuestionPrompt = z.infer<typeof QuestionPromptSchema>;
export const QuestionBindingSchema = z.strictObject({
  questionId: IdSchema, revision: RevisionSchema, target: QuestionTargetSchema,
});
export type QuestionBinding = z.infer<typeof QuestionBindingSchema>;
export const QuestionSchema = z.strictObject({
  kind: z.literal("question"), id: IdSchema, revision: RevisionSchema,
  target: QuestionTargetSchema, question: QuestionPromptSchema,
  status: z.enum(["pending", "answered", "cancelled", "expired"]),
  createdAt: TimestampSchema, expiresAt: TimestampSchema,
  answer: z.strictObject({ text: TextSchema.nullable(), choiceId: IdSchema.nullable(), answeredAt: TimestampSchema }).nullable(),
});
export type Question = z.infer<typeof QuestionSchema>;
export const AnswerQuestionRequestSchema = z.strictObject({
  binding: QuestionBindingSchema, source: z.enum(["text", "voice"]),
  text: TextSchema.nullable(), choiceId: IdSchema.nullable(),
}).refine((value) => (value.text !== null) !== (value.choiceId !== null), "Provide exactly one text or choice answer");
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequestSchema>;
export const VoiceAnswerRequestSchema = z.strictObject({ binding: QuestionBindingSchema, transcript: TextSchema });
export type VoiceAnswerRequest = z.infer<typeof VoiceAnswerRequestSchema>;

export const HarnessApprovalSchema = z.strictObject({
  kind: z.literal("approval"), id: IdSchema,
  roomId: IdSchema.nullable(), runId: IdSchema.nullable(), nodeId: IdSchema.nullable(),
  taskId: IdSchema, interactionId: z.string().min(1).max(256), revision: RevisionSchema,
  title: z.string().max(200), detail: z.string().max(16_000),
  status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]),
  reviewable: z.boolean(), blockedReason: z.string().max(2_000).nullable(),
  options: z.array(QuestionChoiceSchema).max(8),
});
export type HarnessApproval = z.infer<typeof HarnessApprovalSchema>;

export function questionBinding(question: Question): QuestionBinding {
  return { questionId: question.id, revision: question.revision, target: { ...question.target } };
}

export function assertAnswerMatches(question: Question, input: unknown, now = new Date()): AnswerQuestionRequest {
  const answer = AnswerQuestionRequestSchema.parse(input);
  const current = questionBinding(question);
  const a = answer.binding.target;
  const b = current.target;
  const sameTarget = a.scope === b.scope && a.roomId === b.roomId &&
    (a.scope === "node" && b.scope === "node"
      ? a.runId === b.runId && a.nodeId === b.nodeId && a.attemptId === b.attemptId
      : a.scope === "authoring" && b.scope === "authoring" && a.authoringId === b.authoringId);
  if (answer.binding.questionId !== current.questionId || answer.binding.revision !== current.revision || !sameTarget) {
    throw new Error("Stale or cross-scope question binding");
  }
  if (question.status !== "pending" || Date.parse(question.expiresAt) <= now.getTime()) throw new Error("Question is no longer pending");
  if (answer.text !== null && !question.question.allowText) throw new Error("Question requires a choice");
  if (answer.choiceId !== null && !question.question.choices.some((choice) => choice.id === answer.choiceId)) {
    throw new Error("Unknown question choice");
  }
  return answer;
}
