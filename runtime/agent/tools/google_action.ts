import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { GoogleActionInputSchema } from "../../bridge/google-effect-contracts.ts";
import { executeApprovedGoogleAction } from "../lib/google-action.ts";

export default defineTool({
  description: "Send one exact Gmail message or create one exact Google Calendar event using an already connected account with separate write consent. Always requires review of the complete account, project, recipient/calendar, text and dates. Use a fresh requestId and the current immutable projectId; objectiveId is null unless linked to that objective. Submission is not proof of delivery. Never retry an uncertain effect automatically.",
  inputSchema: GoogleActionInputSchema, approval: always(), availableInSubagents: false,
  async execute(input, ctx) {
    return executeApprovedGoogleAction(input, { sessionId: ctx.session.id, callId: ctx.callId,
      approved: ctx.approval !== undefined, delegated: ctx.session.parent != null, signal: ctx.abortSignal });
  },
});
