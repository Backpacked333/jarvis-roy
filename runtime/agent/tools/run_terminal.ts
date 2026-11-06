import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { runTerminal, terminalInputSchema } from "../lib/desktop.ts";

export default defineTool({
  description: "Execute exactly the approved absolute executable, args array, and cwd as the current user. Requires independent JARVIS_ENABLE_TERMINAL=1 and approval every time. NOT a sandbox: commands can access user files/network. No wrapper shell interpolation, but explicitly approving a shell with script args allows scripts. No inherited Gateway/local/integration secrets. 30-second/32-KiB output limits; cancellation terminates the process group. Background jobs are not supported. Arguments/output may enter model context; do not pass secrets. Nonzero exit, timeout, truncation, or cancellation is not success.",
  inputSchema: terminalInputSchema, approval: always(), availableInSubagents: false,
  async execute(input, ctx) { return runTerminal(input, ctx.abortSignal); },
});
