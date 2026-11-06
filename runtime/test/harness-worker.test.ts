import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, symlink, link, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRoomPolicy } from "../bridge/harness-contracts/domain.ts";
import type { WorkerSpec } from "../bridge/harness-contracts/worker.ts";
import { Artifacts, PrivateStore } from "../bridge/harness-worker/storage.ts";
import { Gateway, emptyUsage, boundedJson } from "../bridge/harness-worker/gateway.ts";
import { sha256 } from "../bridge/harness-contracts/validation.ts";
import { createWorkerRunner } from "../bridge/harness-worker/index.ts";

const spec: WorkerSpec = {
  version: 1, ref: { roomId: "room", runId: "run", nodeId: "node", attemptId: "attempt" }, planDigest: "a".repeat(64),
  node: { id: "node", title: "Build", role: "builder", instructions: "Write output.txt", dependencies: [], inputFrom: [], outputPaths: ["output.txt"],
    limits: defaultRoomPolicy().runBudget }, policy: defaultRoomPolicy(), inputs: [], checkpoint: null, answer: null,
};
const request = { messages: [{ role: "user", content: "Write an artifact" }], tool_choice: "required",
  tools: ["write_file", "read_file", "run_check", "ask_question", "final_answer"].map(name => ({ type: "function", function: { name } })) };

test("artifact round-trip binds scope/path/digest and rejects tampering, links and conflicting imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-artifacts-"));
  try {
    const store = new Artifacts(directory);
    const [manifest] = await store.seal(spec, [{ path: "output.txt", data: Buffer.from("actual bytes").toString("base64") }], []);
    const ref = { roomId: "room", runId: "run", artifactId: manifest.id, digest: manifest.digest };
    assert.equal(Buffer.from((await store.read(ref, "output.txt", 12)).bytes).toString(), "actual bytes");
    assert.equal(manifest.verification, "unverified");
    for (const bad of [{ ...ref, roomId: "elsewhere" }, { ...ref, runId: "elsewhere" }, { ...ref, digest: "b".repeat(64) }]) {
      await assert.rejects(store.read(bad, "output.txt", 12));
    }
    for (const path of ["../output.txt", "/etc/passwd", "a%2fb", "a\\b", "a//b"]) await assert.rejects(store.read(ref, path, 12));
    await assert.rejects(store.read(ref, "output.txt", 1));
    await assert.rejects(store.restore([manifest, manifest], spec.policy), /Conflicting/);
    const blob = store.blobs.path(sha256("actual bytes"));
    await chmod(blob, 0o600); await writeFile(blob, "changed data");
    await assert.rejects(store.read(ref, "output.txt", 12), /digest/);
    await rm(blob); await symlink("/etc/passwd", blob);
    await assert.rejects(store.read(ref, "output.txt", 100));
    await rm(blob); const source = join(directory, "source"); await writeFile(source, "actual bytes"); await link(source, blob);
    await assert.rejects(store.read(ref, "output.txt", 100), /Unsafe/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("artifact volume, duplicate and malformed snapshot paths fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-artifacts-"));
  try {
    const store = new Artifacts(directory), tiny = structuredClone(spec); tiny.policy.sandbox.maxArtifactBytes = 2;
    await assert.rejects(store.seal(tiny, [{ path: "output.txt", data: "YWJj" }], []), /volume/);
    await assert.rejects(store.seal(spec, [{ path: "../escape", data: "" }], []));
    await assert.rejects(store.seal(spec, [{ path: "x", data: "" }, { path: "x", data: "" }], []), /Duplicate/);
    await assert.rejects(store.seal(spec, [{ path: "x", data: "not base64" }], []));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private journals atomically persist and immutable content cannot be replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-journal-"));
  try {
    const store = new PrivateStore(directory), key = sha256("key");
    await store.put(key, { a: 1 }); await store.put(key, { a: 2 });
    assert.deepEqual(await store.json(key), { a: 2 });
    await store.put(sha256("immutable"), { b: 1 }, true);
    await assert.rejects(store.put(sha256("immutable"), { b: 2 }, true), /collision/);
    assert.throws(() => store.path("../escape"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("model admission persists a conservative reservation before I/O and rejects unknown usage", async () => {
  const usage = emptyUsage(); let persisted = 0, requests = 0;
  const fake = (async () => {
    requests++; assert.ok(persisted > 0); assert.equal(usage.accounting, "partial"); assert.ok(usage.reservedTokens > 0);
    return Response.json({ choices: [] });
  }) as typeof fetch;
  const gateway = new Gateway("fixture/model", fake, undefined);
  await assert.rejects(gateway.generate(request, usage, spec.node.limits, async () => { persisted++; }, new AbortController().signal), /omitted trustworthy usage/);
  assert.equal(usage.accounting, "unknown"); assert.equal(usage.reservedTokens, spec.node.limits.maxTokens);
  await assert.rejects(gateway.generate(request, usage, spec.node.limits, async () => {}, new AbortController().signal), /uncertain/);
  assert.equal(requests, 1);
});

test("model limits reject exhausted calls, oversized prompts, unapproved tools and parallel actions", async () => {
  let calls = 0;
  const fake = (async () => { calls++; return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", tool_calls: [1, 2].map(n => ({ id: `id${n}`, type: "function", function: { name: "final_answer", arguments: '{"answer":"done"}' } })),
  } }] }); }) as typeof fetch;
  const gateway = new Gateway("fixture/model", fake, undefined), signal = new AbortController().signal;
  await assert.rejects(gateway.generate(request, { ...emptyUsage(), modelCalls: 12 }, spec.node.limits, async () => {}, signal), /exhausted/);
  await assert.rejects(gateway.generate({ ...request, messages: [{ content: "a".repeat(30_000) }] }, emptyUsage(), spec.node.limits, async () => {}, signal), /reservation/);
  await assert.rejects(gateway.generate({ ...request, tools: [{ type: "function", function: { name: "host_shell" } }] }, emptyUsage(), spec.node.limits, async () => {}, signal));
  assert.equal(calls, 0);
  await assert.rejects(gateway.generate(request, emptyUsage(), spec.node.limits, async () => {}, signal));
  assert.equal(calls, 1);
  await assert.rejects(boundedJson(new Response("a".repeat(100)), 10), /size/);
});

test("estimated-dollar admission uses published rates conservatively and is not a billing cap", async () => {
  let modelCalls = 0;
  const gateway = new Gateway("fixture/model", (async url => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture/model", pricing: { input: "0.000001", output: "0.000002" } }] });
    modelCalls++;
    return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ finish_reason: "tool_calls", message: { role: "assistant",
      tool_calls: [{ id: "finish", type: "function", function: { name: "final_answer", arguments: '{"answer":"done"}' } }],
    } }] });
  }) as typeof fetch, undefined);
  await assert.rejects(gateway.generate(request, emptyUsage(), { ...spec.node.limits, estimatedUsdLimit: 0 }, async () => {}, new AbortController().signal), /estimated-dollar/);
  assert.equal(modelCalls, 0);
  const usage = emptyUsage();
  await gateway.generate(request, usage, { ...spec.node.limits, estimatedUsdLimit: 1 }, async () => {}, new AbortController().signal);
  assert.ok(Math.abs(usage.estimatedUsd! - 0.00003) < 1e-10);
});

test("missing Docker is unavailable, never host execution or measured success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-unavailable-"));
  try {
    const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", dockerBinary: "/missing-docker", fetch: async () => { throw new Error("must not call"); } });
    assert.equal((await runner.availability()).available, false);
    const result = await runner.run(spec, { signal: new AbortController().signal, emit: async () => { throw new Error("must not emit started"); } });
    assert.equal(result.status, "interrupted");
    assert.equal((await runner.reconcile(spec.ref)).state, "unknown");
    assert.equal((await runner.cancel(spec.ref)).confirmed, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
