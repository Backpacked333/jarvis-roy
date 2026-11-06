import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { createConnectedServices, messageServiceSchema } from "../lib/connected-services.ts";

export default defineTool({
  description: "Optional native macOS Messages adapter, enabled with JARVIS_ENABLE_APPLE_SERVICES=1. Every action requires approval. List configured iMessage services (max 10), then send the exact approved body to one explicit email address or E.164 phone number on a selected serviceId. No SMS, attachments or group sends. Submission is not delivery confirmation; never retry uncertain sends. read_history returns an honest unsupported status: Jarvis never reads chat.db or scrapes private message databases.",
  inputSchema: messageServiceSchema,
  approval: always(),
  availableInSubagents: false,
  async execute(input, ctx) {
    return createConnectedServices().message(input, { signal: ctx.abortSignal, sessionId: ctx.session.id });
  },
});
