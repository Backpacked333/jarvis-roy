import { defineTool } from "eve/tools";
import { createKnowledgeAgentPort } from "../../bridge/knowledge/agent-tools.ts";
import { DeliverableInputSchema } from "../../bridge/knowledge/contracts.ts";

export default defineTool({
  description: "Save a research deliverable inside the active project with exact passage quotes, claims, unresolved questions and reported checks. This is a local project artifact, not external publication or a personal memory. Supported claims require citations; quote and locator matching is checked but semantic support still needs critique. Label inferences and unknowns. Reported calculations/tests are not independently verified without real worker artifacts. Revoked or local-only citations cannot be disclosed to the model.",
  inputSchema: DeliverableInputSchema, availableInSubagents: false,
  async execute(input, ctx) {
    return createKnowledgeAgentPort({ sessionId: ctx.session.id, delegated: ctx.session.parent != null, signal: ctx.abortSignal }).publish(input);
  },
});
