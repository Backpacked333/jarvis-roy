import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { defaultRoomPolicy } from "../bridge/harness-contracts/domain.ts";
import type { WorkerEvent, WorkerSpec } from "../bridge/harness-contracts/worker.ts";
import { createWorkerRunner } from "../bridge/harness-worker/index.ts";
import { Docker, resourceName } from "../bridge/harness-worker/docker.ts";
import { WORKER_IMAGES } from "../bridge/harness-worker/images.ts";
import { canonicalJson, sha256 } from "../bridge/harness-contracts/validation.ts";

const enabled = process.env.JARVIS_WORKER_DOCKER_TESTS === "1";
const architecture = enabled ? await new Docker("docker", "platform").available() : "amd64";
const image = process.env.JARVIS_WORKER_TEST_IMAGE ?? WORKER_IMAGES.python[architecture];
function makeSpec(attemptId = "attempt"): WorkerSpec {
  const policy = defaultRoomPolicy(image);
  return { version: 1, ref: { roomId: "room", runId: "run", nodeId: "node", attemptId }, planDigest: "a".repeat(64),
    node: { id: "node", title: "Real fixture", role: "builder", instructions: "Write and test output.txt", dependencies: [], inputFrom: [], outputPaths: ["output.txt"],
      limits: { ...policy.runBudget, maxWallTimeMs: 90_000 } }, policy, inputs: [], checkpoint: null, answer: null };
}
type Step = [string, { [key: string]: string }];
function provider(steps: Step[], inspect?: (request: any) => void): typeof fetch {
  let next = 0;
  return (async (_url, init) => {
    inspect?.(JSON.parse(init!.body as string));
    assert.ok(next < steps.length, "Unexpected extra model call");
    const [name, args] = steps[next++];
    return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 40 }, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: `call_${next}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    } }] });
  }) as typeof fetch;
}

test("real Docker applies kernel controls, rejects escapes/links, enforces tmpfs, memory and PIDs", { skip: !enabled, timeout: 120_000 }, async () => {
  const docker = new Docker("docker", `fixture${process.pid}`), spec = makeSpec(), name = resourceName(docker.owner, spec.ref);
  spec.policy.sandbox.workspaceMiB = 8; spec.policy.sandbox.memoryMiB = 64; spec.policy.sandbox.pidsLimit = 16;
  const signal = new AbortController().signal;
  try {
    await docker.create(spec.ref, spec.policy, signal);
    const actual = await docker.inspect(name);
    assert.equal(actual.HostConfig.NetworkMode, "none"); assert.equal(actual.HostConfig.MemorySwap, 64 * 1_048_576);
    const probe = await docker.operation(name, { op: "check", command: `python -I -S -c 'import os,socket; assert os.geteuid()==65532; assert not os.path.exists("/var/run/docker.sock"); assert not any("KEY" in k or "TOKEN" in k for k in os.environ); s=socket.socket(); s.settimeout(1); assert s.connect_ex(("1.1.1.1",443)) != 0; print("boundary probe passed")'`, timeoutMs: 5000 });
    assert.equal(probe.code, 0); assert.match(probe.output, /boundary probe passed/);
    assert.notEqual((await docker.operation(name, { op: "check", command: "kill -STOP 1", timeoutMs: 1000 })).code, 0);
    assert.notEqual((await docker.operation(name, { op: "check", command: "touch /root-should-be-readonly", timeoutMs: 5000 })).code, 0);
    assert.notEqual((await docker.operation(name, { op: "check", command: "dd if=/dev/zero of=/workspace/too-large bs=1M count=12; status=$?; rm -f /workspace/too-large; exit $status", timeoutMs: 5000 })).code, 0);
    assert.notEqual((await docker.operation(name, { op: "check", command: "python -I -S -c 'x=bytearray(128*1024*1024)'", timeoutMs: 5000 })).code, 0);
    const pids = await docker.operation(name, { op: "check", command: `python -I -S -c 'import subprocess; children=[]\ntry:\n for i in range(50): children.append(subprocess.Popen(["sleep","3"]))\nexcept OSError:\n print("pids bounded",len(children))\nfinally:\n for p in children: p.kill(); p.wait()\nassert len(children)<50'`, timeoutMs: 5000 });
    assert.equal(pids.code, 0); assert.match(pids.output, /pids bounded/);
    await assert.rejects(docker.operation(name, { op: "write", path: "../outside", data: "", maxBytes: 100 }));
    for (const command of ["ln -s /etc/passwd bad", "printf x > good; ln good bad"]) {
      assert.equal((await docker.operation(name, { op: "check", command, timeoutMs: 5000 })).code, 0);
      await assert.rejects(docker.operation(name, { op: "snapshot", maxBytes: 1000, maxFiles: 10 }));
      await docker.operation(name, { op: "check", command: "rm -f bad good", timeoutMs: 5000 });
    }
  } finally { assert.equal(await docker.stop(spec.ref), true); assert.equal(await docker.inspect(name), null); }
});

test("real smolagents + Docker file/test/artifact flow with synthetic provider, durable reconciliation and no duplicate start", { skip: !enabled, timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-e2e-"));
  try {
    const options = { dataDirectory: directory, model: "fixture/model", fetch: provider([
      ["write_file", { path: "output.txt", content: "real container output\n" }],
      ["run_check", { command: "python -I -S -c 'assert open(\"output.txt\").read() == \"real container output\\n\"; print(\"verified\")'" }],
      ["final_answer", { answer: "Created output.txt and checked its bytes." }],
    ]) };
    const runner = createWorkerRunner(options), events: WorkerEvent[] = [], spec = makeSpec();
    const context = { signal: new AbortController().signal, emit: async (event: WorkerEvent) => { events.push(event); } };
    const result = await runner.run(spec, context);
    assert.equal(result.status, "completed", JSON.stringify(result));
    if (result.status !== "completed") return;
    assert.equal(result.usage.steps, 3); assert.equal(result.usage.modelCalls, 3);
    assert.equal(result.artifacts[0].verification, "passed"); assert.match(result.artifacts[0].verificationSummary, /exit=0/);
    assert.equal(events[0].type, "started"); assert.deepEqual(events.map(e => e.sequence), events.map((_, n) => n));
    for (const event of events) if (event.type === "usage") {
      assert.equal(event.usage.accounting, "measured"); assert.equal(event.usage.reservedTokens, 0);
    }
    const manifest = result.artifacts[0];
    assert.equal(Buffer.from((await runner.artifacts.read({ roomId: "room", runId: "run", artifactId: manifest.id, digest: manifest.digest }, "output.txt", 100)).bytes).toString(), "real container output\n");
    assert.deepEqual(await runner.run(spec, context), result);
    assert.equal((await createWorkerRunner(options).reconcile(spec.ref)).state, "settled");
    assert.equal((await runner.cancel(spec.ref)).confirmed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("question seals/stops old container, resumes exact answer/files in new attempt without replay", { skip: !enabled, timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-resume-"));
  try {
    const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: provider([
      ["write_file", { path: "once.txt", content: "1" }], ["ask_question", { prompt: "What greeting should output.txt contain?" }],
      ["write_file", { path: "output.txt", content: "Hello Roy" }],
      ["run_check", { command: "python -I -S -c 'assert open(\"once.txt\").read()==\"1\"; assert open(\"output.txt\").read()==\"Hello Roy\"'" }],
      ["final_answer", { answer: "Used the greeting and verified both files." }],
    ], request => { if (JSON.stringify(request).includes("Hello Roy")) assert.match(JSON.stringify(request), /Bound clarification answer/); }) });
    const first = makeSpec(), resources: string[] = [], events: WorkerEvent[] = [], context = { signal: new AbortController().signal,
      emit: async (event: WorkerEvent) => { events.push(event); if (event.type === "started") resources.push(event.resourceId); } };
    const result = await runner.run(first, context);
    assert.equal(result.status, "waiting_question", JSON.stringify(result)); if (result.status !== "waiting_question") return;
    assert.equal(result.checkpoint.sequence, events.at(-1)!.sequence);
    assert.equal(events[0].sequence, 0);
    const resumed = makeSpec("attempt2"); resumed.checkpoint = result.checkpoint;
    resumed.answer = { binding: { questionId: "q1", revision: 1, target: { scope: "node", ...first.ref } }, source: "text", text: "Hello Roy", choiceId: null };
    const second = await runner.run(resumed, context);
    assert.equal(second.status, "completed", JSON.stringify(second)); assert.equal(second.usage.steps, 5);
    assert.equal(resources.length, 2); assert.notEqual(resources[0], resources[1]);
    const stale = makeSpec("attempt3"); stale.checkpoint = result.checkpoint; stale.answer = resumed.answer;
    assert.equal((await runner.run(stale, context)).status, "failed");
    const cross = structuredClone(resumed); cross.ref.roomId = "other";
    await assert.rejects(runner.run(cross, context));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancellation stops active real container; fresh runner detects and reaps an orphan without successful replay", { skip: !enabled, timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-cancel-")), spec = makeSpec();
  try {
    const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: provider([["run_check", { command: "sleep 30" }]]) });
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const work = runner.run(spec, { signal: new AbortController().signal, emit: async event => { if (event.type === "progress") started(); } });
    await ready;
    const cancel = await runner.cancel(spec.ref); assert.equal(cancel.confirmed, true);
    const result = await work; assert.equal(result.status, "cancelled");
    assert.equal((await runner.reconcile(spec.ref)).state, "settled");
    const orphan = { ...spec.ref, attemptId: "orphan", nodeId: "orphan" };
    const owner = sha256(join(directory, "harness-workers-v1")).slice(0, 16), docker = new Docker("docker", owner);
    await docker.create(orphan, spec.policy, new AbortController().signal);
    assert.equal((await runner.reconcile(orphan)).state, "running");
    assert.equal((await runner.cancel(orphan)).confirmed, true);
    assert.equal((await runner.reconcile(orphan)).state, "missing");
    assert.equal(await docker.inspect(resourceName(owner, orphan)), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing image and fake checkpoint never run a model or report started", { skip: !enabled, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-image-"));
  try {
    const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: async () => { throw new Error("Unexpected model call"); } });
    const spec = makeSpec(); spec.policy.sandbox.image = `sha256:${"0".repeat(64)}`;
    const result = await runner.run(spec, { signal: new AbortController().signal, emit: async () => { throw new Error("No real resource started"); } });
    assert.equal(result.status, "failed"); if (result.status === "failed") assert.match(result.error, /explicitly pulled/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("independent non-root watchdog stops orphaned generated work even without controller cleanup", { skip: !enabled, timeout: 15_000 }, async () => {
  const docker = new Docker("docker", `watchdog${process.pid}`), spec = makeSpec();
  try {
    await docker.create(spec.ref, spec.policy, new AbortController().signal, 2500);
    assert.notEqual((await docker.operation(resourceName(docker.owner, spec.ref), { op: "check", command: "kill -STOP 1", timeoutMs: 500 })).code, 0);
    await delay(2800);
    assert.equal((await docker.inspect(resourceName(docker.owner, spec.ref))).State.Running, false);
  } finally { assert.equal(await docker.stop(spec.ref), true); }
});

test("controller crash preserves pre-call budget and orphan stop, never replays an uncertain attempt", { skip: !enabled, timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-crash-")), spec = makeSpec();
  spec.node.limits.maxModelCalls = 1;
  const moduleUrl = new URL("../bridge/harness-worker/index.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {createWorkerRunner} from ${JSON.stringify(moduleUrl)};
    const runner=createWorkerRunner({dataDirectory:${JSON.stringify(directory)},model:"fixture/model", fetch: async()=>{
      console.log("provider-admitted");
      await new Promise(()=>{});
    }});
    await runner.run(${JSON.stringify(spec)}, {signal:new AbortController().signal,emit:async()=>{}});
  `], { env: { PATH: process.env.PATH, HOME: process.env.HOME, JARVIS_WORKER_PYTHON: process.env.JARVIS_WORKER_PYTHON }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Crash fixture never admitted provider call")), 15_000);
      child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("provider-admitted")) { clearTimeout(timer); resolve(); } });
      child.on("error", reject);
    });
    child.kill("SIGKILL"); await closed;
    const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: async () => { throw new Error("Uncertain call must not replay"); } });
    assert.equal((await runner.reconcile(spec.ref)).state, "running");
    await assert.rejects(runner.run(spec, { signal: new AbortController().signal, emit: async () => {} }), /never replayed/);
    assert.equal((await runner.cancel(spec.ref)).confirmed, true);
    const recovered = await runner.reconcile(spec.ref);
    assert.equal(recovered.state, "settled");
    if (recovered.state === "settled") { assert.equal(recovered.result.status, "interrupted"); assert.ok(recovered.result.usage.reservedTokens > 0); }
    const retry = structuredClone(spec); retry.ref.attemptId = "retry";
    const retried = await runner.run(retry, { signal: new AbortController().signal, emit: async () => {} });
    assert.equal(retried.status, "failed"); if (retried.status === "failed") assert.match(retried.error, /budget exhausted/);
  } finally { child.kill("SIGKILL"); await closed; await rm(directory, { recursive: true, force: true }); }
});

test("step, log and wall-time limits stop real execution; post-check edits are not passed verification", { skip: !enabled, timeout: 90_000 }, async () => {
  for (const mode of ["steps", "logs", "time", "edit"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `jarvis-worker-${mode}-`));
    try {
      const spec = makeSpec();
      const steps: Step[] = mode === "steps" ? [["write_file", { path: "output.txt", content: "one" }]]
        : mode === "logs" ? [["run_check", { command: "python -c 'print(\"x\"*3000)'" }]]
        : mode === "time" ? [["run_check", { command: "sleep 20" }]]
        : [["write_file", { path: "output.txt", content: "one" }], ["run_check", { command: "test -f output.txt" }],
          ["write_file", { path: "output.txt", content: "two" }], ["final_answer", { answer: "Updated output" }]];
      if (mode === "steps") spec.node.limits.maxSteps = 1;
      if (mode === "logs") spec.policy.sandbox.maxLogBytes = 1024;
      if (mode === "time") spec.node.limits.maxWallTimeMs = 2500;
      const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: provider(steps) });
      const result = await runner.run(spec, { signal: new AbortController().signal, emit: async () => {} });
      if (mode === "edit") {
        assert.equal(result.status, "completed", JSON.stringify(result));
        if (result.status === "completed") assert.equal(result.artifacts[0].verification, "unverified");
      } else { assert.equal(result.status, "failed", JSON.stringify(result)); }
      assert.equal((await runner.cancel(spec.ref)).confirmed, true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("upstream immutable artifacts restore into a scoped downstream real workspace", { skip: !enabled, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-handoff-"));
  try {
    const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: provider([
      ["write_file", { path: "output.txt", content: "upstream immutable" }], ["final_answer", { answer: "wrote upstream" }],
      ["run_check", { command: "python -c 'assert open(\"output.txt\").read()==\"upstream immutable\"; open(\"result.txt\",\"w\").write(\"consumed\")'" }],
      ["final_answer", { answer: "Consumed upstream snapshot" }],
    ]) });
    const context = { signal: new AbortController().signal, emit: async () => {} }, upstream = makeSpec();
    const produced = await runner.run(upstream, context);
    assert.equal(produced.status, "completed"); if (produced.status !== "completed") return;
    const downstream = makeSpec(); downstream.ref.nodeId = "downstream"; downstream.node.id = "downstream";
    downstream.node.inputFrom = ["node"]; downstream.node.dependencies = ["node"]; downstream.node.outputPaths = ["result.txt"];
    downstream.inputs = produced.artifacts;
    const consumed = await runner.run(downstream, context);
    assert.equal(consumed.status, "completed", JSON.stringify(consumed));
    if (consumed.status === "completed") assert.ok(consumed.artifacts[0].inputDigests.includes(produced.artifacts[0].digest));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancellation interrupts stalled event persistence and still confirms real resource cleanup", { skip: !enabled, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-worker-events-"));
  try {
    const runner = createWorkerRunner({ dataDirectory: directory, model: "fixture/model", fetch: provider([]) });
    const spec = makeSpec();
    let started!: () => void;
    const observedStart = new Promise<void>(resolve => { started = resolve; });
    const running = runner.run(spec, { signal: new AbortController().signal, emit: async event => {
      assert.equal(event.type, "started"); started();
      await new Promise<void>(() => {});
    } });
    await observedStart;
    assert.equal((await runner.cancel(spec.ref)).confirmed, true);
    assert.equal((await running).status, "cancelled");
    assert.equal((await runner.reconcile(spec.ref)).state, "settled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
