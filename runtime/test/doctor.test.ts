import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { getDataDirectory } from "../agent/lib/persistence.ts";

// The preflight is plain JavaScript so it can run before dependencies are installed.
const { dataDirectory, describeModel, diagnose } = await import(new URL("../../scripts/doctor.mjs", import.meta.url).href);

test("the preflight resolves the same data directory as the runtime", () => {
  assert.equal(dataDirectory({ JARVIS_DATA_DIR: "/fixture/data" }, "linux"), "/fixture/data");
  assert.equal(dataDirectory({ JARVIS_DATA_DIR: "~/jarvis" }, "linux"), path.join(homedir(), "jarvis"));
  assert.equal(dataDirectory({}, "darwin"), path.join(homedir(), "Library", "Application Support", "JarvisRoy"));
  assert.equal(dataDirectory({}, "linux"), path.join(homedir(), ".local", "share", "jarvis-roy"));
  assert.equal(dataDirectory({ XDG_DATA_HOME: "/fixture/xdg" }, "linux"), "/fixture/xdg/jarvis-roy");
  assert.equal(dataDirectory({ XDG_DATA_HOME: "relative" }, "linux"), path.join(homedir(), ".local", "share", "jarvis-roy"));
  const saved = { data: process.env.JARVIS_DATA_DIR, xdg: process.env.XDG_DATA_HOME };
  try {
    delete process.env.JARVIS_DATA_DIR; delete process.env.XDG_DATA_HOME;
    assert.equal(getDataDirectory(), dataDirectory({}, process.platform));
    process.env.XDG_DATA_HOME = "/fixture/xdg";
    assert.equal(getDataDirectory(), dataDirectory({ XDG_DATA_HOME: "/fixture/xdg" }, process.platform));
  } finally {
    for (const [name, value] of [["JARVIS_DATA_DIR", saved.data], ["XDG_DATA_HOME", saved.xdg]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("a model is described only when the gateway lists it as a language model", () => {
  const catalog = { data: [
    { id: "vendor/chat", type: "language", context_window: 200000, pricing: { input: "0.000004", output: "0.00002" } },
    { id: "vendor/embed", type: "embedding", pricing: { input: "0.0000001" } },
  ] };
  assert.deepEqual(describeModel(catalog, "vendor/chat"), { contextWindow: 200000, input: "$4.00", output: "$20.00" });
  assert.equal(describeModel(catalog, "vendor/embed"), null);
  assert.equal(describeModel(catalog, "vendor/missing"), null);
  assert.equal(describeModel(null, "vendor/chat"), null);
});

test("an offline preflight reports a missing reasoning credential without printing any secret", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-doctor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await diagnose({ offline: true, env: { JARVIS_DATA_DIR: directory } });
  const byId = Object.fromEntries(report.checks.map((check: { id: string }) => [check.id, check]));
  assert.equal(byId.node.status, "ok");
  assert.equal(byId.data.status, "ok");
  assert.equal(byId.model.status, "skip");
  assert.match(byId.model.title, /openai\/gpt-6-sol-fast/);

  const env = { PATH: process.env.PATH, HOME: process.env.HOME, JARVIS_DATA_DIR: directory, AI_GATEWAY_API_KEY: "fixture-doctor-secret-value" };
  const script = new URL("../../scripts/doctor.mjs", import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [script, "--offline", "--json"], { env }).catch(error => error);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.checks.find((check: { id: string }) => check.id === "gateway-key").status, "ok");
  assert.doesNotMatch(stdout, /fixture-doctor-secret-value/);
});
