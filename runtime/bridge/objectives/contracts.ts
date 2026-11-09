import { z } from "zod";

export const ObjectiveId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const date = z.iso.datetime();
const usd = z.number().finite().min(0).max(10_000);
export const ObjectiveAuthoritySchema = z.enum(["task", "research", "harness"]);
export type ObjectiveAuthority = z.infer<typeof ObjectiveAuthoritySchema>;
export const ChildRunRefSchema = z.discriminatedUnion("authority", [
  z.strictObject({ authority: z.literal("task"), projectId: ObjectiveId, taskId: ObjectiveId, conversationId: ObjectiveId }),
  z.strictObject({ authority: z.literal("research"), projectId: ObjectiveId, runId: ObjectiveId }),
  z.strictObject({ authority: z.literal("harness"), projectId: ObjectiveId, roomId: ObjectiveId, runId: ObjectiveId,
    planId: ObjectiveId, planDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type ChildRunRef = z.infer<typeof ChildRunRefSchema>;
export const ObjectiveStepSchema = z.strictObject({
  id: ObjectiveId, authority: ObjectiveAuthoritySchema, prompt: z.string().trim().min(1).max(16_000),
  parameters: z.record(z.string(), z.json()).default({}), dependsOn: z.array(ObjectiveId).max(31).default([]),
  estimatedUsd: usd.refine(value => value <= 5).default(1),
  maxWallTimeMs: z.number().int().min(1_000).max(1_800_000).default(1_800_000),
});
export type ObjectiveStep = z.infer<typeof ObjectiveStepSchema>;
export const ObjectiveQuestionSchema = z.strictObject({ id: ObjectiveId, revision: z.number().int().positive(),
  prompt: z.string().min(1).max(4_000), expiresAt: date });
export const WorkCheckpointSchema = z.strictObject({
  version: z.literal(1), id: ObjectiveId, objectiveId: ObjectiveId, projectId: ObjectiveId,
  createdAt: date, summary: z.string().max(8_000),
  childRefs: z.array(ChildRunRefSchema).max(32).default([]),
  artifactRefs: z.array(z.strictObject({ id: ObjectiveId, digest: z.string().regex(/^[a-f0-9]{64}$/) })).max(64).default([]),
  verification: z.literal("unverified_summary").default("unverified_summary"),
});
export type WorkCheckpoint = z.infer<typeof WorkCheckpointSchema>;
export const ChildObservationSchema = z.strictObject({
  ref: ChildRunRefSchema,
  status: z.enum(["running", "waiting", "completed", "failed", "cancelled", "unknown"]),
  accounting: z.enum(["measured", "unknown"]), estimatedUsd: usd.nullable(),
  cancelConfirmed: z.boolean().default(false), detail: z.string().max(1_000).nullable().default(null),
  checkpoint: WorkCheckpointSchema.optional(),
});
export type ChildObservation = z.infer<typeof ChildObservationSchema>;
export const ObjectiveAttemptSchema = z.strictObject({
  id: ObjectiveId, stepId: ObjectiveId, authority: ObjectiveAuthoritySchema,
  status: z.enum(["dispatching", "running", "waiting", "completed", "failed", "cancelled", "unknown"]),
  child: ChildRunRefSchema.nullable(), startedAt: date, deadlineAt: date, updatedAt: date,
  reservedUsd: usd, chargedUsd: usd, accounting: z.enum(["reserved", "measured", "unknown"]),
  cancelConfirmed: z.boolean(), detail: z.string().max(1_000).nullable(),
});
export type ObjectiveAttempt = z.infer<typeof ObjectiveAttemptSchema>;
export const ObjectiveStatusSchema = z.enum(["needs_plan", "scheduled", "running", "waiting", "waiting_for_user", "waiting_for_device", "paused", "completed", "failed", "cancelled", "interrupted", "expired"]);
export const ObjectiveSchema = z.strictObject({
  version: z.literal(1), id: ObjectiveId, requestId: ObjectiveId, projectId: ObjectiveId,
  title: z.string().trim().min(1).max(240), goal: z.string().trim().min(1).max(16_000),
  revision: z.number().int().positive(), status: ObjectiveStatusSchema,
  cancelRequested: z.boolean(),
  createdAt: date, updatedAt: date, deadlineAt: date, wakeAt: date.nullable(),
  steps: z.array(ObjectiveStepSchema).max(32), attempts: z.array(ObjectiveAttemptSchema).max(128),
  checkpoint: WorkCheckpointSchema.nullable(), question: ObjectiveQuestionSchema.nullable(),
  budget: z.strictObject({ limitUsd: usd.refine(value => value <= 5), spentUsd: usd, reservedUsd: usd }),
  lastError: z.string().max(1_000).nullable(),
});
export type Objective = z.infer<typeof ObjectiveSchema>;
export const CreateObjectiveSchema = z.strictObject({
  version: z.literal(1).default(1), requestId: ObjectiveId, projectId: ObjectiveId,
  title: z.string().trim().min(1).max(240), goal: z.string().trim().min(1).max(16_000),
  steps: z.array(ObjectiveStepSchema).max(32).default([]),
  estimatedUsdLimit: usd.refine(value => value <= 5).default(5),
  deadlineAt: date.optional(), wakeAt: date.nullable().optional(),
});
export const ObjectiveRevisionSchema = z.strictObject({ expectedRevision: z.number().int().positive() });
export const ReviseObjectiveSchema = ObjectiveRevisionSchema.extend({
  title: z.string().trim().min(1).max(240).optional(), goal: z.string().trim().min(1).max(16_000).optional(),
  steps: z.array(ObjectiveStepSchema).max(32).optional(), deadlineAt: date.optional(), wakeAt: date.nullable().optional(),
});
export const AnswerObjectiveSchema = ObjectiveRevisionSchema.extend({
  questionId: ObjectiveId, questionRevision: z.number().int().positive(), answer: z.string().trim().min(1).max(4_000),
});
export const ObjectiveEventSchema = z.strictObject({
  version: z.literal(1), sequence: z.number().int().positive(), at: date,
  objectiveId: ObjectiveId, projectId: ObjectiveId, revision: z.number().int().positive(),
  status: ObjectiveStatusSchema, kind: z.enum(["created", "revised", "observed", "checkpoint", "question", "answered", "paused", "resumed", "stopped"]),
});
export type ObjectiveEvent = z.infer<typeof ObjectiveEventSchema>;
export const BudgetReservationSchema = z.strictObject({
  id: ObjectiveId, requestId: ObjectiveId, objectiveId: ObjectiveId.nullable(), projectId: ObjectiveId,
  authority: z.string().min(1).max(80), createdAt: date, reservedUsd: usd, chargedUsd: usd,
  accounting: z.enum(["reserved", "measured", "unknown"]),
});
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;
export const ReserveBudgetSchema = z.strictObject({ requestId: ObjectiveId, objectiveId: ObjectiveId.nullable().default(null),
  projectId: ObjectiveId, authority: z.string().min(1).max(80), estimatedUsd: usd.refine(value => value <= 5) });
export const ObjectiveSnapshotSchema = z.strictObject({
  version: z.literal(1), sequence: z.number().int().nonnegative(),
  objectives: z.array(ObjectiveSchema).max(500), events: z.array(ObjectiveEventSchema).max(1_000),
  reservations: z.array(BudgetReservationSchema).max(10_000),
  requests: z.array(z.strictObject({ key: z.string().max(300), digest: z.string().regex(/^[a-f0-9]{64}$/), objectiveId: ObjectiveId })).max(5_000),
  inbox: z.array(z.strictObject({ id: ObjectiveId, objectiveId: ObjectiveId, questionId: ObjectiveId,
    questionRevision: z.number().int().positive(), answer: z.string().max(4_000), at: date })).max(5_000),
});
export type ObjectiveSnapshot = z.infer<typeof ObjectiveSnapshotSchema>;
export interface ObjectiveDispatch {
  objectiveId: string; projectId: string; attemptId: string; step: ObjectiveStep;
  checkpoint: WorkCheckpoint | null; answers: ObjectiveSnapshot["inbox"];
}
/** Adapters delegate to existing execution authorities. Dispatch receives a
 * durable unique attempt ID and must bind receipts to that exact operation. */
export interface ObjectiveAdapter {
  dispatch(input: ObjectiveDispatch, signal: AbortSignal): Promise<ChildObservation>;
  inspect(ref: ChildRunRef, signal: AbortSignal): Promise<ChildObservation>;
  cancel(ref: ChildRunRef, signal: AbortSignal): Promise<ChildObservation>;
}
