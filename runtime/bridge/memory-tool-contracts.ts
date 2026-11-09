import { z } from "zod";
import { KnowledgeId } from "./knowledge/contracts.ts";

export const ProposeMemoryToolSchema = z.strictObject({
  scope: z.enum(["global", "project"]),
  kind: z.enum(["preference", "fact", "goal", "person", "routine", "decision"]),
  text: z.string().trim().min(1).max(4000),
  confidence: z.number().finite().min(0).max(1).default(0.8),
  cloudAllowed: z.boolean().default(false),
  expiresAt: z.iso.datetime().nullable().default(null),
  sources: z.array(z.strictObject({ sourceVersionId: KnowledgeId, passageId: KnowledgeId.optional() })).max(10).default([]),
}).superRefine((input, ctx) => {
  if (input.scope === "global" && input.sources.length) ctx.addIssue({ code: "custom", message: "Project evidence cannot become global personal memory." });
});
