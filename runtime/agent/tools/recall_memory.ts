import { defineTool } from "eve/tools";
import { z } from "zod";
import { listMemories } from "../lib/memory.ts";

export default defineTool({
  description: "Read preferences the user explicitly saved in Jarvis memory.",
  inputSchema: z.object({}),
  async execute() {
    return { memories: await listMemories() };
  },
});
