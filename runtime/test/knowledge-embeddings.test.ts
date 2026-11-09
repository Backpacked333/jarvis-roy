import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createMacEmbeddingProvider, LocalEmbeddingError, type MacEmbeddingOptions } from "../bridge/knowledge-embeddings.ts";
import { runNativeHelper } from "../agent/lib/native-helper.ts";

const model = { id: "apple-nl-sentence.en", version: "macos-14.0.0-revision-4", dimensions: 2,
  language: "en", revision: 4, osVersion: "14.0.0", local: true };
const available = (vectors: number[][] = []) => ({ kind: "sentence_embeddings", status: "available", model, vectors });
async function helper(t: TestContext, handler: string): Promise<MacEmbeddingOptions> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-embedding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "helper.cjs");
  await writeFile(file, `#!${process.execPath}\nlet text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(text);${handler}});`, { mode: 0o700 });
  return { platform: "darwin", environment: { JARVIS_ENABLE_SEMANTIC_RETRIEVAL: "1", JARVIS_NATIVE_HELPER: file, AI_GATEWAY_API_KEY: "must-not-inherit" } };
}
const response = (result: unknown) => `process.stdout.write(JSON.stringify({ok:true,result:${JSON.stringify(result)}}));`;
const changingResponse = (resultExpression: string) => `const model=${JSON.stringify(model)};process.stdout.write(JSON.stringify({ok:true,result:${resultExpression}}));`;

test("semantic retrieval defaults off and unsupported platforms retain explicit lexical fallback", async () => {
  assert.deepEqual(await createMacEmbeddingProvider({ environment: {}, platform: "darwin" }), { status: "unavailable", reason: "disabled", fallback: "lexical" });
  assert.deepEqual(await createMacEmbeddingProvider({ environment: { JARVIS_ENABLE_SEMANTIC_RETRIEVAL: "1" }, platform: "linux" }),
    { status: "unavailable", reason: "unsupported_platform", fallback: "lexical" });
});

test("model absence and invalid helper responses are visible without leaking echoed content", async (t) => {
  const unavailable = await helper(t, response({ kind: "sentence_embeddings", status: "unavailable", reason: "model_unavailable", language: "en", local: true }));
  assert.deepEqual(await createMacEmbeddingProvider(unavailable), { status: "unavailable", reason: "model_unavailable", fallback: "lexical" });
  for (const invalid of [{ ...available(), privateEcho: "private material" }, { ...available(), vectors: [[0.6, 0.8]] },
    { ...available(), model: { ...model, local: false } }, { ...available(), model: { ...model, version: "changed" } }]) {
    const options = await helper(t, response(invalid));
    assert.deepEqual(await createMacEmbeddingProvider(options), { status: "unavailable", reason: "invalid_response", fallback: "lexical" });
  }
});

test("native provider sends only bounded embedding operation over stdin with credential-free environment", async (t) => {
  const options = await helper(t, `if(process.env.AI_GATEWAY_API_KEY||input.operation!=='sentence_embeddings'||input.version!==1||input.embeddingLanguage!=='en')process.exit(1);` +
    changingResponse(`{kind:'sentence_embeddings',status:'available',model,vectors:input.texts.map(()=>[0.6,0.8])}`));
  const result = await createMacEmbeddingProvider(options);
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  assert.deepEqual(result.identity, { id: model.id, version: model.version, dimensions: 2, local: true });
  assert.equal(Object.isFrozen(result.provider.identity), true);
  assert.deepEqual(await result.provider.embed(["Private selected passage", "Follow-up"], {}), [[0.6, 0.8], [0.6, 0.8]]);
  assert.deepEqual(await result.provider.embed([], {}), []);
  for (const texts of [[""], [" "], ["🙂".repeat(4097)], Array(17).fill("passage"), Array(5).fill("a".repeat(16_384))]) {
    await assert.rejects(result.provider.embed(texts, {}), (error: unknown) => error instanceof LocalEmbeddingError && error.code === "invalid_input");
  }
  await assert.rejects(runNativeHelper({ operation: "read_screen" }, undefined, options, "embedding"), /narrow embedding operation/);
  await assert.rejects(runNativeHelper({ operation: "sentence_embeddings", embeddingLanguage: "en", texts: [] }, undefined,
    { ...options, environment: { ...options.environment, JARVIS_ENABLE_DESKTOP: "1" } }, "desktop"), /narrow embedding capability/);
});

test("changed model, malformed counts, dimensions, zero vectors and unsupported errors never produce partial vectors", async (t) => {
  for (const expression of [
    `{kind:'sentence_embeddings',status:'available',model:{...model,revision:5,version:'macos-14.0.0-revision-5'},vectors:[[0.6,0.8]]}`,
    `{kind:'sentence_embeddings',status:'available',model,vectors:[]}`,
    `{kind:'sentence_embeddings',status:'available',model,vectors:[[1]]}`,
    `{kind:'sentence_embeddings',status:'available',model,vectors:[[0,0]]}`,
    `{kind:'sentence_embeddings',status:'available',model,vectors:[[3,4]]}`,
    `{kind:'sentence_embeddings',status:'unavailable',reason:'model_unavailable',language:'en',local:true}`,
  ]) {
    const options = await helper(t, changingResponse(`input.texts.length?${expression}:{kind:'sentence_embeddings',status:'available',model,vectors:[]}`));
    const result = await createMacEmbeddingProvider(options);
    assert.equal(result.status, "available"); if (result.status !== "available") continue;
    await assert.rejects(result.provider.embed(["Private selected passage"], {}), (error: unknown) =>
      error instanceof LocalEmbeddingError && !error.message.includes("Private selected passage"));
  }
});

test("escaped JSON batches split within native wire bounds and cancellation preserves no completed output", async (t) => {
  const options = await helper(t, `if(Buffer.byteLength(text)>65536)process.exit(1);` +
    changingResponse(`{kind:'sentence_embeddings',status:'available',model,vectors:input.texts.map(()=>[0.6,0.8])}`));
  const result = await createMacEmbeddingProvider(options);
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  // 64 KiB raw text, 128 KiB after JSON escaping: must use multiple helper calls.
  assert.equal((await result.provider.embed(Array(4).fill('"'.repeat(16_384)), {})).length, 4);
  const controller = new AbortController(); controller.abort("private cancellation reason");
  await assert.rejects(result.provider.embed(["selected"], { signal: controller.signal }), (error: unknown) =>
    error instanceof Error && error.name === "AbortError" && !error.message.includes("private cancellation reason"));
});

test("high dimensional models split batches before the bounded native output budget", async (t) => {
  const options = await helper(t, `const model=${JSON.stringify({ ...model, dimensions: 4096 })};
    if(input.texts.length>4)process.exit(1);
    process.stdout.write(JSON.stringify({ok:true,result:{kind:'sentence_embeddings',status:'available',model,
      vectors:input.texts.map(()=>[1,...Array(4095).fill(0)])}}));`);
  const result = await createMacEmbeddingProvider(options);
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  const vectors = await result.provider.embed(Array(5).fill("Selected passage"), {});
  assert.equal(vectors.length, 5);
  assert.equal(vectors.every(vector => vector.length === 4096 && vector[0] === 1), true);
});

test("in-flight cancellation kills local embedding process and releases the shared helper authority", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-embedding-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "started");
  const options = await helper(t, `if(input.texts.length){require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);}else{${response(available())}}`);
  const result = await createMacEmbeddingProvider(options);
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  const controller = new AbortController();
  const pending = result.provider.embed(["private material"], { signal: controller.signal });
  const rejection = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  let started = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(marker); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.equal(started, true);
  } finally { controller.abort(); }
  await rejection;
  assert.equal((await createMacEmbeddingProvider(options)).status, "available");
});

test("shared provider serializes concurrent callers and freezes queued input order", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-embedding-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = path.join(directory, "calls");
  const options = await helper(t, `const model=${JSON.stringify(model)};
    if(input.texts.length)require('node:fs').appendFileSync(${JSON.stringify(log)},input.texts[0]+'\\n');
    setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,result:{kind:'sentence_embeddings',status:'available',model,
      vectors:input.texts.map(()=>[0.6,0.8])}})),input.texts.length?50:0);`);
  const result = await createMacEmbeddingProvider(options);
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  const captured = ["second"];
  const first = result.provider.embed(["first"], {});
  const second = result.provider.embed(captured, {});
  const third = result.provider.embed(["third"], {});
  captured[0] = "changed-after-enqueue";
  assert.equal((await Promise.all([first, second, third])).length, 3);
  assert.equal(await readFile(log, "utf8"), "first\nsecond\nthird\n");
});

test("bounded queue rejects overflow and aborted queued calls never reach the helper or block successors", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-embedding-queued-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = path.join(directory, "calls");
  const options = await helper(t, `const model=${JSON.stringify(model)};
    if(input.texts.length)require('node:fs').appendFileSync(${JSON.stringify(log)},input.texts[0]+'\\n');
    setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,result:{kind:'sentence_embeddings',status:'available',model,
      vectors:input.texts.map(()=>[0.6,0.8])}})),input.texts[0]==='first'?100:0);`);
  const result = await createMacEmbeddingProvider(options);
  assert.equal(result.status, "available"); if (result.status !== "available") return;
  const controller = new AbortController();
  const first = result.provider.embed(["first"], {});
  const queued = result.provider.embed(["cancelled"], { signal: controller.signal });
  const cancellation = assert.rejects(queued, (error: unknown) => error instanceof Error && error.name === "AbortError");
  const others = Array.from({ length: 7 }, (_, index) => result.provider.embed([`waiting-${index}`], {}));
  await assert.rejects(result.provider.embed(["overflow"], {}), (error: unknown) => error instanceof LocalEmbeddingError && error.code === "queue_full");
  controller.abort();
  await cancellation;
  const last = result.provider.embed(["last"], {});
  await Promise.all([first, ...others, last]);
  assert.equal(await readFile(log, "utf8"), "first\n" + Array.from({ length: 7 }, (_, index) => `waiting-${index}\n`).join("") + "last\n");
});
