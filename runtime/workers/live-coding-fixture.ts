import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerRunner } from "../bridge/harness-worker/index.ts";
import { imageProfile } from "../bridge/harness-worker/images.ts";
import { assertProjectArtifacts, BUILD_AND_TEST, codingSpec, fixtureProvider, projectCalls } from "./coding-fixture.ts";

if (process.env.JARVIS_WORKER_LIVE_TEST !== "1" || !process.env.AI_GATEWAY_API_KEY || !process.env.JARVIS_WORKER_MODEL ||
    !process.env.JARVIS_WORKER_IMAGE || !imageProfile(process.env.JARVIS_WORKER_IMAGE).coding) {
  throw new Error("Requires explicit live-test opt-in, authorized Gateway key, explicit model and reviewed coding image pin");
}
const directory = await mkdtemp(join(tmpdir(), "jarvis-live-coding-"));
const source = codingSpec(process.env.JARVIS_WORKER_IMAGE, "source");
const builder = codingSpec(process.env.JARVIS_WORKER_IMAGE, "enhance");
const verifier = codingSpec(process.env.JARVIS_WORKER_IMAGE, "verify");
const synthetic = createWorkerRunner({ dataDirectory: directory, model: "synthetic/source", fetch: fixtureProvider(projectCalls()) });
const live = createWorkerRunner({ dataDirectory: directory, model: process.env.JARVIS_WORKER_MODEL });
const context = { signal: new AbortController().signal, emit: async () => {} };
try {
  const seeded = await synthetic.run(source, context);
  await assertProjectArtifacts(synthetic, seeded);
  if (seeded.status !== "completed") throw new Error("Source build failed");
  builder.inputs = seeded.artifacts; builder.node.dependencies = ["source"]; builder.node.inputFrom = ["source"];
  builder.node.limits = { maxSteps: 8, maxModelCalls: 8, maxTokens: 60_000, maxOutputTokensPerCall: 2048,
    maxWallTimeMs: 90_000, estimatedUsdLimit: null };
  builder.node.instructions = "Enhance this existing offline web project. Read src/model.mjs; change filterProjects so a query matches either title OR status, " +
    "case-insensitively after trimming whitespace. Empty queries return all projects; missing queries return none. Preserve the existing API/data. " +
    "Add focused Node tests in test/status.test.mjs for status, mixed-case, whitespace, empty and nonmatching searches. " +
    "Only edit those two source files; do not replace the project, change existing tests, install packages, use network or ask questions. " +
    "Run npm run build && npm test to rebuild real dist assets and run all tests, then final_answer. The browser uses this shared filter. " +
    "Use at most eight tool calls. python3/Node24/npm/make/C compiler are already installed; all execution stays in the isolated container.";
  const built = await live.run(builder, { ...context, emit: async event => {
    if (event.type === "progress") console.log(event.operation);
  } });
  console.log(JSON.stringify({ phase: "live-model enhancement", status: built.status, usage: built.usage,
    ...(built.status === "failed" ? { error: built.error } : {}) }, null, 2));
  await assertProjectArtifacts(live, built);
  if (built.status !== "completed") throw new Error("Live build failed");
  assert.notEqual(built.artifacts[0].files.find(f => f.path === "src/model.mjs")?.sha256,
    seeded.artifacts[0].files.find(f => f.path === "src/model.mjs")?.sha256);
  assert.ok(built.artifacts[0].files.some(f => f.path === "test/status.test.mjs"));
  verifier.inputs = built.artifacts; verifier.node.dependencies = ["enhance"]; verifier.node.inputFrom = ["enhance"];
  const validation = createWorkerRunner({ dataDirectory: directory, model: "synthetic/verification", fetch: fixtureProvider([
    ["run_check", { command: BUILD_AND_TEST + ` && node --input-type=module -e 'import assert from "node:assert/strict"; import {projects,filterProjects} from "./dist/model.mjs"; assert.equal(filterProjects(projects," READY ").length,2); assert.equal(filterProjects(projects,"DRAFT").length,1); assert.equal(filterProjects(projects,"").length,3); assert.equal(filterProjects(projects,"absent").length,0)'` }],
    ["final_answer", { answer: "Independent isolated rebuild and exact status-filter assertions passed." }],
  ]) });
  const verified = await validation.run(verifier, context);
  await assertProjectArtifacts(validation, verified);
  console.log("Live model changed real web source/tests; independent fresh Docker rebuild verified emitted module behavior and immutable artifact bytes. No external actions.");
} finally {
  const cleanup = await Promise.all([source, builder, verifier].map(spec => live.cancel(spec.ref)));
  if (cleanup.every(result => result.confirmed)) await rm(directory, { recursive: true, force: true });
  else throw new Error("Cleanup unconfirmed; worker journals retained");
}
