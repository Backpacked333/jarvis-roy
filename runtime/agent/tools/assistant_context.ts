import { defineTool } from "eve/tools";
import { z } from "zod";
import { assistantAgentPort } from "../../bridge/assistant/agent-tools.ts";
export default defineTool({
  description: "Get the active session's exact project scope, captured visual reference, and existing cloud-authorized read grants. Use these IDs for knowledge and context tools. This does not create or widen permissions, access private contents, or approve actions.",
  inputSchema: z.strictObject({}), availableInSubagents: false,
  execute(_input, ctx) { return assistantAgentPort({ sessionId: ctx.session.id, delegated: ctx.session.parent != null, signal: ctx.abortSignal }).context(); },
});
