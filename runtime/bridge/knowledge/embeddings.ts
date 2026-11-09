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
  embed(texts: readonly string[], options: { signal?: AbortSignal; purpose?: "query" | "document" }): Promise<readonly (readonly number[])[]>;
}
/** Share query work across source and memory recall without persisting queries.
 * Cancellation of one caller never cancels another authorized caller's request. */
export function sharedEmbeddingProvider(provider: LocalEmbeddingProvider): LocalEmbeddingProvider {
  const cache = new Map<string, { at: number; vector: readonly number[] }>();
  const pending = new Map<string, Promise<readonly (readonly number[])[]>>();
  type Job = { texts: readonly string[]; options: Parameters<LocalEmbeddingProvider["embed"]>[1]; resolve: (value: readonly (readonly number[])[]) => void; reject: (reason: unknown) => void; abort: () => void };
  const jobs: Job[] = []; let active = false;
  const drain = () => {
    if (active) return;
    jobs.sort((a, b) => Number(b.options.purpose === "query") - Number(a.options.purpose === "query"));
    const job = jobs.shift(); if (!job) return;
    job.options.signal?.removeEventListener("abort", job.abort);
    if (job.options.signal?.aborted) { job.reject(job.options.signal.reason); drain(); return; }
    active = true;
    Promise.resolve().then(() => provider.embed(job.texts, job.options)).then(job.resolve, job.reject).finally(() => { active = false; drain(); });
  };
  const scheduled = (texts: readonly string[], options: Parameters<LocalEmbeddingProvider["embed"]>[1]) => new Promise<readonly (readonly number[])[]>((resolve, reject) => {
    if (jobs.length >= 64) { reject(new Error("Local embedding queue is full")); return; }
    const job: Job = { texts, options, resolve, reject, abort: () => { const index = jobs.indexOf(job); if (index >= 0) jobs.splice(index, 1); reject(options.signal?.reason); } };
    options.signal?.throwIfAborted(); options.signal?.addEventListener("abort", job.abort, { once: true }); jobs.push(job); drain();
  });
  return { identity: provider.identity, async embed(texts, options) {
    options.signal?.throwIfAborted();
    if (options.purpose !== "query" || texts.length !== 1) return scheduled(texts, options);
    const key = createHash("sha256").update(`${embeddingKey(provider.identity)}\0${texts[0]}`).digest("hex");
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return [[...cached.vector]];
    let request = pending.get(key);
    if (!request) {
      request = scheduled(texts, { purpose: "query", signal: AbortSignal.timeout(2000) }).then(vectors => {
        if (vectors.length !== 1) throw new Error("Invalid query embedding batch");
        const vector = normalizedVector(vectors[0], provider.identity.dimensions);
        cache.set(key, { at: Date.now(), vector });
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
        return [vector];
      }).finally(() => pending.delete(key));
      pending.set(key, request);
    }
    if (!options.signal) return request;
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal!.reason);
      options.signal!.addEventListener("abort", abort, { once: true });
      request!.then(resolve, reject).finally(() => options.signal!.removeEventListener("abort", abort));
    });
  } };
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
