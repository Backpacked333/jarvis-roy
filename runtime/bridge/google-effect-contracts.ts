import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "./harness-contracts/validation.ts";
import { GoogleActionInputSchema } from "./integrations/google.ts";

export { GoogleActionInputSchema };
export const GoogleEffectReceiptSchema = z.strictObject({
  version: z.literal(1), interactionId: z.string().min(1).max(200), revision: z.number().int().positive(),
  callId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), projectId: z.string().min(1).max(96),
  toolName: z.literal("google_action"), argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(), callStarted: z.boolean(),
  status: z.enum(["pending", "submitting", "approved", "dispatching", "succeeded", "unknown", "revoked"]),
});
export type GoogleEffectReceipt = z.infer<typeof GoogleEffectReceiptSchema>;
export function googleEffectBinding(raw: unknown) {
  const input = GoogleActionInputSchema.parse(raw), exactArguments = canonicalJson(input);
  return { input, exactArguments, digest: createHash("sha256").update(exactArguments).digest("hex") };
}
export const ExecuteGoogleEffectSchema = z.strictObject({ callId: z.string().min(1).max(200), input: GoogleActionInputSchema });
