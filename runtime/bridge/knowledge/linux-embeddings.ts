import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizedVector, type LocalEmbeddingProvider } from "./embeddings.ts";

const files = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"] as const;
export const E5ManifestSchema = z.strictObject({ version: z.literal(1), model: z.literal("intfloat/multilingual-e5-base"),
  revision: z.string().regex(/^[a-f0-9]{40}$/), dimensions: z.literal(768),
  conversion: z.strictObject({ model: z.literal("Xenova/multilingual-e5-base"), revision: z.string().regex(/^[a-f0-9]{40}$/),
    toolchain: z.string().min(1).max(240), recipeSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  files: z.strictObject(Object.fromEntries(files.map(file => [file, z.string().regex(/^[a-f0-9]{64}$/)])) as Record<typeof files[number], z.ZodString>),
});
export async function verifyE5Files(directory: string) {
  const root = await realpath(directory);
  if (root !== path.resolve(directory)) throw new Error("Model directory must be a real absolute directory");
  const manifestFile = path.join(root, "manifest.json"), info = await lstat(manifestFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16000) throw new Error("Invalid pinned model manifest");
  const manifest = E5ManifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  for (const file of files) {
    const location = path.join(root, file), info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 512 * 1024 * 1024 || await realpath(location) !== location) throw new Error("Invalid local model artifact");
    if (createHash("sha256").update(await readFile(location)).digest("hex") !== manifest.files[file]) throw new Error("Model artifact checksum mismatch");
  }
  return { root, manifest, digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}
/** CPU inference only. Provision reviewed files beforehand; model downloads are
 * disabled globally before loading Transformers and cannot occur during a turn. */
export async function createLinuxEmbeddingProvider(options: { enabled?: boolean; directory?: string } = {}): Promise<
  { status: "available"; provider: LocalEmbeddingProvider } | { status: "unavailable"; fallback: "lexical"; reason: string }> {
  if (!(options.enabled ?? process.env.JARVIS_ENABLE_SEMANTIC_RETRIEVAL === "1")) return { status: "unavailable", fallback: "lexical", reason: "disabled" };
  if (process.platform !== "linux") return { status: "unavailable", fallback: "lexical", reason: "unsupported_platform" };
  const directory = options.directory ?? process.env.JARVIS_E5_MODEL_DIR;
  if (!directory) return { status: "unavailable", fallback: "lexical", reason: "model_not_provisioned" };
  try {
    const verified = await verifyE5Files(directory);
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false;
    const extractor = await pipeline("feature-extraction", verified.root, { local_files_only: true, dtype: "q8", device: "cpu" });
    const identity = { id: "intfloat/multilingual-e5-base-cpu", version: `${verified.manifest.revision}-${verified.digest.slice(0, 32)}-prefix-v1`, dimensions: 768, local: true as const };
    const provider: LocalEmbeddingProvider = { identity, async embed(texts, options) {
      options.signal?.throwIfAborted();
      if (!texts.length || texts.length > 16 || texts.some(text => Buffer.byteLength(text) > 16384) || texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 65536) throw new Error("Embedding batch limit exceeded");
      const prefix = options.purpose === "query" ? "query: " : "passage: ";
      const tensor = await extractor(texts.map(text => prefix + text), { pooling: "mean", normalize: true });
      options.signal?.throwIfAborted();
      return (tensor.tolist() as number[][]).map(vector => normalizedVector(vector, 768));
    } };
    return { status: "available", provider };
  } catch { return { status: "unavailable", fallback: "lexical", reason: "model_integrity_or_runtime_unavailable" }; }
}
