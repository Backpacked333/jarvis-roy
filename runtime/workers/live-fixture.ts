import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createWorkerRunner } from "../bridge/harness-worker/index.ts";
import { defaultRoomPolicy } from "../bridge/harness-contracts/domain.ts";
import type { WorkerSpec } from "../bridge/harness-contracts/worker.ts";

if (process.env.JARVIS_WORKER_LIVE_TEST !== "1") throw new Error("Live model use requires explicit JARVIS_WORKER_LIVE_TEST=1");
if (!process.env.AI_GATEWAY_API_KEY || !process.env.JARVIS_WORKER_IMAGE || !process.env.JARVIS_WORKER_MODEL) {
  throw new Error("Live fixture requires Gateway credential, pinned worker image and explicit model");
}
const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-live-"));
const policy = defaultRoomPolicy(process.env.JARVIS_WORKER_IMAGE);
const limits = { maxSteps: 4, maxModelCalls: 4, maxTokens: 24_000, maxOutputTokensPerCall: 512, maxWallTimeMs: 60_000, estimatedUsdLimit: null };
const spec: WorkerSpec = {
  version: 1, ref: { roomId: "livefixture", runId: "run", nodeId: "node", attemptId: "attempt" }, planDigest: "a".repeat(64), policy,
  node: { id: "node", title: "Harmless live worker fixture", role: "builder", dependencies: [], inputFrom: [], outputPaths: ["hello.txt"], limits,
    instructions: "Use exactly these three tool calls, one per response: 1) write_file path hello.txt with content Hello from Jarvis followed by a newline. " +
      "2) run_check with python -I -S -c 'assert open(\"hello.txt\").read() == \"Hello from Jarvis\\n\"; print(\"fixture passed\")'. " +
      "3) final_answer briefly describe the file and actual check. No other actions, questions, network access or files." },
  inputs: [], checkpoint: null, answer: null,
};
const runner = createWorkerRunner({ dataDirectory: directory, model: process.env.JARVIS_WORKER_MODEL });
try {
  const result = await runner.run(spec, { signal: new AbortController().signal, emit: async event => {
    if (event.type === "started") console.log("Real sandbox started");
    if (event.type === "progress") console.log(event.operation);
  } });
  console.log(JSON.stringify({ status: result.status, usage: result.usage,
    ...(result.status === "failed" ? { error: result.error } : {}),
    ...(result.status === "interrupted" ? { reason: result.reason } : {}),
  }, null, 2));
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    const manifest = result.artifacts[0];
    assert.equal(manifest.verification, "passed");
    const file = await runner.artifacts.read({ roomId: "livefixture", runId: "run", artifactId: manifest.id, digest: manifest.digest }, "hello.txt", 100);
    assert.equal(Buffer.from(file.bytes).toString(), "Hello from Jarvis\n");
    console.log("Verified live-model artifact content and actual check; no external actions.");
  }
} finally {
  const stopped = await runner.cancel(spec.ref);
  if (stopped.confirmed) await rm(directory, { recursive: true, force: true });
  else throw new Error("Cleanup unconfirmed; retained worker journal");
}
