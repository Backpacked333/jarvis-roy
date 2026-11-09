#!/usr/bin/env node
// Local report scaffolding/validation only. Never calls providers or runs tasks.
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const suiteBytes = await readFile(new URL("./tasks.json", import.meta.url));
const suite = JSON.parse(suiteBytes);
const suiteDigest = createHash("sha256").update(suiteBytes).digest("hex");
if (suite.version !== 1 || suite.tasks.length !== 30 || new Set(suite.tasks.map(task => task.id)).size !== 30) {
  throw new Error("Expected the fixed version-1 suite of 30 unique tasks.");
}
const metrics = {
  interruption: { percentile: 0.95, targetMs: 250 },
  visibleFeedback: { percentile: 0.95, targetMs: 150 },
  firstMeaningfulAudio: { percentile: 0.5, targetMs: 3000 },
};
const flags = ["assistant", "knowledge", "research", "voiceApproval", "desktop", "appleServices", "terminal"];
function freshReport() {
  return {
    version: 1, createdAt: new Date().toISOString(), suite: { version: 1, sha256: suiteDigest },
    fixture: {
      commit: null, reviewer: null,
      mac: { model: null, chip: null, memoryGiB: null, macOS: null },
      network: { description: null, latencyMs: null },
      audio: { input: null, output: null, route: null, sampleRateHz: null },
      models: { interactive: null, deep: null, speech: null, transcription: null },
      flags: Object.fromEntries(flags.map(flag => [flag, false])), sources: [], analysisImage: null, notes: "",
    },
    tasks: suite.tasks.map(task => ({ id: task.id, status: "unrun", score: null, executedAt: null, evidencePaths: [], notes: "" })),
    performance: Object.fromEntries(Object.keys(metrics).map(name => [name, {
      samplesMs: [], failedSamples: 0, missingSamples: 0, method: null, evidencePaths: [], notes: "",
    }])),
  };
}
const fail = message => { throw new Error(message); };
function object(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail(`${path}: unexpected or missing fields`);
}
function string(value, path, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length > 32_000 || (nullable && !value.trim())) fail(`${path}: expected ${nullable ? "nonempty string or null" : "string"}`);
}
function number(value, path, nullable = false, integer = false) {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) fail(`${path}: expected nonnegative ${integer ? "integer" : "number"}${nullable ? " or null" : ""}`);
}
function date(value, path, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${path}: expected ISO date${nullable ? " or null" : ""}`);
}
async function evidence(paths, base, name) {
  if (!Array.isArray(paths) || paths.length > 100 || new Set(paths).size !== paths.length) fail(`${name}: expected up to 100 unique paths`);
  for (const path of paths) {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0") || !resolve(base, path).startsWith(`${base}${sep}`)) fail(`${name}: use paths within the report directory`);
    try { if (!(await stat(resolve(base, path))).isFile()) fail(`${name}: evidence must be a file`); }
    catch { fail(`${name}: evidence file missing: ${path}`); }
  }
}
async function validate(report, base) {
  object(report, ["version", "createdAt", "suite", "fixture", "tasks", "performance"], "report");
  if (report.version !== 1) fail("Unsupported report version");
  date(report.createdAt, "createdAt");
  object(report.suite, ["version", "sha256"], "suite");
  if (report.suite.version !== 1 || report.suite.sha256 !== suiteDigest) fail("Report belongs to another task-suite revision");
  const fixture = report.fixture;
  object(fixture, ["commit", "reviewer", "mac", "network", "audio", "models", "flags", "sources", "analysisImage", "notes"], "fixture");
  for (const field of ["commit", "reviewer", "analysisImage"]) string(fixture[field], `fixture.${field}`, true);
  if (fixture.commit !== null && !/^[a-f0-9]{40}$/.test(fixture.commit)) fail("fixture.commit: expected full Git SHA");
  for (const [group, fields] of Object.entries({ mac: ["model", "chip", "memoryGiB", "macOS"], network: ["description", "latencyMs"], audio: ["input", "output", "route", "sampleRateHz"], models: ["interactive", "deep", "speech", "transcription"] })) {
    object(fixture[group], fields, `fixture.${group}`);
    for (const field of fields) {
      if (["memoryGiB", "latencyMs", "sampleRateHz"].includes(field)) number(fixture[group][field], `fixture.${group}.${field}`, true);
      else string(fixture[group][field], `fixture.${group}.${field}`, true);
    }
  }
  object(fixture.flags, flags, "fixture.flags");
  if (Object.values(fixture.flags).some(flag => typeof flag !== "boolean")) fail("fixture.flags: expected booleans");
  string(fixture.notes, "fixture.notes");
  if (!Array.isArray(fixture.sources) || fixture.sources.length > 1000) fail("fixture.sources: expected bounded array");
  const labels = new Set();
  for (const source of fixture.sources) {
    object(source, ["label", "sha256"], "fixture.sources[]"); string(source.label, "source.label", true);
    if (source.label === null || labels.has(source.label) || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) fail("source: unique label and SHA-256 required");
    labels.add(source.label);
  }
  if (!Array.isArray(report.tasks) || report.tasks.length !== 30) fail("tasks: all 30 fixed task IDs are required");
  const ids = new Set(suite.tasks.map(task => task.id));
  for (const task of report.tasks) {
    object(task, ["id", "status", "score", "executedAt", "evidencePaths", "notes"], "task");
    if (!ids.delete(task.id)) fail("tasks: unknown or duplicate ID");
    if (!["unrun", "blocked", "passed", "partial", "failed"].includes(task.status)) fail(`${task.id}: invalid status`);
    string(task.notes, `${task.id}.notes`); date(task.executedAt, `${task.id}.executedAt`, true);
    await evidence(task.evidencePaths, base, task.id);
    if (["unrun", "blocked"].includes(task.status)) {
      if (task.score !== null) fail(`${task.id}: unrun/blocked score must be null`);
      if (task.status === "blocked" && !task.notes.trim()) fail(`${task.id}: record why blocked`);
    } else {
      const valid = task.status === "passed" ? task.score === 4 : task.status === "failed" ? task.score === 0 : Number.isInteger(task.score) && task.score >= 1 && task.score <= 3;
      if (!valid || task.executedAt === null || !task.notes.trim() || !task.evidencePaths.length) fail(`${task.id}: score, execution time, review notes and evidence required`);
    }
  }
  object(report.performance, Object.keys(metrics), "performance");
  for (const [name, metric] of Object.entries(report.performance)) {
    object(metric, ["samplesMs", "failedSamples", "missingSamples", "method", "evidencePaths", "notes"], name);
    if (!Array.isArray(metric.samplesMs) || metric.samplesMs.length > 10_000) fail(`${name}: invalid samples`);
    metric.samplesMs.forEach(sample => number(sample, `${name}.samplesMs[]`));
    number(metric.failedSamples, `${name}.failedSamples`, false, true); number(metric.missingSamples, `${name}.missingSamples`, false, true);
    string(metric.method, `${name}.method`, true); string(metric.notes, `${name}.notes`);
    await evidence(metric.evidencePaths, base, name);
    if (metric.samplesMs.length && (!metric.method || !metric.evidencePaths.length)) fail(`${name}: measurements need method and raw evidence`);
  }
}
function summarize(report) {
  const counts = Object.fromEntries(["unrun", "blocked", "passed", "partial", "failed"].map(status => [status, report.tasks.filter(task => task.status === status).length]));
  const fixtureMissing = ["commit", "reviewer", "mac.model", "mac.chip", "mac.memoryGiB", "mac.macOS", "network.description", "network.latencyMs", "audio.input", "audio.output", "audio.route", "audio.sampleRateHz", "models.interactive", "models.deep", "models.speech", "models.transcription"]
    .filter(path => path.split(".").reduce((value, key) => value[key], report.fixture) === null);
  if (!report.fixture.sources.length) fixtureMissing.push("sources");
  const performance = Object.fromEntries(Object.entries(report.performance).map(([name, metric]) => {
    const sorted = [...metric.samplesMs].sort((a, b) => a - b), definition = metrics[name];
    const observedMs = sorted.length ? sorted[Math.ceil(sorted.length * definition.percentile) - 1] : null;
    return [name, { validSamples: sorted.length, failedSamples: metric.failedSamples, missingSamples: metric.missingSamples,
      percentile: definition.percentile, observedMs, targetMs: definition.targetMs,
      sufficientSamples: sorted.length >= 30, meetsTargetAmongMeasuredSamples: sorted.length >= 30 ? observedMs <= definition.targetMs : null }];
  }));
  return { structuralValidation: "valid", capabilityVerification: "human_reported_not_independently_verified", counts,
    incompleteTasks: counts.unrun + counts.blocked, fixtureMissing, sourceDigestsRecorded: report.fixture.sources.length,
    performance, complete: counts.unrun + counts.blocked === 0 && fixtureMissing.length === 0 && Object.values(performance).every(metric => metric.sufficientSamples) };
}

try {
  const [command, path, option, ...rest] = process.argv.slice(2);
  if (!["init", "check"].includes(command) || !path || rest.length || (option !== undefined && (command !== "check" || option !== "--require-complete"))) {
    fail(`Usage: node ${fileURLToPath(import.meta.url)} init <report.json> | check <report.json> [--require-complete]`);
  }
  if (command === "init") {
    await writeFile(path, `${JSON.stringify(freshReport(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log("Created 30 unrun tasks. No inference, task execution or capability verification performed.");
  } else {
    const bytes = await readFile(path);
    if (bytes.length > 4 * 1024 * 1024) fail("Report exceeds 4 MiB");
    const report = JSON.parse(bytes);
    await validate(report, dirname(resolve(path)));
    const summary = summarize(report);
    console.log(JSON.stringify(summary, null, 2));
    if (option === "--require-complete" && !summary.complete) process.exitCode = 2;
  }
} catch (error) { console.error(`Evaluation report: ${error.message}`); process.exitCode = 1; }
