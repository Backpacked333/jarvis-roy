import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { saveNote } from "../lib/tool-actions.ts";

export default defineTool({
  description: "Save a plain-text note inside the Jarvis notes folder after approval. Cannot overwrite existing files.",
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    content: z.string().max(20_000),
  }),
  approval: always(),
  async execute(input, ctx) {
    return { path: await saveNote(input, ctx.abortSignal) };
  },
});
