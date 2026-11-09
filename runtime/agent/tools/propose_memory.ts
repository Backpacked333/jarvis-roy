import { defineTool } from "eve/tools";
import { assistantAgentPort } from "../../bridge/assistant/agent-tools.ts";
import { ProposeMemoryToolSchema } from "../../bridge/memory-tool-contracts.ts";

export default defineTool({
  description: "Propose a durable preference, fact, goal, person, routine or decision for the user's Memory review. This creates a pending proposal, not approved memory. Use project scope for project knowledge; global only for a personal fact or preference the user asked to remember. Source references must belong to the active project. Never store credentials. Keep cloudAllowed false unless the user explicitly wants future cloud recall; the native review decides. Edits require a fresh review.",
  inputSchema: ProposeMemoryToolSchema,
  availableInSubagents: false,
  execute(input, ctx) {
    return assistantAgentPort({ sessionId: ctx.session.id, delegated: ctx.session.parent != null, signal: ctx.abortSignal }).proposeMemory(input);
  },
});
