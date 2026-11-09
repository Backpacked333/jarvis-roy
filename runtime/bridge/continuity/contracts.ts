import { z } from "zod";
import { ContextId, ContextPinSchema, ContextCitationSchema, ContextCandidateSchema } from "../context/contracts.ts";

export const ContinuityReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("source"), id: ContextId, revision: z.number().int().positive(), sourceVersionId: ContextId, originalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.strictObject({ kind: z.literal("memory"), id: ContextId, revision: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("history"), id: ContextId, revision: z.number().int().positive(), conversationId: ContextId }),
  z.strictObject({ kind: z.literal("checkpoint"), id: ContextId, revision: z.number().int().positive() }),
]);
export type ContinuityReference = z.infer<typeof ContinuityReferenceSchema>;
export const CommittedTaskEpisodeSchema = z.strictObject({
  projectId: ContextId, conversationId: ContextId, taskId: ContextId, eventId: z.string().min(1).max(240),
  status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
  goal: z.string().min(1).max(8000), observedOutcome: z.string().max(8000).optional(),
  references: z.array(ContinuityReferenceSchema).max(64).default([]),
  // Only literal runtime status and directly submitted user text are independent
  // of source grants. Generated summaries must carry complete dependencies.
  outcomeAuthority: z.enum(["runtime_status", "unverified_summary"]).default("runtime_status"),
  dependenciesComplete: z.boolean().default(false), occurredAt: z.iso.datetime(),
});
export const ProjectEpisodeSchema = CommittedTaskEpisodeSchema.extend({
  version: z.literal(1), id: ContextId, revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().positive(),
});
export type ProjectEpisode = z.infer<typeof ProjectEpisodeSchema>;
export const WorkingSetSchema = z.strictObject({
  version: z.literal(1), projectId: ContextId, revision: z.number().int().nonnegative(),
  pins: z.array(ContextPinSchema).max(16), goal: z.string().max(2000).nullable(), updatedAt: z.iso.datetime().nullable(),
});
export const WorkingSetUpdateSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(),
  pins: z.array(ContextPinSchema).max(16), goal: z.string().max(2000).nullable() }).superRefine((value, context) => {
    if (new Set(value.pins.map(pin => `${pin.kind}:${pin.id}`)).size !== value.pins.length) context.addIssue({ code: "custom", message: "Duplicate context pins" });
  });
export const UsageManifestSchema = z.strictObject({
  version: z.literal(1), id: ContextId, packetId: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: ContextId, conversationId: ContextId.nullable(), taskId: ContextId.nullable(), createdAt: z.iso.datetime(),
  usageAuthority: z.literal("supplied_context_not_claim_attribution"),
  selections: z.array(z.strictObject({ kind: z.enum(["source", "memory", "history", "checkpoint"]), id: ContextId,
    revision: z.number().int().positive(), originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reasons: z.array(z.string().max(80)).max(5), citations: z.array(ContextCitationSchema).max(20),
    retention: ContextCandidateSchema.shape.retention, accountContext: ContextCandidateSchema.shape.accountContext,
  })).max(32),
});
export type UsageManifest = z.infer<typeof UsageManifestSchema>;
