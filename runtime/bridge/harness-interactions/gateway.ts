import { z } from "zod";
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
  readonly unknownPrice: boolean;
  constructor(message: string, dispatched: boolean, unknownPrice = false) {
    super(message); this.dispatched = dispatched; this.unknownPrice = unknownPrice;
  }
}

// The catalog reports USD per token, not USD per million tokens.
const RateSchema = z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/)
  .refine((value) => Number(value) > 0 || /^0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(value))
  .transform(Number).pipe(z.number().finite().min(0).max(1));
const TiersSchema = z.array(z.object({ cost: RateSchema })).max(100).optional();
const RateCardSchema = z.strictObject({
  input: RateSchema, output: RateSchema, input_tiers: TiersSchema, output_tiers: TiersSchema,
  input_cache_read: RateSchema.optional(), input_cache_write: RateSchema.optional(),
  input_cache_read_tiers: TiersSchema, input_cache_write_tiers: TiersSchema,
});
const PricingSchema = RateCardSchema.extend({
  service_tiers: z.record(z.string(), RateCardSchema).optional(), fast: RateCardSchema.optional(),
  regional: z.record(z.string(), RateCardSchema).optional(), varies_by_provider: z.literal(false).optional(),
  // These features cannot be requested by this text-only, no-tool adapter.
  web_search: z.unknown().optional(), maps_search: z.unknown().optional(), image: z.unknown().optional(),
});
export interface AuthorPrices { input: number; output: number }
interface GatewayAuthorModel {
  prices(signal: AbortSignal): Promise<AuthorPrices>;
  complete(input: Parameters<AuthorModel["complete"]>[0], requirePricedModel?: boolean): ReturnType<AuthorModel["complete"]>;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createGatewayAuthorModel(options: Pick<PlanAuthorOptions, "model" | "fetch">): GatewayAuthorModel {
  if (!/^[a-z0-9-]+\/[a-zA-Z0-9._:-]+$/.test(options.model)) throw new Error("An explicit Gateway model ID is required");
  const request = options.fetch ?? fetch;
  return {
    async prices(signal) {
      try {
        signal.throwIfAborted();
        const response = await request("https://ai-gateway.vercel.sh/v1/models", { signal, redirect: "error" });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(); }
        const catalog = z.object({ data: z.array(z.object({ id: z.string(), type: z.string(), pricing: z.unknown() })).max(10_000) })
          .parse(await readBoundedJson(response, signal, 8_000_000));
        const matches = catalog.data.filter((entry) => entry.id === options.model && entry.type === "language");
        if (matches.length !== 1) throw new Error();
        const pricing = PricingSchema.parse(matches[0].pricing);
        const cards = [pricing, ...Object.values(pricing.service_tiers ?? {}), ...Object.values(pricing.regional ?? {}),
          ...(pricing.fast ? [pricing.fast] : [])];
        return {
          input: Math.max(...cards.flatMap((card) => [card.input, card.input_cache_read ?? 0, card.input_cache_write ?? 0,
            ...[...(card.input_tiers ?? []), ...(card.input_cache_read_tiers ?? []), ...(card.input_cache_write_tiers ?? [])].map((tier) => tier.cost)])),
          output: Math.max(...cards.flatMap((card) => [card.output, ...(card.output_tiers ?? []).map((tier) => tier.cost)])),
        };
      } catch { throw new GatewayError("Authoring model pricing unavailable or unsupported for estimated-dollar admission", false); }
    },
    async complete(input, requirePricedModel = false) {
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
      if (requirePricedModel && result?.model !== options.model) {
        throw new GatewayError("AI Gateway returned an unpriced or unidentified model; authoring cost is unknown", true, true);
      }
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
