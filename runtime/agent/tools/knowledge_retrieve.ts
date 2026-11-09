import { defineTool } from "eve/tools";
import { createKnowledgeAgentPort } from "../../bridge/knowledge/agent-tools.ts";
import { RetrieveInputSchema } from "../../bridge/knowledge/contracts.ts";

export default defineTool({
  description: "Retrieve bounded public research into the active project through Tavily, Crossref, or arXiv. Crossref/arXiv return bibliographic metadata and abstracts only; Tavily search snippets are also metadata-only. Full text requires a separate knowledge_extract call. Preserves source versions and passage locators. Provider costs may be unknown and must not be reported as zero or included in a guaranteed billing cap. No private/source-grant creation or arbitrary network access.",
  inputSchema: RetrieveInputSchema, availableInSubagents: false,
  async execute(input, ctx) {
    return createKnowledgeAgentPort({ sessionId: ctx.session.id, delegated: ctx.session.parent != null, signal: ctx.abortSignal }).retrieve(input);
  },
});
