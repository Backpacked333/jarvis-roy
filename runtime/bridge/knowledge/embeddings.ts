import { createHash } from "node:crypto";
import { z } from "zod";

export const EmbeddingIdentitySchema = z.strictObject({
  id: z.string().min(1).max(200), version: z.string().min(1).max(200),
  dimensions: z.number().int().min(1).max(4096), local: z.literal(true),
});
export type EmbeddingIdentity = z.infer<typeof EmbeddingIdentitySchema>;

/** Trusted local implementation only. The adapter must never fetch embeddings or
 * silently change its model identity; callers pass private source text. */
export interface LocalEmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  embed(texts: readonly string[], options: { signal?: AbortSignal }): Promise<readonly (readonly number[])[]>;
}
export const EMBEDDING_BATCH_TEXTS = 16;
export const EMBEDDING_TEXT_BYTES = 16 * 1024;
export const EMBEDDING_BATCH_BYTES = 64 * 1024;
export function embeddingKey(identity: EmbeddingIdentity): string {
  const value = EmbeddingIdentitySchema.parse(identity);
  return createHash("sha256").update(JSON.stringify([value.id, value.version, value.dimensions, value.local])).digest("hex");
}
export function normalizedVector(vector: readonly number[], dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) throw new Error("Invalid local embedding dimensions or values");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error("Local embedding has no usable signal");
  return vector.map(value => value / norm);
}
export function encodeVector(vector: readonly number[]): Buffer {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}
export function decodeVector(bytes: Uint8Array, dimensions: number): number[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimensions * 4) throw new Error("Invalid cached local embedding");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return normalizedVector(Array.from({ length: dimensions }, (_, index) => buffer.readFloatLE(index * 4)), dimensions);
}
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error("Embedding model mismatch");
  return Math.max(-1, Math.min(1, left.reduce((sum, value, index) => sum + value * right[index], 0)));
}

// Conversational framing should not become an AND requirement for every passage.
const STOP_WORDS = new Set("a an and are as at be been being but by can could did do does for from had has have how i in into is it its me my of on or our please say show should so tell than that the their them there these they this those to us was were what when where which who why will with would you your about explain find information paper papers document documents according regarding".split(" "));
export function queryTerms(query: string): string[] {
  return [...new Set((query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? []).filter(term => !STOP_WORDS.has(term)))].slice(0, 32);
}
export function matchedTerms(text: string, terms: readonly string[]): string[] {
  const words = new Set(text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? []);
  return terms.filter(term => words.has(term));
}
