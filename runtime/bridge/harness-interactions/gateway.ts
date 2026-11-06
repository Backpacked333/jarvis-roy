import type { AuthorModel, PlanAuthorOptions } from "../harness-contracts/service.ts";

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const MAX_RESPONSE_BYTES = 256 * 1_024;

export async function readBoundedJson(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Response exceeds byte limit");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class GatewayError extends Error {
  readonly dispatched: boolean;
  constructor(message: string, dispatched: boolean) { super(message); this.dispatched = dispatched; }
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createGatewayAuthorModel(options: Pick<PlanAuthorOptions, "model" | "fetch">): AuthorModel {
  if (!/^[a-z0-9-]+\/[a-zA-Z0-9._:-]+$/.test(options.model)) throw new Error("An explicit Gateway model ID is required");
  const request = options.fetch ?? fetch;
  return {
    async complete(input) {
      const key = process.env.AI_GATEWAY_API_KEY;
      if (!key || /\s/.test(key)) throw new GatewayError("AI Gateway credential unavailable", false);
      input.signal.throwIfAborted();
      let response: Response;
      try {
        response = await request(ENDPOINT, {
          method: "POST", redirect: "error", signal: input.signal,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: options.model, stream: false, max_tokens: input.maxOutputTokens,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }] }),
        });
      } catch { throw new GatewayError("AI Gateway request failed or was cancelled; usage is unknown", true); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new GatewayError(`AI Gateway returned HTTP ${response.status}; no automatic retry`, true);
      }
      let result: any;
      try { result = await readBoundedJson(response, input.signal); }
      catch { throw new GatewayError("AI Gateway response unreadable or over limit; usage is unknown", true); }
      const choice = result?.choices?.[0];
      if (result?.choices?.length !== 1 || choice?.finish_reason !== "stop" ||
          typeof choice?.message?.content !== "string" || choice.message.tool_calls?.length || choice.message.refusal) {
        throw new GatewayError("AI Gateway did not return a complete text-only plan response", true);
      }
      return { text: choice.message.content,
        inputTokens: tokenCount(result?.usage?.prompt_tokens), outputTokens: tokenCount(result?.usage?.completion_tokens) };
    },
  };
}
