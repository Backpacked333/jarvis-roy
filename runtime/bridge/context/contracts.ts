import { z } from "zod";

export const ContextId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const ContextKindSchema = z.enum(["source", "memory", "history", "checkpoint"]);
export type ContextKind = z.infer<typeof ContextKindSchema>;
export const ContextRetrievalDiagnosticSchema = z.strictObject({
  mode: z.enum(["lexical", "hybrid", "history", "unavailable"]),
  warnings: z.array(z.string().max(300)).max(8).default([]),
});
export const ContextScopeSchema = z.strictObject({ projectId: ContextId,
  conversationId: ContextId.nullable(), taskId: ContextId.nullable() });
export type ContextScope = z.infer<typeof ContextScopeSchema>;
export const ContextPinSchema = z.strictObject({ kind: ContextKindSchema, id: ContextId,
  revision: z.number().int().positive().optional() });
export const ContextBudgetSchema = z.strictObject({
  maxBytes: z.number().int().min(1_024).max(131_072).default(32_768),
  maxTokens: z.number().int().min(512).max(131_104).default(12_000),
  maxItems: z.number().int().min(0).max(32).default(12),
});
export const ContextRequestSchema = z.strictObject({
  version: z.literal(1).default(1), scope: ContextScopeSchema,
  purpose: z.enum(["local", "cloud"]), query: z.string().trim().min(1).max(1_000),
  currentTurn: z.strictObject({ text: z.string().max(20_000) }),
  budget: ContextBudgetSchema.default({ maxBytes: 32_768, maxTokens: 12_000, maxItems: 12 }),
  pins: z.array(ContextPinSchema).max(16).default([]),
}).superRefine((input, context) => {
  if (input.scope.taskId && !input.scope.conversationId) context.addIssue({ code: "custom", message: "Task scope requires its conversation" });
  const pins = input.pins.map(pin => `${pin.kind}:${pin.id}`);
  if (new Set(pins).size !== pins.length) context.addIssue({ code: "custom", message: "Pin each context identity only once" });
});
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
export type ContextRequestInput = z.input<typeof ContextRequestSchema>;
export const ContextCitationSchema = z.strictObject({ sourceVersionId: ContextId, passageId: ContextId,
  locator: z.strictObject({ page: z.number().int().positive().nullable(), lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(), section: z.string().max(1000).optional(), symbol: z.string().max(240).optional(),
    rowStart: z.number().int().positive().optional(), rowEnd: z.number().int().positive().optional() }).nullable().default(null) });
export const ContextProvenanceSchema = z.strictObject({
  origin: z.enum(["original_source", "user_approved_memory", "retained_snapshot", "account_context", "conversation_message", "extractive_checkpoint", "project_checkpoint", "model_summary"]),
  referenceId: ContextId, revision: z.number().int().positive(),
  memoryScope: z.enum(["personal", "project"]).optional(),
});
export const ContextCandidateSchema = z.strictObject({
  id: ContextId, kind: ContextKindSchema, projectId: ContextId,
  conversationId: ContextId.nullable().default(null), taskId: ContextId.nullable().default(null),
  revision: z.number().int().positive(), title: z.string().max(240), text: z.string().max(32_000),
  score: z.number().finite().min(0).max(1).default(0),
  retrievalReasons: z.array(z.string().max(300)).max(8).optional(),
  citations: z.array(ContextCitationSchema).max(20).default([]), provenance: ContextProvenanceSchema,
  retention: z.strictObject({ grantId: ContextId, grantRevision: z.number().int().positive(), kind: z.enum(["source", "memory"]), id: ContextId,
    revision: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  accountContext: z.strictObject({ id: ContextId, sourceRevision: z.string().min(1).max(1000), accountId: ContextId,
    provider: z.enum(["gmail", "calendar"]), resourceId: z.string().min(1).max(300), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>;
export type ContextCandidateInput = z.input<typeof ContextCandidateSchema>;
export const ContextActionSchema = z.strictObject({
  projectId: ContextId, conversationId: ContextId, taskId: ContextId,
  status: z.enum(["starting", "running", "waiting", "completed", "failed", "cancelled", "interrupted"]),
  pendingApprovals: z.number().int().nonnegative(),
  interactionId: ContextId.nullable().default(null), revision: z.number().int().positive().nullable().default(null),
  toolName: z.string().min(1).max(200).nullable().default(null), summary: z.string().max(500),
  argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
});
export type ContextAction = z.infer<typeof ContextActionSchema>;
export type ContextActionInput = z.input<typeof ContextActionSchema>;
export const ContextSelectionSchema = ContextCandidateSchema.omit({ score: true }).extend({
  reasons: z.array(z.enum(["pinned", "query_match", "retrieval_rank", "recent_history", "checkpoint_continuity"])).min(1).max(5),
  contentTrust: z.literal("untrusted_data"), verification: z.literal("not_independently_verified"),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/), originalBytes: z.number().int().nonnegative(),
  selectedBytes: z.number().int().nonnegative(), truncated: z.boolean(),
  span: z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), unit: z.literal("utf16") }).optional(),
});
export type ContextSelection = z.infer<typeof ContextSelectionSchema>;
export const ContextPacketSchema = z.strictObject({
  version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), scope: ContextScopeSchema,
  purpose: z.enum(["local", "cloud"]), query: z.string().max(1_000),
  currentTurn: z.strictObject({ taskId: ContextId.nullable(), textSha256: z.string().regex(/^[a-f0-9]{64}$/), provenance: z.literal("current_user_turn") }),
  selections: z.array(ContextSelectionSchema).max(32),
  retrieval: z.array(ContextRetrievalDiagnosticSchema.extend({ kind: ContextKindSchema })).max(4).default([]),
  activeActions: z.array(ContextActionSchema.extend({ authority: z.literal("reference_only"), provenance: z.literal("current_runtime_action") })).max(8),
  omitted: z.strictObject({ budget: z.number().int().nonnegative(), scope: z.number().int().nonnegative(),
    permission: z.number().int().nonnegative(), duplicate: z.number().int().nonnegative(),
    availableBeyondLimit: z.number().int().nonnegative(), pinsMissing: z.number().int().nonnegative() }),
  usage: z.strictObject({ maxBytes: z.number().int().positive(), maxTokens: z.number().int().positive(),
    serializedBytes: z.number().int().nonnegative(), estimatedTokens: z.number().int().nonnegative(),
    estimator: z.literal("utf8_bytes_upper_bound"), framingTokens: z.literal(32) }),
  providerHistory: z.literal("not_modified_by_assembler"),
  notice: z.string().max(600),
});
export type ContextPacket = z.infer<typeof ContextPacketSchema>;

export interface ContextRetrievalRequest {
  scope: ContextScope; purpose: "local" | "cloud"; query: string;
  limit: number; pins: ContextRequest["pins"];
}
export interface ContextCandidateBatch {
  candidates: ContextCandidateInput[]; availableBeyondLimit?: number;
  retrieval?: z.input<typeof ContextRetrievalDiagnosticSchema>;
}
/** Providers must authorize current committed state synchronously. Personal memory
 * candidates are projected to the requested project only after explicit permission. */
export interface ContextProvider {
  retrieve(input: ContextRetrievalRequest, signal: AbortSignal): Promise<ContextCandidateBatch>;
  authorize(candidate: ContextCandidate | ContextSelection, input: ContextRetrievalRequest): boolean;
  reauthorize?(candidates: (ContextCandidate | ContextSelection)[], input: ContextRetrievalRequest, signal?: AbortSignal): Promise<boolean>;
}
export interface ContextAssemblerOptions {
  providers: Partial<Record<ContextKind, ContextProvider>>;
  authorizeScope(scope: ContextScope, purpose: "local" | "cloud"): void;
  activeActions?: (scope: ContextScope, signal: AbortSignal) => Promise<ContextActionInput[]>;
  authorizeAction?: (action: ContextAction, scope: ContextScope) => boolean;
}
