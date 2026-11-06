import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Docker, resourceName } from "../bridge/harness-worker/docker.ts";
import { WORKER_IMAGES, imageProfile, workerArchitecture } from "../bridge/harness-worker/images.ts";
import { createWorkerRunner } from "../bridge/harness-worker/index.ts";
import { assertProjectArtifacts, codingSpec, fixtureProvider, projectCalls, PROJECT_FILES, PROJECT_OUTPUT_PATHS } from "../workers/coding-fixture.ts";

const enabled = process.env.JARVIS_WORKER_CODING_TESTS === "1";
const architecture = enabled ? await new Docker("docker", "platform").available() : "amd64";
const codingImage = WORKER_IMAGES.coding[architecture], pythonImage = WORKER_IMAGES.python[architecture];

test("only reviewed coding pins enable executable workspace; platform selection rejects unsupported engines", () => {
  for (const arch of ["amd64", "arm64"] as const) {
    assert.deepEqual(imageProfile(WORKER_IMAGES.coding[arch]), { coding: true, architecture: arch });
    assert.deepEqual(imageProfile(WORKER_IMAGES.python[arch]), { coding: false, architecture: arch });
  }
  for (const value of ["node:24-bookworm", `node@sha256:${"0".repeat(64)}`, `untrusted/${WORKER_IMAGES.coding.amd64}`]) {
    assert.deepEqual(imageProfile(value), { coding: false, architecture: null });
  }
  assert.equal(workerArchitecture("x86_64"), "amd64"); assert.equal(workerArchitecture("aarch64"), "arm64");
  assert.throws(() => workerArchitecture("ppc64le"), /verified/);
  assert.ok(Object.keys(PROJECT_FILES).every(path => PROJECT_OUTPUT_PATHS.some(output => path === output || path.startsWith(`${output}/`))));
  assert.ok(PROJECT_OUTPUT_PATHS.filter(path => path !== "dist").every(path => Object.keys(PROJECT_FILES).some(file => file === path || file.startsWith(`${path}/`))));
});

test("real coding workspace executes native tools without changing filesystem/network/credential boundaries", { skip: !enabled, timeout: 45_000 }, async () => {
  for (const image of [pythonImage, codingImage]) {
    const docker = new Docker("docker", `coding-controls-${process.pid}`), spec = codingSpec(image);
    const name = resourceName(docker.owner, spec.ref), coding = image === codingImage;
    try {
      await docker.create(spec.ref, spec.policy, new AbortController().signal);
      const probe = await docker.operation(name, { op: "probe", coding });
      assert.equal(probe.value.workspaceNoexec, !coding); assert.equal(probe.value.temporaryNoexec, true);
      const executable = await docker.operation(name, { op: "check", command: "cp /bin/true ./helper && ./helper", timeoutMs: 2000 });
      assert.equal(executable.code === 0, coding);
      assert.notEqual((await docker.operation(name, { op: "check", command: "cp /bin/true /tmp/helper && /tmp/helper", timeoutMs: 2000 })).code, 0);
      assert.notEqual((await docker.operation(name, { op: "check", command: "kill -STOP 1", timeoutMs: 1000 })).code, 0);
      assert.equal((await docker.operation(name, { op: "check", command: `python3 -c 'import os,socket; assert os.getuid()==65532; assert not os.path.exists("/var/run/docker.sock"); assert not any("KEY" in k or "TOKEN" in k for k in os.environ); s=socket.socket(); s.settimeout(1); assert s.connect_ex(("1.1.1.1",443)) != 0'`, timeoutMs: 3000 })).code, 0);
      if (coding) {
        assert.equal((await docker.operation(name, { op: "check", command: "printf 'int main(){return 0;}\\n' > helper.cpp && c++ helper.cpp -o cpp-helper && ./cpp-helper", timeoutMs: 5000 })).code, 0);
        const missing = await docker.operation(name, { op: "check", command: "npm exec --offline --yes esbuild@0.25.11 -- --version", timeoutMs: 5000 });
        assert.notEqual(missing.code, 0); assert.match(missing.output, /ENOTCACHED|cache mode is 'only-if-cached'/);
      } else {
        const missing = await docker.operation(name, { op: "check", command: "node --version", timeoutMs: 1000 });
        assert.notEqual(missing.code, 0); assert.match(missing.output, /not found/);
        await assert.rejects(docker.operation(name, { op: "probe", coding: true }));
      }
    } finally { assert.equal(await docker.stop(spec.ref), true); }
  }
});

test("real smolagents builds/tests offline web project and native helper, exports exact immutable asset bytes", { skip: !enabled, timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-coding-project-"));
  const provider = fixtureProvider(projectCalls());
  let requests = 0;
  const runner = createWorkerRunner({ dataDirectory: directory, model: "synthetic/project", fetch: async (url, init) => {
    const request = JSON.parse(init!.body as string);
    if (requests++ > 0) {
      const call = request.messages.at(-2), observation = request.messages.at(-1);
      assert.equal(call.role, "assistant"); assert.equal(call.tool_calls.length, 1);
      assert.equal(typeof call.tool_calls[0].function.arguments, "string");
      assert.equal(observation.role, "tool"); assert.equal(observation.tool_call_id, call.tool_calls[0].id);
      assert.ok(observation.content.length > 0);
    }
    return provider(url, init);
  } });
  const spec = codingSpec(codingImage);
  try {
    const result = await runner.run(spec, { signal: new AbortController().signal, emit: async () => {} });
    await assertProjectArtifacts(runner, result);
    if (result.status === "completed") {
      assert.ok(result.artifacts[0].files.every(file => file.path.startsWith("dist/") || file.path === "native/slug"));
      assert.ok(!result.artifacts[0].files.some(file => file.path === "src/model.mjs" || file.path === "native/slug.c"));
    }
    assert.equal(result.usage.modelCalls, projectCalls().length);
    assert.equal((await runner.reconcile(spec.ref)).state, "settled");
  } finally {
    assert.equal((await runner.cancel(spec.ref)).confirmed, true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("coding cancellation kills an actually running Node job and confirms no remaining resource", { skip: !enabled, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-coding-cancel-"));
  const runner = createWorkerRunner({ dataDirectory: directory, model: "synthetic/cancel", fetch: fixtureProvider([
    ["run_check", { command: `node -e 'require("fs").writeFileSync("running.txt","ready"); setTimeout(()=>{},30000)'` }],
  ]) });
  const spec = codingSpec(codingImage);
  const docker = new Docker("docker", "observer");
  let resource = "", runningCheck!: () => void;
  const progress = new Promise<void>(resolve => { runningCheck = resolve; });
  try {
    const running = runner.run(spec, { signal: new AbortController().signal, emit: async event => {
      if (event.type === "started") resource = event.resourceId;
      if (event.type === "progress") runningCheck();
    } });
    await progress;
    const ready = await docker.operation(resource, { op: "check", timeoutMs: 5000,
      command: `python3 -c 'import pathlib,time\nfor _ in range(100):\n if pathlib.Path("running.txt").exists(): break\n time.sleep(.025)\nassert pathlib.Path("running.txt").read_text()=="ready"'` });
    assert.equal(ready.code, 0);
    assert.equal((await runner.cancel(spec.ref)).confirmed, true);
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal(await docker.inspect(resource), null);
  } finally {
    assert.equal((await runner.cancel(spec.ref)).confirmed, true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("wrong-platform reviewed coding pin is refused before resource or model execution", { skip: !enabled, timeout: 15_000 }, async () => {
  const docker = new Docker("docker", `wrong-platform-${process.pid}`);
  const spec = codingSpec(WORKER_IMAGES.coding[architecture === "amd64" ? "arm64" : "amd64"]);
  await assert.rejects(docker.create(spec.ref, spec.policy, new AbortController().signal), /does not match.*architecture/);
  assert.equal(await docker.inspect(resourceName(docker.owner, spec.ref)), null);
});
