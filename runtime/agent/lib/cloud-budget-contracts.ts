import { z } from "zod";

export const CLOUD_MODEL_BUDGET_VERSION = 1;
export const CLOUD_MODEL_MAX_PROMPT_BYTES = 96 * 1_024;
export const CLOUD_MODEL_MAX_OUTPUT_TOKENS = 4_096;
export const CLOUD_MODEL_MAX_CALL_MS = 120_000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const ModelReservationInput = z.strictObject({
  version: z.literal(1), callId: id, model: z.string().min(1).max(160),
  promptBytes: z.number().int().min(1).max(CLOUD_MODEL_MAX_PROMPT_BYTES),
  maxOutputTokens: z.number().int().positive().max(CLOUD_MODEL_MAX_OUTPUT_TOKENS),
});
export const ModelReservationReply = z.strictObject({
  version: z.literal(1), callId: id, maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(), expiresAt: z.string().datetime(),
});
export const ModelSettlementInput = z.discriminatedUnion("accounting", [
  z.strictObject({ version: z.literal(1), callId: id, accounting: z.literal("unknown") }),
  z.strictObject({ version: z.literal(1), callId: id, accounting: z.literal("measured"),
    inputTokens: z.number().int().nonnegative().max(10_000_000),
    outputTokens: z.number().int().nonnegative().max(10_000_000),
    modelId: z.string().min(1).max(160), serviceTier: z.enum(["priority", "flex", "default"]).optional(),
  }),
]);
export const ModelSettlementReply = z.strictObject({ version: z.literal(1), callId: id, accounted: z.literal(true) });
/** A conservative text-only admission estimate, not a provider-enforced input
 * quota. Actual usage exceeding it is charged and fences subsequent calls. */
export function cloudInputTokenBound(promptBytes: number): number { return promptBytes * 2 + 8_192; }
