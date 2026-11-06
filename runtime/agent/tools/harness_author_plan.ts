import { defineTool } from "eve/tools";
import { AuthorToolInputSchema, authorPlanFromTool, createLoopbackHarnessAgentPort } from "../../bridge/harness-interactions/agent-tools.ts";

export default defineTool({
  description: "Create a scoped room with the operator's default policy, or draft a dependency plan for an exact existing room and revision from harness_room_state. Use the user's natural-language goal. This starts bounded model authoring only; it cannot accept plans, start workers, approve actions, change policies or grant host tools. Questions appear in the Rooms inbox. Never put secrets in goals.",
  inputSchema: AuthorToolInputSchema,
  availableInSubagents: false,
  async execute(input, ctx) {
    return authorPlanFromTool(createLoopbackHarnessAgentPort(ctx.abortSignal), input, {
      sessionId: ctx.session.id, callId: ctx.callId, delegated: ctx.session.parent !== null && ctx.session.parent !== undefined, signal: ctx.abortSignal,
    });
  },
});
