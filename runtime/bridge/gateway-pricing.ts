import { z } from "zod";

export interface GatewayPrices { input: number; output: number }

// Gateway catalog rates are USD per token. Reject malformed numbers, unknown
// charges and underflow rather than turning unsupported prices into free calls.
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
  // Neither adapter requests provider-hosted search, maps or image generation.
  web_search: z.unknown().optional(), maps_search: z.unknown().optional(), image: z.unknown().optional(),
});
const CatalogSchema = z.object({
  data: z.array(z.object({ id: z.string(), type: z.string(), pricing: z.unknown() })).max(10_000),
});

export function gatewayPrices(catalog: unknown, model: string): GatewayPrices {
  const matches = CatalogSchema.parse(catalog).data.filter((entry) => entry.id === model && entry.type === "language");
  if (matches.length !== 1) throw new Error("Model pricing must identify one language model");
  const pricing = PricingSchema.parse(matches[0].pricing);
  const cards = [pricing, ...Object.values(pricing.service_tiers ?? {}), ...Object.values(pricing.regional ?? {}),
    ...(pricing.fast ? [pricing.fast] : [])];
  return {
    input: Math.max(...cards.flatMap((card) => [card.input, card.input_cache_read ?? 0, card.input_cache_write ?? 0,
      ...[...(card.input_tiers ?? []), ...(card.input_cache_read_tiers ?? []), ...(card.input_cache_write_tiers ?? [])].map((tier) => tier.cost)])),
    output: Math.max(...cards.flatMap((card) => [card.output, ...(card.output_tiers ?? []).map((tier) => tier.cost)])),
  };
}

export function matchesPricedModel(requested: string, response: unknown): boolean {
  if (typeof response !== "object" || response === null || Array.isArray(response)) return false;
  const { model, service_tier } = response as Record<string, unknown>;
  // Gateway reports OpenAI fast aliases as their exact base model with priority.
  return model === requested || (requested.startsWith("openai/") && requested.endsWith("-fast") &&
    model === requested.slice(0, -5) && service_tier === "priority");
}
