import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { KnowledgeId } from "../../bridge/knowledge/contracts.ts";
import { StartResearchSchema } from "../../bridge/research/contracts.ts";
import { assistantAgentPort } from "../../bridge/assistant/agent-tools.ts";
const inputSchema = z.strictObject({
  requestId: KnowledgeId, projectId: KnowledgeId, goal: z.string().min(1).max(8000),
  publicQuery: z.string().min(1).max(400).optional(), providers: z.array(z.enum(["arxiv", "crossref"])).max(2),
  sourceVersionIds: z.array(KnowledgeId).max(20),
  budget: z.strictObject({ estimatedUsd: z.number().min(0).max(100), maxWallTimeMs: z.number().int().min(1000).max(3600000),
    maxConcurrentWorkers: z.number().int().min(1).max(2), maxModelCalls: z.literal(2), maxTokens: z.number().int().min(1000).max(200000) }),
});
export default defineTool({
  description: "Propose budgeted research with separate synthesis and critique model calls and exact citations. Approval covers the entire public query and budget. Obtain active project/source IDs first. Suggest $5, 30 minutes, two retrieval workers and 100000 tokens; estimates are not provider billing caps. Without publicQuery only selected cloud-authorized local evidence is used. Starting is not completion. No code execution occurs here; use isolated Rooms for calculations.",
  inputSchema, approval: always(), availableInSubagents: false,
  execute(input, ctx) { return assistantAgentPort({ sessionId: ctx.session.id, delegated: ctx.session.parent != null, signal: ctx.abortSignal }).startResearch(StartResearchSchema.parse(input)); },
});
