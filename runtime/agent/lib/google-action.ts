import { setTimeout as delay } from "node:timers/promises";
import { isValidLocalToken } from "./local-auth.ts";
import { readBoundedJson } from "../../bridge/harness-interactions/gateway.ts";
import { GoogleActionInputSchema } from "../../bridge/google-effect-contracts.ts";

export async function executeApprovedGoogleAction(raw: unknown, context: {
  sessionId: string; callId: string; approved: boolean; delegated: boolean; signal: AbortSignal;
}, fetcher: typeof fetch = fetch): Promise<unknown> {
  if (!context.approved || context.delegated) throw new Error("Google effects require this root tool call's explicit Eve approval.");
  if (process.env.JARVIS_ENABLE_GOOGLE !== "1") throw new Error("Google integration is disabled.");
  const input = GoogleActionInputSchema.parse(raw), token = process.env.JARVIS_LOCAL_TOKEN;
  if (!isValidLocalToken(token)) throw new Error("Local bridge authentication unavailable.");
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
  for (let attempt = 0; attempt < 8; attempt++) {
    signal.throwIfAborted();
    const response = await fetcher("http://127.0.0.1:39202/v1/integrations/google/execute", {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "x-jarvis-eve-session": context.sessionId, "content-type": "application/json" },
      body: JSON.stringify({ callId: context.callId, input }),
    });
    if (response.status === 425 && attempt < 7) { await response.body?.cancel(); await delay(50 * (attempt + 1), undefined, { signal }); continue; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Google effect refused or uncertain (HTTP ${response.status}); do not automatically repeat this send or write.`); }
    return readBoundedJson(response, signal, 128_000);
  }
  throw new Error("Approved Google call observation is not ready. Inspect the original request before continuing.");
}
