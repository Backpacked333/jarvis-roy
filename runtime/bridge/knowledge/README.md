# Local retrieval and model provisioning

Knowledge uses lexical search immediately. Source and memory embeddings are indexed
in bounded background batches; a normal turn performs query encoding and reads the
existing index. SQLite-vector distance calculation is exact over up to 100,000
authorized indexed source passages. Larger corpora fall back to the bounded JavaScript
scan with partial-coverage diagnostics. Temporal memory currently scans at most 512
eligible cached entries. The 150 labeled retrieval fixtures test deterministic retrieval
contracts; they do not establish live multilingual E5 quality.

The Linux CPU adapter is pinned to `intfloat/multilingual-e5-base` (768 dimensions),
with the reviewed ONNX conversion `Xenova/multilingual-e5-base`. It uses `query: ` and
`passage: ` prefixes, mean pooling, normalized vectors, and local q8 CPU inference.
Apple and E5 index identities are separate. A changed model/configuration has a new
cache key; vectors from another model are never reused.

## Provision the encoder before enabling it

1. On a machine that can access the model repository, choose and review exact 40-hex
   commits for both the upstream model and the ONNX conversion. Review the conversion
   recipe/toolchain and record the SHA-256 of that recipe. A repository name or mutable
   branch such as `main` is insufficient provenance.
2. Copy the following regular files from the reviewed conversion to an absolute,
   nonsymlink directory owned by the operator. Do not use hard links or a directory
   writable by the bridge service:
   `config.json`, `tokenizer.json`, `tokenizer_config.json`,
   `onnx/model_quantized.onnx`.
3. Write `manifest.json` using this structure. Replace every uppercase placeholder
   with the reviewed value; placeholder manifests deliberately fail validation.

```json
{
  "version": 1,
  "model": "intfloat/multilingual-e5-base",
  "revision": "UPSTREAM_40_HEX_COMMIT",
  "dimensions": 768,
  "conversion": {
    "model": "Xenova/multilingual-e5-base",
    "revision": "CONVERSION_40_HEX_COMMIT",
    "toolchain": "REVIEWED_CONVERSION_TOOLCHAIN_AND_VERSION",
    "recipeSha256": "REVIEWED_RECIPE_64_HEX_SHA256"
  },
  "files": {
    "config.json": "64_HEX_SHA256",
    "tokenizer.json": "64_HEX_SHA256",
    "tokenizer_config.json": "64_HEX_SHA256",
    "onnx/model_quantized.onnx": "64_HEX_SHA256"
  }
}
```

4. Install runtime dependencies using `ONNXRUNTIME_NODE_INSTALL=skip npm ci` from
   `runtime/`. This selects the packaged CPU execution path and skips the optional
   CUDA installation download. Set `JARVIS_E5_MODEL_DIR` to the model directory.
5. Verify the manifest and files without loading the encoder, from `runtime/`:

```sh
node --input-type=module -e 'import { verifyE5Files } from "./bridge/knowledge/linux-embeddings.ts"; const result = await verifyE5Files(process.env.JARVIS_E5_MODEL_DIR); console.log({ model: result.manifest.model, dimensions: result.manifest.dimensions, identityDigest: result.digest });'
```

6. Enable `JARVIS_ENABLE_SEMANTIC_RETRIEVAL=1` and restart the bridge. Inspect its
   embedding status before running the fixed retrieval evaluation. Missing files,
   bad checksums, unavailable native execution, or incompatible dimensions report a
   lexical fallback. The adapter never downloads weights during startup or a turn.

No vetted model artifact is bundled in this repository. The implementation environment
could not retrieve the model repository (HTTP 403), so live encoder loading, multilingual
ranking quality, and production latency remain unverified. Do not substitute guessed
commit hashes or conversion provenance to make setup appear complete.

## Permission and cancellation boundaries

Queued and newly returned source or memory context is reauthorized against current
project, revision, expiry and disclosure settings. Google retained account context and
selected cloud snapshots use their own gateway authority; no replacement local grant
is fabricated. Final cloud disclosure awaits fresh remote authorization. Revocation
cannot retract content already sent to a reasoning provider. Cancellation suppresses
late inference results; an already running native CPU inference kernel may finish in
the background before its provider queue becomes available again.
