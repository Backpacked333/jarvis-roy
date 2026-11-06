import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { controlApp, controlInputSchema, controlToolSchema } from "../lib/desktop.ts";

export default defineTool({
  description: "After approval, activate the explicitly named macOS app, then focus it or click (AXPress), set_text, or press_key on an observed accessible control. Requires desktop opt-in and Accessibility permission. Non-focus actions require observationId and elementId from a fresh inspect_app result, an unchanged tree, and the same process. set_text additionally requires text; press_key requires stroke and modifiers (use [] for none). Omit fields unrelated to the action. Activation restores focus after the approval card; the app must still be frontmost at execution. Stale/secure targets are refused, never coordinate-clicked. Exact text/key is approved; sensitive text enters model context. Actions can have irreversible effects; app compatibility is not guaranteed.",
  inputSchema: controlToolSchema, approval: always(), availableInSubagents: false,
  async execute(input, ctx) { return controlApp(controlInputSchema.parse(input), ctx.session.id, ctx.abortSignal); },
});
