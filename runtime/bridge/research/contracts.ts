import { z } from "zod";
import { KnowledgeId, DeliverableInputSchema } from "../knowledge/contracts.ts";

export const ResearchBudgetSchema = z.strictObject({
  estimatedUsd: z.number().finite().min(0).max(100).default(5),
  maxWallTimeMs: z.number().int().min(1000).max(3_600_000).default(1_800_000),
  maxConcurrentWorkers: z.number().int().min(1).max(2).default(2),
  maxModelCalls: z.number().int().min(2).max(4).default(2),
  maxTokens: z.number().int().min(1000).max(200_000).default(100_000),
});
export const StartResearchSchema = z.strictObject({
  requestId: KnowledgeId, projectId: KnowledgeId, goal: z.string().trim().min(1).max(8000),
  publicQuery: z.string().trim().min(1).max(400).optional(),
  providers: z.array(z.enum(["arxiv", "crossref", "tavily"])).max(3).default(["arxiv", "crossref"]),
  sourceVersionIds: z.array(KnowledgeId).max(20).default([]),
  budget: ResearchBudgetSchema.default(() => ResearchBudgetSchema.parse({})),
  tavilyAllowanceUsd: z.number().finite().positive().max(100).optional(),
}).superRefine((value, context) => {
  if (new Set(value.providers).size !== value.providers.length || new Set(value.sourceVersionIds).size !== value.sourceVersionIds.length) context.addIssue({ code: "custom", message: "Duplicate providers or sources" });
  if (value.providers.includes("tavily") && (!value.tavilyAllowanceUsd || value.tavilyAllowanceUsd > value.budget.estimatedUsd)) context.addIssue({ code: "custom", message: "Unpriced Tavily requests require an explicit cost allowance within the estimate budget; it is not a billing cap" });
  if (value.tavilyAllowanceUsd && !value.providers.includes("tavily")) context.addIssue({ code: "custom", message: "Tavily allowance requires a selected Tavily provider" });
});
export type StartResearch = z.infer<typeof StartResearchSchema>;
export const ResearchDraftSchema = DeliverableInputSchema.omit({ projectId: true }).extend({
  markdown: z.string().trim().min(1).max(32_000),
  claims: DeliverableInputSchema.shape.claims.max(30), checks: z.array(z.never()).length(0),
});
export type ResearchDraft = z.infer<typeof ResearchDraftSchema>;
export const ResearchCritiqueSchema = z.strictObject({
  verdict: z.enum(["supported_with_limits", "needs_revision", "insufficient_evidence"]),
  summary: z.string().min(1).max(4000),
  issues: z.array(z.strictObject({ claimIndex: z.number().int().min(0).max(29).nullable(),
    severity: z.enum(["note", "unsupported", "contradiction"]), explanation: z.string().min(1).max(2000) })).max(30),
});
export type ResearchCritique = z.infer<typeof ResearchCritiqueSchema>;
export const ResearchRunSchema = z.strictObject({
  version: z.literal(1), id: KnowledgeId, requestId: KnowledgeId, projectId: KnowledgeId, revision: z.number().int().positive(),
  goal: z.string().max(8000), status: z.enum(["queued", "collecting", "synthesizing", "critiquing", "publishing", "completed", "failed", "cancelled", "interrupted"]),
  budget: ResearchBudgetSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  sourceVersionIds: z.array(KnowledgeId).max(80), passageCount: z.number().int().min(0).max(40),
  modelCalls: z.number().int().min(0).max(4), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  reservedTokens: z.number().int().nonnegative(), estimatedModelUsd: z.number().finite().nonnegative(),
  reservedRetrievalUsd: z.number().finite().nonnegative(),
  accounting: z.enum(["estimated", "unknown"]), retrievalAccounting: z.enum(["local_and_public_metadata", "operator_allowance_unverified"]),
  critiqueVerdict: z.enum(["supported_with_limits", "needs_revision", "insufficient_evidence"]).nullable(),
  deliverableId: KnowledgeId.nullable(), error: z.string().max(500).nullable(),
  progress: z.array(z.strictObject({ sequence: z.number().int().positive(), at: z.iso.datetime(), stage: z.string().max(100), detail: z.string().max(500) })).max(100),
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;
export const ResearchRecordSchema = z.strictObject({ run: ResearchRunSchema, input: StartResearchSchema, critique: ResearchCritiqueSchema.nullable() });
export type ResearchRecord = z.infer<typeof ResearchRecordSchema>;
