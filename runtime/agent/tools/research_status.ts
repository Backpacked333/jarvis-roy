import { defineTool } from "eve/tools";
import { z } from "zod";
import { KnowledgeId } from "../../bridge/knowledge/contracts.ts";
import { assistantAgentPort } from "../../bridge/assistant/agent-tools.ts";
export default defineTool({
  description: "Inspect actual research progress or read its source-linked result and separate critique in the active project. Cancel stops the exact run; it is not rollback. Model critique is not a formal proof or code execution result.",
  inputSchema: z.strictObject({ projectId: KnowledgeId, runId: KnowledgeId.optional(), action: z.enum(["status", "result", "cancel"]) }), availableInSubagents: false,
  execute(input, ctx) {
    if (input.action !== "status" && !input.runId) throw new Error("An exact research run is required");
    const port = assistantAgentPort({ sessionId: ctx.session.id, delegated: ctx.session.parent != null, signal: ctx.abortSignal });
    return input.action === "cancel" ? port.cancelResearch(input.projectId, input.runId!) : port.researchStatus(input.projectId, input.runId, input.action === "result");
  },
});
