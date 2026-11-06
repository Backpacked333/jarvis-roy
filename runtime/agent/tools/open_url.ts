import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { openHttpsUrl, validateHttpsUrl } from "../lib/tool-actions.ts";

export default defineTool({
  description: "Open an HTTPS website in the default macOS browser after approval. This does not read the webpage.",
  inputSchema: z.object({ url: z.string().url().max(2_000) }),
  approval: always(),
  async execute({ url }, ctx) {
    const validatedUrl = validateHttpsUrl(url);
    return { url: await openHttpsUrl(validatedUrl, ctx.abortSignal) };
  },
});
