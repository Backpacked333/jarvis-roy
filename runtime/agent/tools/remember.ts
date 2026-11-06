import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { rememberPreference } from "../lib/memory.ts";

export default defineTool({
  description: "Save a preference the user explicitly asked you to remember. Requires approval. Never store credentials.",
  inputSchema: z.object({ text: z.string().min(1).max(2_000) }),
  approval: always(),
  async execute({ text }, ctx) {
    return await rememberPreference(text, ctx.abortSignal);
  },
});
