import { z } from "zod";
import { BridgeError } from "../errors.ts";
import { ActionRefSchema, AssistantIdSchema, NativeConfirmationEventSchema } from "./contracts.ts";
import { AssistantCoordinator, type NativeRequestContext } from "./coordinator.ts";

const ProposalInput = z.strictObject({ turnId: AssistantIdSchema, action: ActionRefSchema });
const NativeInput = z.strictObject({ event: NativeConfirmationEventSchema, appActive: z.boolean(), sessionUnlocked: z.boolean() });
export interface AssistantRouteResult { status: number; body: unknown }

/** Called only after the bridge's loopback/bearer/Origin checks and stop fence.
 * The context must come from header authentication, never the parsed body. */
export async function assistantRoute(method: string, url: URL | string, body: unknown, coordinator: AssistantCoordinator,
  context: NativeRequestContext = { nativeAuthenticated: false }): Promise<AssistantRouteResult> {
  const parsed = typeof url === "string" ? new URL(url, "http://127.0.0.1") : url;
  const path = parsed.pathname;
  if (path === "/v1/assistant/state" && method === "GET") return { status: 200, body: coordinator.state() };
  if (path === "/v1/assistant/events" && method === "GET") {
    const after = parsed.searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(after)) throw new BridgeError("Invalid assistant event cursor.", 400);
    return { status: 200, body: coordinator.eventsAfter(Number(after)) };
  }
  if (path === "/v1/assistant/sessions" && method === "POST") return { status: 201, body: await coordinator.createSession(body) };
  if (path === "/v1/assistant/native-events" && method === "POST") {
    const input = NativeInput.parse(body);
    return { status: 200, body: await coordinator.nativeEvent(input.event, input, context) };
  }
  const draft = /^\/v1\/assistant\/presentations\/([^/]+)$/.exec(path);
  if (draft && method === "PATCH") {
    if (!context.nativeAuthenticated) throw new BridgeError("Native draft editing required.", 403);
    return { status: 200, body: await coordinator.editDraft(AssistantIdSchema.parse(decodeURIComponent(draft[1])), body) };
  }
  const match = /^\/v1\/assistant\/sessions\/([^/]+)\/(focus|turns|proposals|invalidate-confirmations)$/.exec(path);
  if (match && method === "POST") {
    const id = AssistantIdSchema.parse(decodeURIComponent(match[1]));
    if (match[2] === "focus") return { status: 200, body: await coordinator.updateFocus(id, body) };
    if (match[2] === "turns") return { status: 202, body: await coordinator.submitTurn(id, body) };
    if (match[2] === "proposals") {
      const input = ProposalInput.parse(body);
      return { status: 201, body: await coordinator.proposeAction(id, input.turnId, input.action, context) };
    }
    // Cancellation is available to all authenticated clients; authority cannot be gained.
    await coordinator.invalidateConfirmations(id); return { status: 200, body: { invalidated: true } };
  }
  throw new BridgeError("Assistant route not found.", 404);
}
