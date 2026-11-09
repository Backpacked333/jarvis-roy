import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLinuxEmbeddingProvider, verifyE5Files } from "../bridge/knowledge/linux-embeddings.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-model-manifest-")); await mkdir(path.join(directory, "onnx"));
  const files = Object.fromEntries(["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"].map(name => [name, createHash("sha256").update(`fixture bytes: ${name}`).digest("hex")]));
  for (const name of Object.keys(files)) await writeFile(path.join(directory, name), `fixture bytes: ${name}`);
  const manifest = { version: 1, model: "intfloat/multilingual-e5-base", revision: "a".repeat(40), dimensions: 768,
    conversion: { model: "Xenova/multilingual-e5-base", revision: "b".repeat(40), toolchain: "integrity-test fixture, not real model provenance", recipeSha256: "c".repeat(64) }, files };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest)); return { directory, manifest };
}
test("Linux encoder integrity verifies exact E5 manifest/files without loading fabricated fixture weights", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const verified = await verifyE5Files(f.directory); assert.equal(verified.manifest.dimensions, 768); assert.equal(verified.manifest.model, "intfloat/multilingual-e5-base");
  await writeFile(path.join(f.directory, "tokenizer.json"), "changed"); await assert.rejects(verifyE5Files(f.directory), /checksum mismatch/);
  await writeFile(path.join(f.directory, "tokenizer.json"), "fixture bytes: tokenizer.json");
  await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify({ ...f.manifest, dimensions: 384 }));
  await assert.rejects(verifyE5Files(f.directory), /768/);
});
test("Linux model provisioning rejects linked artifacts and reports honest lexical fallback when absent", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  await link(path.join(f.directory, "config.json"), path.join(f.directory, "linked-config"));
  await assert.rejects(verifyE5Files(f.directory), /Invalid local model artifact/);
  await rm(path.join(f.directory, "linked-config"));
  await rm(path.join(f.directory, "tokenizer.json")); await symlink("config.json", path.join(f.directory, "tokenizer.json"));
  await assert.rejects(verifyE5Files(f.directory), /Invalid local model artifact/);
  const missing = await createLinuxEmbeddingProvider({ enabled: true, directory: path.join(f.directory, "missing") });
  assert.equal(missing.status, "unavailable"); if (missing.status === "unavailable") assert.equal(missing.fallback, "lexical");
});
