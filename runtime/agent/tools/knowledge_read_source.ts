import { defineTool } from "eve/tools";
import { createKnowledgeAgentPort, KnowledgeReadToolSchema } from "../../bridge/knowledge/agent-tools.ts";

export default defineTool({
  description: "Read exact source-version passages previously returned by knowledge_search or knowledge_retrieve. Requires the active project and explicit passage IDs; current source cloud permission is checked again. Metadata-only records are abstracts/bibliography, not a retrieved paper. Cite source version and page/line locators; distinguish evidence from interpretation.",
  inputSchema: KnowledgeReadToolSchema, availableInSubagents: false,
  async execute(input, ctx) {
    return createKnowledgeAgentPort({ sessionId: ctx.session.id, delegated: ctx.session.parent != null, signal: ctx.abortSignal }).read(input);
  },
});
