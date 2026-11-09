import { z } from "zod";
import { runNativeHelper, type NativeHelperOptions } from "../agent/lib/native-helper.ts";
import {
  EMBEDDING_BATCH_BYTES, EMBEDDING_BATCH_TEXTS, EMBEDDING_TEXT_BYTES, normalizedVector,
  type EmbeddingIdentity, type LocalEmbeddingProvider,
} from "./knowledge/embeddings.ts";

const languages = ["en", "de", "fr", "es", "it", "pt", "nl", "ru", "zh-Hans", "zh-Hant", "ja", "ko"] as const;
const languageSchema = z.enum(languages);
const modelSchema = z.strictObject({
  id: z.string().max(200), version: z.string().max(200), dimensions: z.number().int().min(1).max(4096),
  language: languageSchema, revision: z.number().int().nonnegative(),
  osVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/), local: z.literal(true),
}).refine(model => model.id === `apple-nl-sentence.${model.language}` &&
  model.version === `macos-${model.osVersion}-revision-${model.revision}`);
const resultSchema = z.discriminatedUnion("status", [
  z.strictObject({ kind: z.literal("sentence_embeddings"), status: z.literal("available"), model: modelSchema,
    vectors: z.array(z.array(z.number().finite()).min(1).max(4096)).max(EMBEDDING_BATCH_TEXTS) }),
  z.strictObject({ kind: z.literal("sentence_embeddings"), status: z.literal("unavailable"),
    reason: z.literal("model_unavailable"), language: languageSchema, local: z.literal(true) }),
]);
const envelopeSchema = z.strictObject({ ok: z.literal(true), result: resultSchema });
type Model = z.infer<typeof modelSchema>;
export interface MacEmbeddingOptions extends NativeHelperOptions { language?: typeof languages[number] }
export type MacEmbeddingAvailability =
  | { status: "available"; provider: LocalEmbeddingProvider; identity: EmbeddingIdentity }
  | { status: "unavailable"; fallback: "lexical";
      reason: "disabled" | "unsupported_platform" | "model_unavailable" | "helper_unavailable" | "invalid_response" };

export class LocalEmbeddingError extends Error {
  readonly code: "invalid_input" | "unavailable" | "model_changed" | "invalid_response" | "queue_full";
  constructor(code: LocalEmbeddingError["code"]) {
    super({ invalid_input: "Local embedding input exceeds its validated bounds.",
      unavailable: "The on-device embedding model is unavailable; use lexical retrieval.",
      model_changed: "The local embedding model changed; reindex before semantic retrieval.",
      invalid_response: "The local embedding response was invalid; use lexical retrieval.",
      queue_full: "The bounded local embedding queue is full; use lexical retrieval or retry later." }[code]);
    this.name = "LocalEmbeddingError"; this.code = code;
  }
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Local semantic request was cancelled.", "AbortError");
}
type EmbeddingVectors = readonly (readonly number[])[];
interface EmbeddingJob {
  run: () => Promise<EmbeddingVectors>;
  signal?: AbortSignal;
  resolve: (vectors: EmbeddingVectors) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
/** One provider is shared by knowledge and memory. Queue only this provider's
 * work; runNativeHelper retains its own per-process authority for each batch. */
class EmbeddingQueue {
  private active = false;
  private readonly pending: EmbeddingJob[] = [];

  run(operation: () => Promise<EmbeddingVectors>, signal?: AbortSignal): Promise<EmbeddingVectors> {
    cancelled(signal);
    if (this.active && this.pending.length >= 8) throw new LocalEmbeddingError("queue_full");
    return new Promise((resolve, reject) => {
      const job: EmbeddingJob = { run: operation, signal, resolve, reject, abort: () => {
        const index = this.pending.indexOf(job);
        if (index < 0) return;
        this.pending.splice(index, 1);
        signal?.removeEventListener("abort", job.abort);
        reject(new DOMException("Local semantic request was cancelled.", "AbortError"));
      } };
      this.pending.push(job);
      signal?.addEventListener("abort", job.abort, { once: true });
      if (signal?.aborted) job.abort();
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const job = this.pending.shift();
    if (!job) return;
    job.signal?.removeEventListener("abort", job.abort);
    this.active = true;
    Promise.resolve().then(() => { cancelled(job.signal); return job.run(); })
      .then(job.resolve, job.reject).finally(() => { this.active = false; this.drain(); });
  }
}
function sameModel(left: Model, right: Model): boolean {
  return left.id === right.id && left.version === right.version && left.dimensions === right.dimensions &&
    left.language === right.language && left.revision === right.revision && left.osVersion === right.osVersion;
}
async function request(texts: readonly string[], language: typeof languages[number], options: MacEmbeddingOptions, signal?: AbortSignal) {
  cancelled(signal);
  let raw: unknown;
  try { raw = await runNativeHelper({ operation: "sentence_embeddings", embeddingLanguage: language, texts }, signal, options, "embedding"); }
  catch { cancelled(signal); throw new LocalEmbeddingError("unavailable"); }
  cancelled(signal);
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new LocalEmbeddingError("invalid_response");
  const result = parsed.data.result;
  if ((result.status === "available" ? result.model.language : result.language) !== language) throw new LocalEmbeddingError("invalid_response");
  return result;
}

/** Bounded local IPC only. No HTTP client, model download, or cloud fallback. */
export async function createMacEmbeddingProvider(options: MacEmbeddingOptions = {}, signal?: AbortSignal): Promise<MacEmbeddingAvailability> {
  cancelled(signal);
  const environment = options.environment ?? process.env;
  if (environment.JARVIS_ENABLE_SEMANTIC_RETRIEVAL !== "1") return { status: "unavailable", reason: "disabled", fallback: "lexical" };
  if ((options.platform ?? process.platform) !== "darwin") return { status: "unavailable", reason: "unsupported_platform", fallback: "lexical" };
  const language = options.language ?? "en";
  if (!languageSchema.safeParse(language).success) return { status: "unavailable", reason: "invalid_response", fallback: "lexical" };
  let discovered: Awaited<ReturnType<typeof request>>;
  try { discovered = await request([], language, options, signal); }
  catch (error) {
    cancelled(signal);
    return { status: "unavailable", reason: error instanceof LocalEmbeddingError && error.code === "invalid_response" ? "invalid_response" : "helper_unavailable", fallback: "lexical" };
  }
  if (discovered.status === "unavailable") return { status: "unavailable", reason: "model_unavailable", fallback: "lexical" };
  if (discovered.vectors.length !== 0) return { status: "unavailable", reason: "invalid_response", fallback: "lexical" };
  const model = Object.freeze(discovered.model);
  const identity: EmbeddingIdentity = Object.freeze({ id: model.id, version: model.version, dimensions: model.dimensions, local: true });
  const queue = new EmbeddingQueue();
  const provider: LocalEmbeddingProvider = Object.freeze({ identity,
    async embed(texts: readonly string[], { signal }: { signal?: AbortSignal }): Promise<readonly (readonly number[])[]> {
      cancelled(signal);
      if (!Array.isArray(texts) || texts.length > EMBEDDING_BATCH_TEXTS || texts.some(text => typeof text !== "string" ||
        !text.trim() || Buffer.byteLength(text) > EMBEDDING_TEXT_BYTES) ||
        texts.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > EMBEDDING_BATCH_BYTES) throw new LocalEmbeddingError("invalid_input");
      // Copy validated inputs before yielding: queued work cannot be retargeted by
      // a caller mutating its array while another project's embed is in flight.
      const capturedTexts = [...texts];
      if (!capturedTexts.length) return [];
      return queue.run(async () => {
        cancelled(signal);
        const vectors: number[][] = [];
        // Bound serialized output and escaped JSON input independently of raw text.
        const maximumTexts = Math.min(EMBEDDING_BATCH_TEXTS, Math.floor(16_384 / model.dimensions));
        let offset = 0;
        while (offset < capturedTexts.length) {
          let batch = capturedTexts.slice(offset, offset + maximumTexts);
          while (batch.length && Buffer.byteLength(JSON.stringify({ version: 1, operation: "sentence_embeddings", embeddingLanguage: language, texts: batch })) > 65_536) {
            batch = batch.slice(0, -1);
          }
          if (!batch.length) throw new LocalEmbeddingError("invalid_input");
          const result = await request(batch, language, options, signal);
          if (result.status === "unavailable") throw new LocalEmbeddingError("unavailable");
          if (!sameModel(model, result.model)) throw new LocalEmbeddingError("model_changed");
          if (result.vectors.length !== batch.length || result.vectors.some(vector => vector.length !== model.dimensions ||
              Math.abs(Math.hypot(...vector) - 1) > 1e-5)) throw new LocalEmbeddingError("invalid_response");
          vectors.push(...result.vectors.map(vector => normalizedVector(vector, model.dimensions)));
          offset += batch.length;
        }
        cancelled(signal);
        return vectors;
      }, signal);
    },
  });
  return { status: "available", provider, identity };
}
