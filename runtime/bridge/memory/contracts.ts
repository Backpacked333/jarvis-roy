import { z } from "zod";

export const MEMORY_VERSION = 1 as const;
export const MemoryIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const MemoryScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: MemoryIdSchema }),
]);
export const MemoryReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("knowledge"), projectId: MemoryIdSchema, sourceVersionId: MemoryIdSchema, passageId: MemoryIdSchema.optional() }),
  z.strictObject({ type: z.literal("conversation"), projectId: MemoryIdSchema.nullable(), conversationId: MemoryIdSchema, turnId: MemoryIdSchema.optional() }),
  z.strictObject({ type: z.literal("legacy"), memoryId: MemoryIdSchema }),
]);
export const MemoryAssertionSchema = z.strictObject({
  entityId: MemoryIdSchema, property: z.string().trim().min(1).max(120), value: z.string().trim().min(1).max(2000),
  validFrom: z.iso.datetime().nullable(), validTo: z.iso.datetime().nullable(), observedAt: z.iso.datetime(),
}).superRefine((value, context) => {
  if (value.validFrom && value.validTo && Date.parse(value.validFrom) >= Date.parse(value.validTo)) context.addIssue({ code: "custom", message: "Assertion validity must be a nonempty interval" });
});
export const MemoryEntitySchema = z.strictObject({ version: z.literal(1), id: MemoryIdSchema, scope: MemoryScopeSchema,
  label: z.string().trim().min(1).max(240), aliases: z.array(z.string().trim().min(1).max(240)).max(30),
  revision: z.number().int().positive(), updatedAt: z.iso.datetime(),
});
export const MemoryEntityInputSchema = MemoryEntitySchema.pick({ scope: true, label: true, aliases: true });
export const MemoryInputSchema = z.strictObject({
  kind: z.enum(["preference", "fact", "goal", "person", "routine", "decision"]),
  scope: MemoryScopeSchema,
  text: z.string().trim().min(1).max(4000),
  provenance: z.strictObject({ origin: z.enum(["explicit_user", "inferred"]), references: z.array(MemoryReferenceSchema).max(20) }),
  confidence: z.number().finite().min(0).max(1),
  pinned: z.boolean(), expiresAt: z.iso.datetime().nullable(), cloudAllowed: z.boolean(),
  assertion: MemoryAssertionSchema.optional(),
}).superRefine((entry, context) => {
  for (const ref of entry.provenance.references) {
    if (ref.type !== "legacy" && ref.projectId !== null && (entry.scope.kind !== "project" || ref.projectId !== entry.scope.projectId)) {
      context.addIssue({ code: "custom", message: "Project provenance must stay in that exact project scope" });
    }
  }
});
export const MemoryEntrySchema = MemoryInputSchema.safeExtend({
  version: z.literal(1), id: MemoryIdSchema, revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["proposed", "active", "superseded", "archived"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), supersededBy: MemoryIdSchema.nullable(),
});
export const MemoryRevisionSchema = z.strictObject({ expectedRevision: z.number().int().positive() });
export const MemoryApprovalSchema = MemoryRevisionSchema.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const MemoryUpdateSchema = MemoryRevisionSchema.extend({ input: MemoryInputSchema });
export const MemorySupersedeSchema = MemoryRevisionSchema.extend({ replacementId: MemoryIdSchema, replacementRevision: z.number().int().positive() });
export const MemoryRecallSchema = z.strictObject({
  projectId: MemoryIdSchema.nullable(), purpose: z.enum(["local", "cloud"]),
  query: z.string().trim().min(1).max(1000), limit: z.number().int().min(1).max(30).default(10),
  asOf: z.iso.datetime().optional(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type MemoryReference = z.infer<typeof MemoryReferenceSchema>;
export type MemoryRecall = z.infer<typeof MemoryRecallSchema>;
export interface MemoryMatch { entry: MemoryEntry; score: number; reasons: string[] }
export interface MemoryContext { nativeAuthenticated: boolean; projectId?: string | null }
