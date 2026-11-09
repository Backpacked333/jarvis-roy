import { z } from "zod";

export const KNOWLEDGE_VERSION = 1 as const;
export const MAX_IMPORT_BYTES = 8 * 1_024 * 1_024;
export const MAX_EXTRACTED_CHARACTERS = 1_000_000;
export const KnowledgeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const text = (limit: number) => z.string().trim().min(1).max(limit);
export const PurposeSchema = z.enum(["local", "cloud"]);
export const ResourceKindSchema = z.enum(["file", "folder", "window", "calendar", "mail_account"]);
export const ReadOperationSchema = z.enum(["read_document", "inspect_window", "read_calendar", "read_mail"]);
export const GrantInputSchema = z.strictObject({
  projectId: KnowledgeId, resourceKind: ResourceKindSchema, resourceId: text(1_024), label: text(240),
  operations: z.array(ReadOperationSchema).min(1).max(4), cloudAllowed: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
}).superRefine((value, ctx) => {
  const operation = { file: "read_document", folder: "read_document", window: "inspect_window", calendar: "read_calendar", mail_account: "read_mail" }[value.resourceKind];
  if (new Set(value.operations).size !== 1 || value.operations[0] !== operation) ctx.addIssue({ code: "custom", message: "Grant operations must match the exact resource kind" });
});
export const ReadGrantSchema = GrantInputSchema.safeExtend({
  version: z.literal(1), id: KnowledgeId, revision: z.number().int().positive(), createdAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(),
});
export type ReadGrant = z.infer<typeof ReadGrantSchema>;
export type GrantInput = z.infer<typeof GrantInputSchema>;
export const ImportSourceSchema = z.strictObject({
  projectId: KnowledgeId, grantId: KnowledgeId, resourceId: text(1_024),
  filename: text(240).refine(name => !/[\\/\x00-\x1f]/.test(name) && name !== "." && name !== "..", "Use a filename, not a path"),
  title: text(240), mediaType: text(120), bytesBase64: z.string().min(4).max(Math.ceil(MAX_IMPORT_BYTES / 3) * 4),
  sourceId: KnowledgeId.optional(),
  // Supplied only by the authenticated native import route after PDFKit extraction.
  nativePDFPages: z.array(z.string().max(MAX_EXTRACTED_CHARACTERS)).min(1).max(2_000).optional(),
});
export type ImportSource = z.infer<typeof ImportSourceSchema>;
export const SourceVersionSchema = z.strictObject({
  version: z.literal(1), id: KnowledgeId, sourceId: KnowledgeId, revision: z.number().int().positive(), projectId: KnowledgeId,
  title: text(240), filename: z.string().max(240), mediaType: text(120), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(),
  visibility: z.enum(["private", "public"]), grantId: KnowledgeId.nullable(), resourceId: z.string().max(1_024).nullable(),
  kind: z.enum(["document", "web", "metadata"]), url: z.string().max(2_000).nullable(), createdAt: z.iso.datetime(),
  extraction: z.enum(["text", "pdf_text", "metadata_only", "empty", "truncated"]), archived: z.boolean(),
});
export type SourceVersion = z.infer<typeof SourceVersionSchema>;
export const EvidencePassageSchema = z.strictObject({
  id: KnowledgeId, sourceVersionId: KnowledgeId, projectId: KnowledgeId, ordinal: z.number().int().nonnegative(),
  text: z.string().max(8_000), locator: z.strictObject({ page: z.number().int().positive().nullable(), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive() }),
});
export type EvidencePassage = z.infer<typeof EvidencePassageSchema>;
export const SearchInputSchema = z.strictObject({
  projectId: KnowledgeId, query: text(1_000), purpose: PurposeSchema, limit: z.number().int().min(1).max(30).default(10), includeArchived: z.boolean().default(false),
});
export const RetrieveInputSchema = z.strictObject({
  projectId: KnowledgeId, provider: z.enum(["tavily", "arxiv", "crossref"]), query: text(400), maxResults: z.number().int().min(1).max(5).default(5),
});
export type RetrieveInput = z.infer<typeof RetrieveInputSchema>;
export const CitationSchema = z.strictObject({ passageId: KnowledgeId, quote: text(2_000) });
export const DeliverableInputSchema = z.strictObject({
  projectId: KnowledgeId, title: text(240), markdown: text(100_000),
  claims: z.array(z.strictObject({ text: text(4_000), citations: z.array(CitationSchema).max(20), status: z.enum(["supported", "inference", "unresolved"]) })).max(100),
  unresolved: z.array(text(2_000)).max(50),
  checks: z.array(z.strictObject({ description: text(2_000), result: z.enum(["passed", "failed", "unrun"]), artifactId: KnowledgeId.nullable() })).max(50),
});
export type DeliverableInput = z.infer<typeof DeliverableInputSchema>;
export interface ResearchDeliverable extends DeliverableInput {
  version: 1; id: string; createdAt: string;
  sourceVersionIds: string[];
  citationCheck: "locators_and_quotes_verified";
  critique: "requires_review";
  checkAuthority: "reported_not_independently_verified";
}
