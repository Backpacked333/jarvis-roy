import { z } from "zod";
import { RelativePathSchema } from "../harness-contracts/domain.ts";

export const ASSISTANT_VERSION = 1 as const;
export const AssistantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const text = z.string().max(32_000);

export const AssistantFocusSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("conversation"), conversationId: AssistantIdSchema, roomId: AssistantIdSchema.nullable() }),
  z.strictObject({ kind: z.literal("room"), roomId: AssistantIdSchema }),
]);
export type AssistantFocus = z.infer<typeof AssistantFocusSchema>;
export const AssistantIntentSchema = z.enum(["continue", "side_question", "redirect_work", "stop_work"]);
export type AssistantIntent = z.infer<typeof AssistantIntentSchema>;
export const AssistantPresentationRefSchema = z.strictObject({ presentationId: AssistantIdSchema, revision });

export const PresentationSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("document_passage"), passageId: AssistantIdSchema }),
  z.strictObject({ kind: z.literal("table_cell"), row: z.number().int().nonnegative(), column: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("text_range"), start: z.number().int().nonnegative(), end: z.number().int().positive() }),
]);
export type PresentationSelection = z.infer<typeof PresentationSelectionSchema>;
export const EditDraftSchema = z.strictObject({ expectedRevision: revision, body: text });

export const AssistantSessionSchema = z.strictObject({
  version: z.literal(1), id: AssistantIdSchema, title: z.string().trim().min(1).max(120), revision,
  focus: AssistantFocusSchema, createdAt: date, updatedAt: date,
});
export type AssistantSession = z.infer<typeof AssistantSessionSchema>;
export const AssistantTurnSchema = z.strictObject({
  version: z.literal(1), id: AssistantIdSchema, sessionId: AssistantIdSchema, revision,
  text, intent: AssistantIntentSchema, capturedFocus: AssistantFocusSchema,
  presentationRef: AssistantPresentationRefSchema.nullable().default(null),
  capturedPresentation: z.lazy(() => AssistantPresentationSchema).nullable().default(null),
  selection: PresentationSelectionSchema.nullable().default(null),
  sessionRevision: revision,
  status: z.enum(["dispatching", "running", "completed", "failed", "interrupted"]),
  taskId: AssistantIdSchema.nullable(), conversationId: AssistantIdSchema.nullable(),
  error: z.string().max(500).nullable(), createdAt: date, updatedAt: date,
});
export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

export const PresentationContentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), markdown: text }),
  z.strictObject({ kind: z.literal("document"), sourceVersionId: AssistantIdSchema,
    passages: z.array(z.strictObject({ id: AssistantIdSchema, text: z.string().max(8000),
      locator: z.strictObject({ page: z.number().int().positive().nullable(), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive() }),
    })).min(1).max(20) }),
  z.strictObject({ kind: z.literal("draft"), format: z.enum(["email", "document"]), title: z.string().max(300), body: text }),
  z.strictObject({ kind: z.literal("code_diff"), language: z.string().max(40), diff: text,
    verification: z.enum(["unverified", "passed", "failed"]) }),
  z.strictObject({ kind: z.literal("sources"), sources: z.array(z.strictObject({
    id: AssistantIdSchema, title: z.string().max(500), url: z.url().max(2000).refine(value => {
      const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    }, "Sources require credential-free HTTPS URLs"),
    excerpt: z.string().max(8000), retrievedAt: date, status: z.enum(["retrieved", "partial", "failed"]),
  })).max(40) }),
  z.strictObject({ kind: z.literal("code"), language: z.string().max(40), code: text,
    verification: z.enum(["unverified", "passed", "failed"]) }),
  z.strictObject({ kind: z.literal("math"), latex: z.string().max(16_000), explanation: z.string().max(8000),
    verification: z.enum(["unverified", "symbolic", "numerical", "formal"]) }),
  z.strictObject({ kind: z.literal("table"), columns: z.array(z.string().max(200)).min(1).max(20),
    rows: z.array(z.array(z.union([z.string().max(2000), z.number().finite(), z.null()])).max(20)).max(200) }),
  z.strictObject({ kind: z.literal("chart"), chartType: z.enum(["line", "bar", "scatter"]),
    xLabel: z.string().max(200), yLabel: z.string().max(200), series: z.array(z.strictObject({
      name: z.string().max(200), points: z.array(z.strictObject({ x: z.union([z.string().max(200), z.number().finite()]), y: z.number().finite() })).max(500),
    })).max(12) }),
  z.strictObject({ kind: z.literal("artifact"), roomId: AssistantIdSchema, runId: AssistantIdSchema,
    artifactId: AssistantIdSchema, digest, path: RelativePathSchema, mediaType: z.string().max(100),
    verification: z.enum(["unverified", "passed", "failed"]) }),
  z.strictObject({ kind: z.literal("plan"), roomId: AssistantIdSchema, planId: AssistantIdSchema,
    planRevision: revision, status: z.enum(["draft", "accepted", "running", "completed", "failed"]), summary: text }),
]);
export type PresentationContent = z.infer<typeof PresentationContentSchema>;
export const AssistantPresentationSchema = z.strictObject({
  version: z.literal(1), id: AssistantIdSchema, sessionId: AssistantIdSchema, turnId: AssistantIdSchema,
  revision, title: z.string().max(300), capturedFocus: AssistantFocusSchema, content: PresentationContentSchema,
  createdAt: date, updatedAt: date,
});
export type AssistantPresentation = z.infer<typeof AssistantPresentationSchema>;

export const ActionRefSchema = z.strictObject({ taskId: AssistantIdSchema, interactionId: AssistantIdSchema,
  revision, optionId: z.string().min(1).max(100) });
export type ActionRef = z.infer<typeof ActionRefSchema>;
export const ReviewableActionSchema = ActionRefSchema.extend({
  toolName: z.string().min(1).max(200), exactArguments: z.string().min(2).max(131_072),
  reviewText: z.string().min(1).max(131_072), voiceAllowed: z.boolean(),
  scope: z.enum(["task", "room"]).optional(),
});
export type ReviewableAction = z.infer<typeof ReviewableActionSchema>;
export const VoiceProposalSchema = z.strictObject({
  version: z.literal(1), id: AssistantIdSchema, sessionId: AssistantIdSchema, turnId: AssistantIdSchema,
  revision, digest, action: ReviewableActionSchema,
  status: z.enum(["proposed", "reviewed", "reading", "awaiting_confirmation", "executing", "completed", "invalidated", "uncertain"]),
  challenge: z.string().max(80).nullable(), expiresAt: date.nullable(),
  nativeSessionId: AssistantIdSchema.nullable(), readbackId: AssistantIdSchema.nullable(),
  createdAt: date, updatedAt: date,
});
export type VoiceProposal = z.infer<typeof VoiceProposalSchema>;

const eventFields = { version: z.literal(1), sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  timestamp: date, sessionId: AssistantIdSchema, turnId: AssistantIdSchema.nullable() };
export const AssistantEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventFields, type: z.literal("session.updated"), data: AssistantSessionSchema }),
  z.strictObject({ ...eventFields, type: z.literal("turn.updated"), data: AssistantTurnSchema }),
  z.strictObject({ ...eventFields, type: z.literal("presentation.updated"), data: AssistantPresentationSchema }),
  z.strictObject({ ...eventFields, type: z.literal("confirmation.updated"), data: VoiceProposalSchema }),
]);
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;
export const AssistantStateSchema = z.strictObject({
  version: z.literal(1), sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sessions: z.array(AssistantSessionSchema).max(100), turns: z.array(AssistantTurnSchema).max(500),
  presentations: z.array(AssistantPresentationSchema).max(300), proposals: z.array(VoiceProposalSchema).max(100),
});
export type AssistantState = z.infer<typeof AssistantStateSchema>;
export const AssistantSnapshotSchema = AssistantStateSchema.extend({ presentationHistory: z.array(AssistantPresentationSchema).max(300).default([]), events: z.array(AssistantEventSchema).max(512) });
export type AssistantSnapshot = z.infer<typeof AssistantSnapshotSchema>;

// These events must arrive through an independently authenticated native channel.
// No public HTTP route accepts them; the verifier must establish provenance, not
// trust these fields or a caller-supplied "active/unlocked" boolean.
const nativeFields = { eventId: AssistantIdSchema, proposalId: AssistantIdSchema, proposalRevision: revision,
  digest, timestamp: date, nativeSessionId: AssistantIdSchema };
export const NativeConfirmationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...nativeFields, type: z.literal("review_displayed"), reviewDigest: digest }),
  z.strictObject({ ...nativeFields, type: z.literal("readback_started"), readbackId: AssistantIdSchema, reviewDigest: digest }),
  z.strictObject({ ...nativeFields, type: z.literal("readback_drained"), readbackId: AssistantIdSchema }),
  z.strictObject({ ...nativeFields, type: z.literal("utterance"), readbackId: AssistantIdSchema, transcript: z.string().max(200), captureStartedAt: date }),
  z.strictObject({ ...nativeFields, type: z.literal("interrupted") }),
]);
export type NativeConfirmationEvent = z.infer<typeof NativeConfirmationEventSchema>;

export const CreateAssistantSessionSchema = z.strictObject({ title: z.string().trim().min(1).max(120), focus: AssistantFocusSchema });
export const UpdateAssistantFocusSchema = z.strictObject({ expectedRevision: revision, focus: AssistantFocusSchema });
export const SubmitAssistantTurnSchema = z.strictObject({ expectedRevision: revision, text: z.string().trim().min(1).max(16_000), intent: AssistantIntentSchema,
  presentationRef: AssistantPresentationRefSchema.nullable().optional(), selection: PresentationSelectionSchema.nullable().optional() });
export const AssistantEventsSchema = z.strictObject({ version: z.literal(1), sequence: z.number().int().min(0), events: z.array(AssistantEventSchema).max(512) });
