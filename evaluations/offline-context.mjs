#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), options = { output: undefined, samples: 300, warmup: 30, profile: false, finalAuthorization: false };
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!value || !["--output", "--samples", "--warmup", "--profile", "--final-authorization"].includes(key)) throw new Error("Usage: node evaluations/offline-context.mjs --output REPORT.json [--samples 300] [--warmup 30] [--profile true] [--final-authorization true]");
  const flag = ["--profile", "--final-authorization"].includes(key);
  if (flag && !["true", "false"].includes(value)) throw new Error(`${key} expects true or false`);
  options[key === "--final-authorization" ? "finalAuthorization" : key.slice(2)] = key === "--output" ? path.resolve(value) : flag ? value === "true" : Number(value);
}
if (!options.output || !Number.isSafeInteger(options.samples) || options.samples < 30 || options.samples > 10000 || !Number.isSafeInteger(options.warmup) || options.warmup < 1 || options.warmup > 1000) throw new Error("Provide an output path, 30–10000 measured samples, and 1–1000 warmup samples.");
try { await stat(options.output); throw new Error("Output already exists; preserve the previous report and choose a new path."); } catch (error) { if (error.code !== "ENOENT") throw error; }
const sha = value => createHash("sha256").update(value).digest("hex");
const maybeRead = async location => { try { return (await readFile(location, "utf8")).trim(); } catch { return null; } };
const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" }).trim();
const trackedPaths = ["runtime/bridge/context-runtime.ts", "runtime/bridge/retained-context.ts", "runtime/package-lock.json", "evaluations/offline-context.mjs"];
for (const directory of ["knowledge", "memory", "context", "continuity"]) for (const name of await readdir(path.join(root, "runtime/bridge", directory))) {
  if (name.endsWith(".ts")) trackedPaths.push(`runtime/bridge/${directory}/${name}`);
}
const fingerprints = async () => Object.fromEntries(await Promise.all(trackedPaths.sort().map(async name => [name, sha(await readFile(path.join(root, name)))])));
const startCode = await fingerprints();
// Deliberately reject any unexpected network operation. This harness never
// loads an embedding model, starts Eve, or dispatches an account/tool action.
globalThis.fetch = async () => { throw new Error("Network access is disabled in the offline context evaluation"); };
const [{ KnowledgeService }, { MemoryService }, { ContinuityService }, { createContextRuntime }] = await Promise.all([
  import("../runtime/bridge/knowledge/index.ts"), import("../runtime/bridge/memory/index.ts"),
  import("../runtime/bridge/continuity/index.ts"), import("../runtime/bridge/context-runtime.ts"),
]);
let profilingActive = false;
const phaseDurations = new Map();
if (options.profile) for (const [target, prefix, methods] of [
  [KnowledgeService, "knowledge", ["retrieveContext", "readSource", "readPassage", "requireGrant", "listSources", "audit"]],
  [MemoryService, "memory", ["recall", "authorize", "reconcile", "semantic"]],
  [ContinuityService, "continuity", ["checkpoint", "authorizeCheckpoint", "recordContextUse"]],
]) for (const method of methods) {
  const original = target.prototype[method];
  if (typeof original !== "function") throw new Error(`Profile phase unavailable: ${prefix}.${method}`);
  target.prototype[method] = function (...values) {
    if (!profilingActive) return original.apply(this, values);
    const started = performance.now(), label = `${prefix}.${method}`;
    const finish = () => { const durations = phaseDurations.get(label) ?? []; durations.push(performance.now() - started); phaseDurations.set(label, durations); };
    try {
      const result = original.apply(this, values);
      if (result && typeof result.then === "function") return Promise.resolve(result).finally(finish);
      finish(); return result;
    } catch (error) { finish(); throw error; }
  };
}
const fixturePath = "runtime/test/fixtures/retrieval-150.json", fixtureBytes = await readFile(path.join(root, fixturePath));
const fixture = JSON.parse(fixtureBytes); assert.equal(fixture.cases.length, 150); assert.equal(fixture.sources.length, 30);
const startedAt = new Date().toISOString(), directory = await mkdtemp(path.join(os.tmpdir(), "jarvis-offline-context-"));
const report = { version: 1, evaluationKind: "offline_deterministic_context_regression_and_warm_latency", startedAt,
  repository: { commitAtStart: git("rev-parse", "HEAD"), workingTreeDirtyAtStart: !!git("status", "--porcelain"), codeSha256: startCode },
  environment: { fixtureLabel: "Managed Linux implementation workspace; not the proposed reference VM or target Mac", platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version,
    cpuModel: os.cpus()[0]?.model ?? null, logicalCPUsReported: os.cpus().length, availableParallelism: os.availableParallelism(),
    cgroupCpuMax: await maybeRead("/sys/fs/cgroup/cpu.max"), cgroupMemoryMaxBytes: await maybeRead("/sys/fs/cgroup/memory.max"), hostMemoryBytesReported: os.totalmem(), loadAverageAtStart: os.loadavg(),
    network: "disabled by harness; no provider or embedding request", concurrency: "single sequential evaluation process; other workspace load not controlled" },
  configuration: { knowledge: true, memory: true, continuity: true, semanticRetrieval: false, embeddingProvider: null, backgroundIndexing: false,
    purpose: "cloud", nativeFixtureGrantsCloudAllowed: true, packetBudget: { maxBytes: 32768, maxTokens: 12000, maxItems: 12 },
    measuredBoundary: "createContextRuntime.current(): source/memory/history/checkpoint retrieval, current authorization, packet budgeting, final reauthorization, durable usage manifest",
    excluded: ["corpus import", "service startup", "warmup", "Eve or model inference", "network", "HTTP routing", "SwiftUI", "audio", "remote retained-context brokers"],
    scopeAndHistory: "Deterministic in-process contextSnapshot fixture; production KnowledgeService, MemoryService, ContinuityService and createContextRuntime" },
  fixture: { path: fixturePath, sha256: sha(fixtureBytes), sourceCount: fixture.sources.length, sourceTextBytes: fixture.sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0),
    queries: fixture.cases.length, historyMessages: 12, projectMemoryFacts: 30, globalPinnedPreferences: 1, excludedForeignMemories: 1, excludedNoCloudMemories: 1,
    continuityProjects: 20, sessionsPerProject: 5, approvedPins: 1, sourceDigests: fixture.sources.map(source => ({ id: source.id, sha256: sha(source.text) })) },
  retrieval: { cases: [], expectedTopK: 3, passed: 0, failed: 0, citationFailures: 0, foreignResults: 0 },
  continuity: { projects: [], eventReplayChecks: 0, restart: false, pinsSurvived: false, passed: 0, failed: 0 },
  contextAssembly: { warmupAttempts: options.warmup, warmupFailures: [], attempts: options.samples, samples: [], failures: [], expectedSourceSelected: 0, sourceCitationFailures: 0, scopeFailures: 0 },
  finalAuthorization: { measured: options.finalAuthorization, boundary: "Synchronous runtime.assembler.revalidate(packet), matching the final HTTP disclosure guard; JSON/network send excluded", samples: [], failures: [] },
  limitations: ["Tiny synthetic 30-source corpus with direct lexical labels; not research quality or difficult personal-corpus retrieval.",
    "No E5 weights provisioned or loaded, no neural retrieval/reranking quality measured.", "No human or expert review and no model-generated answers.",
    "Managed Linux workspace is not a reference VM or physical Mac; shared workload and storage are uncontrolled.",
    "Warm in-process assembly latency is not UI feedback, first audio, end-to-end turn latency, or a release gate pass.",
    "20×5 continuity checks validate durable scope/replay/pin behavior, not semantic episodic understanding."],
  liveGates: { e5Inference: "unrun", humanRetrievalReview: "unrun", fixed30Tasks: "unrun", physicalMacLatency: "unrun", referenceVMPerformance: "unrun" } };
let knowledge, memory, continuity;
const ids = new Map(), grants = new Map();
let currentQuery = "Offline fixture query";
const projectId = "fixture", conversationId = "fixture-conversation", taskId = "fixture-task";
const scope = { projectId, conversationId, taskId };
const native = { nativeAuthenticated: true };
const errorRecord = error => ({ name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 500) });
const projectName = index => index === 0 ? projectId : `project-${index}`;
try {
  knowledge = await KnowledgeService.open({ dataDirectory: directory, enabled: true, backgroundIndexing: false });
  memory = await MemoryService.open({ dataDirectory: directory, enabled: true, backgroundIndexing: false, resolveSource(reference, access) {
    try { const found = knowledge.readPassage(reference.passageId, access.projectId, access.purpose); return found.source.id === reference.sourceVersionId; } catch { return false; }
  } });
  const continuityOptions = { dataDirectory: directory, enabled: true, authorizeReference(reference, access) {
    if (reference.kind === "memory") return memory.authorize(reference, access);
    if (reference.kind === "source") { try { const found = knowledge.readPassage(reference.id, access.projectId, access.purpose); return found.source.id === reference.sourceVersionId && found.source.revision === reference.revision; } catch { return false; } }
    return false;
  } };
  continuity = await ContinuityService.open(continuityOptions);
  for (const source of fixture.sources) {
    const grant = knowledge.createGrant({ projectId, resourceKind: "file", resourceId: source.id, label: source.id, operations: ["read_document"], cloudAllowed: true, expiresAt: null });
    const value = await knowledge.importSource({ projectId, grantId: grant.id, resourceId: source.id, filename: `${source.id}.md`, title: source.id, mediaType: "text/markdown", bytesBase64: Buffer.from(source.text).toString("base64") });
    ids.set(source.id, value); grants.set(source.id, grant);
    await memory.create({ kind: "fact", scope: { kind: "project", projectId }, text: source.text, confidence: 1, pinned: false, expiresAt: null, cloudAllowed: true,
      provenance: { origin: "explicit_user", references: [{ type: "knowledge", projectId, sourceVersionId: value.source.id, passageId: value.passages[0].id }] } }, native);
  }
  const preferenceInput = { kind: "preference", scope: { kind: "global" }, text: "Use plain language and cite selected source passages.", confidence: 1, pinned: true, expiresAt: null, cloudAllowed: true,
    provenance: { origin: "explicit_user", references: [] } };
  const preference = await memory.create(preferenceInput, native);
  await memory.create({ ...preferenceInput, scope: { kind: "project", projectId: "foreign-project" }, text: "EXCLUDED_FOREIGN_MEMORY" }, native);
  await memory.create({ ...preferenceInput, cloudAllowed: false, text: "EXCLUDED_NO_CLOUD_MEMORY" }, native);
  for (let project = 0; project < 20; project++) for (let session = 0; session < 5; session++) {
    const input = { projectId: projectName(project), conversationId: `episode-conversation-${project}-${session}`, taskId: `episode-task-${project}-${session}`,
      eventId: `event-${project}-${session}`, status: "completed", goal: `Project ${project} session ${session}: review constraint ${project * 5 + session}`,
      occurredAt: `2026-11-0${session + 1}T12:00:00.000Z` };
    const saved = continuity.recordCommittedTask(input); assert.equal(continuity.recordCommittedTask(input).id, saved.id); report.continuity.eventReplayChecks++;
  }
  continuity.updateWorkingSet(projectId, { expectedRevision: 0, pins: [{ kind: "memory", id: preference.id, revision: preference.revision }], goal: "Continue reviewing selected evidence" });
  continuity.close(); continuity = await ContinuityService.open(continuityOptions); report.continuity.restart = true;
  report.continuity.pinsSurvived = continuity.getWorkingSet(projectId).pins[0]?.id === preference.id;
  for (let project = 0; project < 20; project++) {
    const checkpoint = continuity.checkpoint(projectName(project), "cloud");
    const uniqueSessions = new Set(checkpoint.episodes.map(episode => episode.conversationId)).size;
    const exactScope = checkpoint.episodes.every(episode => episode.projectId === projectName(project));
    const allGoals = Array.from({ length: 5 }, (_, session) => checkpoint.text.includes(`constraint ${project * 5 + session}`)).every(Boolean);
    const authorized = continuity.authorizeCheckpoint(checkpoint.id, checkpoint.revision, projectName(project), "cloud");
    const passed = checkpoint.episodes.length === 5 && uniqueSessions === 5 && exactScope && allGoals && authorized;
    report.continuity.projects.push({ projectId: projectName(project), episodes: checkpoint.episodes.length, uniqueSessions, exactScope, allGoals, authorized, status: passed ? "passed" : "failed" });
    report.continuity[passed ? "passed" : "failed"]++;
  }
  console.log("Corpus imported; 20-project restart/continuity checks completed.");
  for (const item of fixture.cases) {
    const result = await knowledge.retrieveContext({ projectId, query: item.query, purpose: "cloud", limit: 3, indexBudget: 0 });
    const rank = result.matches.findIndex(match => match.source.id === ids.get(item.expectedSource).source.id) + 1;
    const exactCitations = result.matches.every(match => knowledge.readPassage(match.passage.id, projectId, "cloud").passage.text === match.passage.text);
    const exactScope = result.matches.every(match => match.source.projectId === projectId);
    const passed = rank > 0 && exactCitations && exactScope;
    report.retrieval.cases.push({ id: item.id, expectedSource: item.expectedSource, rank: rank || null, exactCitations, exactScope, status: passed ? "passed" : "failed" });
    report.retrieval[passed ? "passed" : "failed"]++; if (!exactCitations) report.retrieval.citationFailures++; if (!exactScope) report.retrieval.foreignResults++;
  }
  const history = Array.from({ length: 12 }, (_, index) => ({ id: `history-${index}`, text: `Earlier explicit user turn ${index}: keep the selected project evidence inspectable.`, createdAt: `2026-11-09T10:${String(index).padStart(2, "0")}:00.000Z`, role: "user", taskId: `history-task-${index}` }));
  const runtime = createContextRuntime({ contextSnapshot(project, conversation, task) {
    if (project !== projectId || conversation && conversation !== conversationId || task && task !== taskId) throw new Error("Fixture scope mismatch");
    return { currentTurn: currentQuery, messages: history, actions: [{ id: taskId, conversationId, status: "running", pendingApprovals: 0, title: "Offline fixture turn" }] };
  } }, knowledge, memory, continuity);
  for (let index = 0; index < options.warmup; index++) {
    currentQuery = fixture.cases[index % fixture.cases.length].query;
    try { await runtime.current(scope, currentQuery); } catch (error) { report.contextAssembly.warmupFailures.push({ index, ...errorRecord(error) }); }
  }
  console.log(`Warmup complete (${options.warmup} attempts); measuring ${options.samples} sequential context assemblies.`);
  for (let index = 0; index < options.samples; index++) {
    const item = fixture.cases[index % fixture.cases.length]; currentQuery = item.query;
    const start = performance.now(); profilingActive = options.profile;
    try {
      const packet = await runtime.current(scope, currentQuery), milliseconds = performance.now() - start; profilingActive = false;
      if (options.finalAuthorization) {
        const authorizationStart = performance.now();
        try { runtime.assembler.revalidate(packet); report.finalAuthorization.samples.push({ index, caseId: item.id, milliseconds: Number((performance.now() - authorizationStart).toFixed(6)) }); }
        catch (error) { report.finalAuthorization.failures.push({ index, caseId: item.id, ...errorRecord(error) }); }
      }
      const exactScope = packet.selections.every(selection => selection.projectId === projectId) && !JSON.stringify(packet).includes("EXCLUDED_");
      const exactCitations = packet.selections.filter(selection => selection.kind === "source").every(selection => selection.citations.every(citation => {
        const found = knowledge.readPassage(citation.passageId, projectId, "cloud"); return found.source.id === citation.sourceVersionId && sha(found.passage.text) === selection.originalSha256;
      }));
      const found = packet.selections.some(selection => selection.kind === "source" && selection.citations.some(citation => citation.sourceVersionId === ids.get(item.expectedSource).source.id));
      if (found) report.contextAssembly.expectedSourceSelected++; if (!exactCitations) report.contextAssembly.sourceCitationFailures++; if (!exactScope) report.contextAssembly.scopeFailures++;
      report.contextAssembly.samples.push({ index, caseId: item.id, milliseconds: Number(milliseconds.toFixed(6)), selectedItems: packet.selections.length, packetBytes: packet.usage.serializedBytes,
        expectedSourceSelected: found, exactCitations, exactScope, selectedKinds: packet.selections.reduce((counts, selection) => ({ ...counts, [selection.kind]: (counts[selection.kind] ?? 0) + 1 }), {}) });
    } catch (error) { profilingActive = false; report.contextAssembly.failures.push({ index, caseId: item.id, ...errorRecord(error) }); }
    if ((index + 1) % 100 === 0) console.log(`Measured ${index + 1}/${options.samples} context assemblies.`);
  }
} catch (error) { report.executionError = errorRecord(error); }
finally {
  continuity?.close(); await memory?.close(); knowledge?.close();
  report.storage = {};
  for (const name of ["knowledge/knowledge.sqlite", "memory/memory.sqlite", "continuity/continuity.sqlite"]) { try { report.storage[name] = (await stat(path.join(directory, name))).size; } catch { report.storage[name] = null; } }
  await rm(directory, { recursive: true, force: true });
}
const times = report.contextAssembly.samples.map(sample => sample.milliseconds).sort((a, b) => a - b);
const percentile = percent => times.length ? times[Math.max(0, Math.ceil(times.length * percent) - 1)] : null;
report.contextAssembly.timing = { unit: "milliseconds", method: "nearest_rank", successfulSamples: times.length, failedSamples: report.contextAssembly.failures.length,
  p50: percentile(0.5), p95: percentile(0.95), min: times[0] ?? null, max: times.at(-1) ?? null,
  mean: times.length ? Number((times.reduce((sum, value) => sum + value, 0) / times.length).toFixed(6)) : null };
if (options.finalAuthorization) {
  const values = report.finalAuthorization.samples.map(sample => sample.milliseconds).sort((left, right) => left - right);
  report.finalAuthorization.timing = { unit: "milliseconds", method: "nearest_rank", successfulSamples: values.length, failedSamples: report.finalAuthorization.failures.length,
    p50: values[Math.ceil(values.length * 0.5) - 1] ?? null, p95: values[Math.ceil(values.length * 0.95) - 1] ?? null, min: values[0] ?? null, max: values.at(-1) ?? null };
}
if (options.profile) report.phaseProfile = { scope: "Only calls begun during measured current(); setup, warmup and post-timing assertions excluded", timings: "Inclusive and overlapping; do not sum nested phase durations", phases: [...phaseDurations].map(([name, durations]) => {
  durations.sort((left, right) => left - right);
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  return { name, calls: durations.length, callsPerAssembly: durations.length / Math.max(1, times.length), totalMs,
    p50Ms: durations[Math.ceil(durations.length * 0.5) - 1], p95Ms: durations[Math.ceil(durations.length * 0.95) - 1], meanMs: totalMs / durations.length };
}).sort((left, right) => right.totalMs - left.totalMs) };
report.repository.commitAtEnd = git("rev-parse", "HEAD"); report.repository.codeStableDuringRun = JSON.stringify(startCode) === JSON.stringify(await fingerprints());
report.environment.loadAverageAtEnd = os.loadavg(); report.completedAt = new Date().toISOString();
report.status = report.executionError || report.retrieval.failed || report.continuity.failed || !report.continuity.pinsSurvived || report.contextAssembly.failures.length || report.finalAuthorization.failures.length || report.contextAssembly.warmupFailures.length || report.contextAssembly.scopeFailures || report.contextAssembly.sourceCitationFailures || !report.repository.codeStableDuringRun ? "failed" : "completed";
await mkdir(path.dirname(options.output), { recursive: true }); await writeFile(options.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ report: options.output, status: report.status, retrieval: `${report.retrieval.passed}/150`, continuity: `${report.continuity.passed}/20`, contextAssembly: report.contextAssembly.timing,
  expectedSourceSelected: `${report.contextAssembly.expectedSourceSelected}/${options.samples}`, liveE5: "unrun", referenceVM: false }));
if (report.status !== "completed") process.exitCode = 1;
