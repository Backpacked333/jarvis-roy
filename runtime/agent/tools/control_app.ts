import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { controlApp, controlInputSchema } from "../lib/desktop.ts";

export default defineTool({
  description: "After approval, focus an installed macOS app or click (AXPress), set_text, or press_key on an explicit observed accessible control. Requires desktop opt-in and Accessibility permission. Non-focus actions require a fresh observation, unchanged tree, same process, and frontmost app; stale targets are refused, never coordinate-clicked. Secure controls are refused. Exact text/key is approved; sensitive text enters model context. Actions can have irreversible effects; app compatibility is not guaranteed.",
  inputSchema: controlInputSchema, approval: always(), availableInSubagents: false,
  async execute(input, ctx) { return controlApp(input, ctx.session.id, ctx.abortSignal); },
});
