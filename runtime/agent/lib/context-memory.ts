import { setTimeout as delay } from "node:timers/promises";
import { defineMemoryProvider } from "eve/memory";
import { z } from "zod";
import { isValidLocalToken } from "./local-auth.ts";
import { readBoundedJson } from "../../bridge/harness-interactions/gateway.ts";

const RecallResponse = z.strictObject({ version: z.literal(1), content: z.string().max(128_000) });
export const CONTEXT_RECALL_ID = "jarvis-context-v1";

/** One replaceable recall slot, never one immortal message per remembered fact.
 * Project identity and the query come from the bridge's admitted task, not the model.
 * No capture hook: conversation text cannot silently become personal memory. */
export function contextMemoryProvider(fetcher: typeof fetch = fetch) {
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        if (ctx.session.parent != null) return { messages: [{ id: CONTEXT_RECALL_ID, content: "No personal context is available to delegated sessions." }] };
        const token = process.env.JARVIS_LOCAL_TOKEN;
        if (!isValidLocalToken(token)) throw new Error("Local context authentication unavailable.");
        const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(15_000)]);
        // A new Eve session can start recall just before its create receipt is
        // durably bound by the bridge. Retry only that narrow, read-only race.
        for (let attempt = 0; attempt < 8; attempt++) {
          signal.throwIfAborted();
          const response = await fetcher("http://127.0.0.1:39202/v1/context/current", {
            method: "POST", redirect: "error", signal,
            headers: { authorization: `Bearer ${token}`, "x-jarvis-eve-session": ctx.session.id, "content-type": "application/json" },
            body: "{}",
          });
          if (response.status === 425 && attempt < 7) {
            await response.body?.cancel();
            await delay(50 * (attempt + 1), undefined, { signal });
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Scoped context recall refused (HTTP ${response.status}). Previous recall must not be reused.`);
          }
          const result = RecallResponse.parse(await readBoundedJson(response, signal, 192 * 1_024));
          // Always replace, including when every memory was deleted or revoked.
          return { messages: [{ id: CONTEXT_RECALL_ID, content: result.content }] };
        }
        throw new Error("The assistant session is not ready for scoped recall.");
      },
    },
  });
}
