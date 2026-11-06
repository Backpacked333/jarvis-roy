import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createWorkerRunner } from "../bridge/harness-worker/index.ts";
import { Docker } from "../bridge/harness-worker/docker.ts";
import { WORKER_IMAGES } from "../bridge/harness-worker/images.ts";
import { emptyUsage } from "../bridge/harness-worker/gateway.ts";
import { HarnessStateSchema, type HarnessState } from "../bridge/harness-contracts/service.ts";
import { questionBinding } from "../bridge/harness-contracts/interactions.ts";
import { assertProjectArtifacts, BUILD_AND_TEST, codingSpec, fixtureProvider, projectCalls, type FixtureCall } from "../workers/coding-fixture.ts";
import { FakeEveClient } from "./helpers.ts";

const enabled = process.env.JARVIS_WORKER_KERNEL_TESTS === "1";

for (const clarify of [false, true]) test(`HTTP/kernel/real coding worker publishes only declared directories, private scratch ${clarify ? "survives question and restart" : "is not published"}`, {
  skip: !enabled, timeout: 120_000,
}, async () => {
  // This opt-in runs only in the integrated tree; the frozen worker lane has no kernel/server wiring.
  const load = (path: string) => import(new URL(path, import.meta.url).href);
  const [{ createHarnessKernel }, { createBridgeServer, shutdownBridge }, { JarvisService },
    { createQuestionRouter }, { createVoiceBridge }] = await Promise.all([
    load("../bridge/harness-kernel/index.ts"), load("../bridge/server.ts"), load("../bridge/service.ts"),
    load("../bridge/harness-interactions/index.ts"), load("../bridge/harness-voice/index.ts"),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-kernel-"));
  const architecture = await new Docker("docker", "integrated-coding").available();
  const spec = codingSpec(WORKER_IMAGES.coding[architecture]);
  const calls: FixtureCall[] = projectCalls().slice(0, -2);
  calls.push(["run_check", { command: `mkdir -p scratch dist-other; printf once >> scratch/private.txt; printf not-output > dist-other/rejected.txt; ${BUILD_AND_TEST}` }]);
  if (clarify) calls.push(["ask_question", { prompt: "Continue the tested build with the preserved scratch state?" }],
    ["run_check", { command: `python3 -c 'assert open("scratch/private.txt").read()=="once"; assert open("dist-other/rejected.txt").read()=="not-output"' && ${BUILD_AND_TEST}` }]);
  calls.push(["final_answer", { answer: "Built and verified declared web outputs; scratch remains private." }]);
  let modelCalls = 0;
  const provider = fixtureProvider(calls);
  const workerOptions = { dataDirectory: directory, model: "synthetic/integration", fetch: (async (url, init) => {
    modelCalls++; return provider(url, init);
  }) as typeof fetch };
  const token = "isolated-worker-integration-token-32-characters";
  const previousToken = process.env.JARVIS_LOCAL_TOKEN;
  process.env.JARVIS_LOCAL_TOKEN = token;
  const service = await JarvisService.create({ client: new FakeEveClient(), dataDirectory: directory, model: "synthetic/root" });
  let server: any, harness: any, worker = createWorkerRunner(workerOptions), base = "";
  const start = async () => {
    worker = createWorkerRunner(workerOptions);
    harness = createHarnessKernel({ dataDirectory: directory, worker, defaultPolicy: spec.policy,
      author: { async author() { return { status: "completed", draft: { goal: "Offline build", nodes: [spec.node] }, usage: emptyUsage() }; } } });
    await harness.initialize();
    server = createBridgeServer(service, "127.0.0.1", 0, {
      harness, worker, questions: createQuestionRouter({ harness }), voice: createVoiceBridge({}), stopping: false,
    });
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const request = async (path: string, method = "GET", body?: unknown, status = 200) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
  };
  const wait = async (predicate: (state: HarnessState) => boolean) => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const state = HarnessStateSchema.parse(await request("/v1/harness/state"));
      assert.ok(state.runs.every(run => !["failed", "interrupted"].includes(run.status)), JSON.stringify(state.runs));
      if (predicate(state)) return state;
      assert.ok(Date.now() < deadline, JSON.stringify(state)); await delay(25);
    }
  };
  try {
    await start();
    const room = await request("/v1/harness/rooms", "POST", { requestId: "create", title: "Real offline project", description: "", policy: spec.policy }, 201);
    await request(`/v1/harness/rooms/${room.id}/author`, "POST", { requestId: "author", expectedRoomRevision: room.revision, goal: "Offline build" }, 202);
    const authored = await wait(state => state.plans.length === 1);
    const draft = authored.plans[0];
    const plan = await request(`/v1/harness/rooms/${room.id}/plans/${draft.id}/accept`, "POST", { expectedRevision: draft.revision });
    const run = await request(`/v1/harness/rooms/${room.id}/runs`, "POST", { requestId: "start", planId: plan.id,
      expectedPlanRevision: plan.revision, planDigest: plan.digest }, 202);
    if (clarify) {
      const paused = await wait(state => state.questions.some(question => question.status === "pending"));
      const question = paused.questions.find(question => question.status === "pending")!;
      assert.ok(paused.artifacts.length > 0);
      assert.ok(paused.artifacts.flatMap(artifact => artifact.files).every(file => file.path.startsWith("dist/") || file.path === "native/slug"));
      const callsBeforeRestart = modelCalls;
      await shutdownBridge(server); server = null; await start();
      assert.equal(modelCalls, callsBeforeRestart);
      await request(`/v1/harness/questions/${question.id}/answer`, "POST", {
        binding: questionBinding(question), source: "text", text: "Continue", choiceId: null,
      });
    }
    const done = await wait(state => state.runs.find(item => item.id === run.id)?.status === "completed");
    const completed = done.runs.find(item => item.id === run.id)!;
    const manifest = done.artifacts.find(artifact => completed.nodes[0].artifactIds.includes(artifact.id))!;
    assert.ok(done.artifacts.every(artifact => artifact.files.every(file => file.path.startsWith("dist/") || file.path === "native/slug")));
    const result = await worker.reconcile({ roomId: room.id, runId: run.id, nodeId: spec.node.id, attemptId: completed.nodes[0].attemptId! });
    assert.equal(result.state, "settled"); if (result.state === "settled") await assertProjectArtifacts(worker, result.result);
    const contentPath = `/v1/harness/rooms/${room.id}/runs/${run.id}/artifacts/${manifest.id}/content?digest=${manifest.digest}&path=`;
    const response = await fetch(base + contentPath + "dist/index.html", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.match(await response.text(), /data-build="worker-build-test"/);
    for (const path of ["scratch/private.txt", "src/model.mjs", "dist-other/rejected.txt"]) {
      const denied = await fetch(base + contentPath + path, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(denied.status, 404);
    }
    assert.equal(modelCalls, calls.length);
  } finally {
    if (server) await shutdownBridge(server); else if (harness) await harness.shutdown();
    if (previousToken === undefined) delete process.env.JARVIS_LOCAL_TOKEN; else process.env.JARVIS_LOCAL_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});
