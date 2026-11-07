import { acquireServicePortsLock } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Packaging scripts are JavaScript so they run before any project transpilation.
const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const runtimeDir = fileURLToPath(new URL("../", import.meta.url));
const fetchNode = await import(new URL("../../scripts/fetch-node.mjs", import.meta.url).href);
const stage = await import(new URL("../../scripts/stage-runtime.mjs", import.meta.url).href);
const smoke = await import(new URL("../../scripts/smoke-bundle.mjs", import.meta.url).href);
const supervisorPath = path.join(scripts, "supervisor.mjs");
const builtRuntime = existsSync(path.join(runtimeDir, ".output", "server", "index.mjs"));

const PINS = {
  arm64: "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
  x64: "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
};

async function temporaryDirectory(t: { after: (fn: () => Promise<void>) => void }, prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(file: string) {
  try { await lstat(file); return true; } catch { return false; }
}

test("Node download is pinned to v24.22.2 with the documented SHA-256 per architecture", () => {
  assert.equal(fetchNode.NODE_VERSION, "v24.22.2");
  assert.deepEqual({ ...fetchNode.NODE_SHA256 }, PINS);
  assert.ok(Object.isFrozen(fetchNode.NODE_SHA256));
  const arm = fetchNode.nodeDistribution("arm64");
  assert.equal(arm.url, "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz");
  assert.equal(arm.sha256, PINS.arm64);
  assert.equal(arm.directory, "node-v24.22.2-darwin-arm64");
  const intel = fetchNode.nodeDistribution("x86_64");
  assert.equal(intel.arch, "x64");
  assert.equal(intel.url, "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-x64.tar.gz");
  assert.equal(intel.sha256, PINS.x64);
  for (const arch of ["ia32", "arm", "", "../x64"]) assert.throws(() => fetchNode.nodeDistribution(arch));
  assert.deepEqual(fetchNode.parseArguments(["--arch", "x64", "--out", "/o"]).arch, "x64");
  assert.throws(() => fetchNode.parseArguments(["--sha256", PINS.x64]), /Unknown argument/);
  assert.throws(() => fetchNode.parseArguments(["--arch"]), /requires a value/);
});

test("SHA-256 verification accepts only the exact pinned digest", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-hash-");
  const file = path.join(directory, "blob");
  await writeFile(file, "not node");
  const digest = createHash("sha256").update("not node").digest("hex");
  assert.equal(await fetchNode.verifySha256(file, digest), digest);
  await assert.rejects(fetchNode.verifySha256(file, PINS.arm64), /SHA-256 mismatch/);
  await assert.rejects(fetchNode.verifySha256(file, digest.toUpperCase()), /malformed/);
  await assert.rejects(fetchNode.verifySha256(file, ""), /malformed/);
});

test("a download that does not match the pin is discarded and never extracted", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-fetch-");
  const cacheDir = path.join(directory, "cache");
  const outDir = path.join(directory, "out");
  const urls: string[] = [];
  const download = async (url: string, destination: string) => { urls.push(url); await writeFile(destination, "tampered"); };
  await assert.rejects(fetchNode.ensureNode({ arch: "arm64", outDir, cacheDir, download }), /SHA-256 mismatch/);
  assert.deepEqual(urls, ["https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz"]);
  assert.equal(await exists(path.join(outDir, "bin", "node")), false);
  assert.deepEqual(await readdir(cacheDir), []);

  // A poisoned cache entry is re-downloaded (and still rejected), never trusted.
  await writeFile(path.join(cacheDir, "node-v24.22.2-darwin-arm64.tar.gz"), "poisoned");
  await assert.rejects(fetchNode.ensureNode({ arch: "arm64", outDir, cacheDir, download }), /SHA-256 mismatch/);
  assert.equal(urls.length, 2);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("a mistyped --out holding unrelated files is never replaced", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-fetch-out-");
  const outDir = path.join(directory, "out");
  await mkdir(path.join(outDir, "bin"), { recursive: true });
  await writeFile(path.join(outDir, "notes.txt"), "keep me");
  let downloads = 0;
  const download = async () => { downloads++; };
  await assert.rejects(fetchNode.ensureNode({ arch: "arm64", outDir, cacheDir: path.join(directory, "cache"), download }), /Refusing to replace/);
  assert.equal(downloads, 0);
  assert.equal(await readFile(path.join(outDir, "notes.txt"), "utf8"), "keep me");
  await rm(path.join(outDir, "notes.txt"));
  await writeFile(path.join(outDir, "bin", "npm"), "x");
  await assert.rejects(fetchNode.assertReplaceableOutput(outDir), /bin\/npm/);
  await rm(path.join(outDir, "bin", "npm"));
  await writeFile(path.join(outDir, "bin", "node"), "x");
  await writeFile(path.join(outDir, "LICENSE"), "x");
  await fetchNode.assertReplaceableOutput(outDir);
  await fetchNode.assertReplaceableOutput(path.join(directory, "absent"));
});

test("extraction takes only bin/node and LICENSE from the archive", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-extract-");
  const name = "node-v24.22.2-darwin-arm64";
  const source = path.join(directory, "src", name);
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "lib", "node_modules", "npm"), { recursive: true });
  await writeFile(path.join(source, "bin", "node"), "#!/bin/sh\n");
  await writeFile(path.join(source, "bin", "npm"), "extra");
  await writeFile(path.join(source, "LICENSE"), "license");
  await writeFile(path.join(source, "lib", "node_modules", "npm", "index.js"), "extra");
  const tarball = path.join(directory, "node.tar.gz");
  const result = spawnSync("tar", ["-czf", tarball, "-C", path.join(directory, "src"), name]);
  assert.equal(result.status, 0);
  const outDir = path.join(directory, "out");
  await mkdir(path.join(outDir, "stale"), { recursive: true });
  await fetchNode.extractNodeMembers(tarball, outDir, name);
  assert.deepEqual((await readdir(outDir)).sort(), ["LICENSE", "bin"]);
  assert.deepEqual(await readdir(path.join(outDir, "bin")), ["node"]);
  assert.equal((await stat(path.join(outDir, "bin", "node"))).mode & 0o777, 0o755);
  await assert.rejects(fetchNode.extractNodeMembers(tarball, outDir, "../evil"), /Unexpected archive/);
});

async function fakeRuntime(root: string) {
  await mkdir(path.join(root, ".output", "server"), { recursive: true });
  await writeFile(path.join(root, ".output", "server", "index.mjs"), "");
  for (const file of ["package.json", "package-lock.json"]) await writeFile(path.join(root, file), "{}");
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await writeFile(path.join(root, "bridge", "server.ts"), "");
  await mkdir(path.join(root, "agent"), { recursive: true });
  await mkdir(path.join(root, "workers"), { recursive: true });
  for (const file of ["controller.py", "sandbox_ops.py", "requirements.txt"]) await writeFile(path.join(root, "workers", file), "");
}

async function fakeLauncher(root: string) {
  await mkdir(root, { recursive: true });
  await copyFile(path.join(scripts, "launch-env.mjs"), path.join(root, "launch-env.mjs"));
  if (existsSync(supervisorPath)) await copyFile(supervisorPath, path.join(root, "supervisor.mjs"));
  else await writeFile(path.join(root, "supervisor.mjs"), "// placeholder until scripts/supervisor.mjs exists\n");
}

test("staging refuses symlinks that escape the runtime tree and a missing build", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-stage-refuse-");
  const runtime = path.join(directory, "runtime");
  const launcher = path.join(directory, "launcher");
  await fakeRuntime(runtime);
  await fakeLauncher(launcher);
  const install = async () => { throw new Error("install must not run"); };
  const out = path.join(directory, "Resources");
  await symlink("/etc", path.join(runtime, "agent", "escape"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node: process.execPath, launcher, install }), /escapes/);
  await rm(path.join(runtime, "agent", "escape"));
  await writeFile(path.join(directory, "outside.txt"), "outside");
  await symlink("../../outside.txt", path.join(runtime, "bridge", "outside-tree"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node: process.execPath, launcher, install }), /escap/);
  await rm(path.join(runtime, "bridge", "outside-tree"));
  await symlink(path.join(directory, "missing"), path.join(runtime, "bridge", "dangling"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node: process.execPath, launcher, install }), /dangling/);
  await rm(path.join(runtime, "bridge", "dangling"));
  await rm(path.join(runtime, ".output", "server", "index.mjs"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node: process.execPath, launcher, install }), /built runtime/);
  // Nothing is left behind in Resources after a refusal.
  assert.deepEqual(existsSync(out) ? await readdir(out) : [], []);
  assert.throws(() => stage.parseArguments(["--runtime", "r", "--out", "o", "--node", "n"]), /--launcher is required/);
  assert.throws(() => stage.parseArguments(["--runtime", "r", "--runtime", "r"]), /twice/);
});

test("pruning removes build-only native packages at any depth", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-prune-");
  const modules = path.join(directory, "node_modules");
  for (const dir of ["rolldown", "@rolldown/binding-darwin-arm64", "@oxc-project/types", "eve/node_modules/rolldown", "eve/node_modules/@rolldown/pluginutils", "zod", ".bin", "@scope/keep"]) {
    await mkdir(path.join(modules, dir), { recursive: true });
  }
  await stage.prunePackages(modules);
  assert.deepEqual((await readdir(modules)).sort(), ["@scope", "eve", "zod"]);
  assert.deepEqual(await readdir(path.join(modules, "eve", "node_modules")), []);
  assert.deepEqual(await readdir(path.join(modules, "@scope")), ["keep"]);
});

test("staging the real runtime produces exactly the documented bundle payload", { skip: !builtRuntime && "runtime/.output is not built", timeout: 300_000 }, async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-stage-");
  const app = path.join(directory, "Jarvis.app");
  const resources = path.join(app, "Contents", "Resources");
  const launcher = path.join(directory, "launcher");
  await fakeLauncher(launcher);
  // Content not owned by the stager survives; stale owned content is replaced.
  await mkdir(path.join(resources, "runtime", "stale"), { recursive: true });
  // A staging directory left by a killed run must not end up sealed into the bundle.
  await mkdir(path.join(resources, ".jarvis-stage-leftover", "runtime"), { recursive: true });
  await writeFile(path.join(resources, "AppIcon.icns"), "icon");
  await stage.stageRuntime({ runtime: runtimeDir, out: resources, node: process.execPath, launcher });

  assert.deepEqual((await readdir(resources)).sort(), ["AppIcon.icns", "launcher", "node", "runtime"]);
  assert.deepEqual((await readdir(path.join(resources, "node"))).sort(), ["LICENSE", "bin"]);
  assert.equal((await stat(path.join(resources, "node", "bin", "node"))).mode & 0o111, 0o111);
  assert.deepEqual((await readdir(path.join(resources, "launcher"))).sort(), ["launch-env.mjs", "supervisor.mjs"]);
  const staged = path.join(resources, "runtime");
  assert.deepEqual((await readdir(staged)).sort(), [".output", "agent", "bridge", "node_modules", "package-lock.json", "package.json", "workers"]);
  assert.deepEqual((await readdir(path.join(staged, "workers"))).sort(), ["controller.py", "requirements.txt", "sandbox_ops.py"]);
  assert.ok(await exists(path.join(staged, ".output", "server", "index.mjs")));
  assert.ok(await exists(path.join(staged, "bridge", "server.ts")));
  assert.ok(await exists(path.join(staged, "agent", "agent.ts")));
  for (const present of ["eve", "zod", "ws"]) assert.ok(await exists(path.join(staged, "node_modules", present)), `${present} present`);
  for (const absent of ["rolldown", "@rolldown", "@oxc-project", "typescript", "@types", ".bin"]) {
    assert.equal(await exists(path.join(staged, "node_modules", absent)), false, `${absent} absent`);
  }
  for (const absent of ["test", ".eve", ".env", "workers/.venv", "stale", "tsconfig.json"]) {
    assert.equal(await exists(path.join(staged, absent)), false, `${absent} absent`);
  }
  // No environment files or state anywhere in the payload.
  const offenders: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".env") || entry.name === ".eve" || entry.name === ".venv") offenders.push(path.join(dir, entry.name));
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
  }
  await walk(resources);
  assert.deepEqual(offenders, []);
  assert.deepEqual((await readdir(resources)).filter((name) => name.startsWith(".jarvis-stage-")), []);

  // The staged sources load with the staged dependencies alone (no rolldown, no dev deps).
  const node = path.join(resources, "node", "bin", "node");
  const check = spawnSync(node, ["--check", path.join(staged, ".output", "server", "index.mjs")], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const load = spawnSync(node, ["--input-type=module", "-e", "await import('./bridge/server.ts'); await import('eve/tools'); await import('zod'); await import('ws');"], {
    cwd: staged, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: directory }, timeout: 60_000,
  });
  assert.equal(load.status, 0, load.stderr);

  // Re-running is idempotent.
  await stage.stageRuntime({ runtime: runtimeDir, out: resources, node: process.execPath, launcher });
  assert.deepEqual((await readdir(resources)).sort(), ["AppIcon.icns", "launcher", "node", "runtime"]);

  await t.test("smoke test passes against the staged Linux app", { skip: !existsSync(supervisorPath) && "scripts/supervisor.mjs does not exist yet" }, async (st) => {
    const release = await acquireServicePortsLock();
    st.after(release);
    if ((await smoke.portAcceptingConnections(39201)) || (await smoke.portAcceptingConnections(39202))) {
      st.skip("ports 39201/39202 are in use");
      return;
    }
    const helper = path.join(app, "Contents", "Helpers", "JarvisControl.app", "Contents", "MacOS", "JarvisControl");
    await mkdir(path.dirname(helper), { recursive: true });
    await writeFile(helper, "#!/bin/sh\nexit 0\n");
    await chmod(helper, 0o755);
    const run = spawnSync(process.execPath, [path.join(scripts, "smoke-bundle.mjs"), app], { encoding: "utf8", timeout: 240_000 });
    if (run.status !== 0 && /already in use|Another Jarvis instance/.test(run.stderr)) {
      st.skip("ports 39201/39202 became busy (another test is using them)");
      return;
    }
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Smoke test passed \(7 checks\)/);
    assert.doesNotMatch(run.stdout + run.stderr, /smoke-test-not-a-real-key/);
    for (const line of run.stdout.split("\n")) assert.doesNotMatch(line, /[0-9a-f]{64}/);
  });
});

test("smoke helpers detect leaks and describe the bundle layout", () => {
  const paths = smoke.bundlePaths("/Applications/Jarvis.app");
  assert.equal(paths.node, "/Applications/Jarvis.app/Contents/Resources/node/bin/node");
  assert.equal(paths.supervisor, "/Applications/Jarvis.app/Contents/Resources/launcher/supervisor.mjs");
  assert.equal(paths.helper, "/Applications/Jarvis.app/Contents/Helpers/JarvisControl.app/Contents/MacOS/JarvisControl");
  const token = "cd".repeat(32);
  const line = smoke.smokePayload(token);
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), { version: 1, token, secrets: { AI_GATEWAY_API_KEY: "smoke-test-not-a-real-key" }, config: { JARVIS_MODEL: "openai/gpt-4.1-mini" } });
  assert.deepEqual(smoke.leakedSecrets(`{"event":"failed","reason":"${token}"}`, [token, smoke.DUMMY_KEY]), [token]);
  assert.deepEqual(smoke.leakedSecrets('{"event":"ready"}', [token, smoke.DUMMY_KEY]), []);
  assert.equal(smoke.redact(`a ${token} b`, [token]), "a [REDACTED] b");
  assert.deepEqual(smoke.parseEvent('{"event":"stopped","clean":true}'), { event: "stopped", clean: true });
  assert.equal(smoke.parseEvent("not json"), undefined);
  const env = smoke.minimalEnvironment({ home: "/h", temp: "/t" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "LOGNAME", "PATH", "TMPDIR", "USER"]);
});

test("package script follows the documented signing and notarization rules", async () => {
  const script = await readFile(path.join(scripts, "package-macos.sh"), "utf8");
  assert.ok(script.startsWith("#!/bin/bash\n"));
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /uname -s\)" != Darwin/);
  assert.match(script, /--identifier ai\.backpacked\.jarvisroy\.control/);
  assert.match(script, /--options runtime --timestamp/);
  assert.match(script, /hdiutil create -volname "Jarvis" -srcfolder "\$STAGE" -fs HFS\+ -format UDZO/);
  assert.match(script, /Ad-hoc signed apps cannot be notarized/);
  assert.doesNotMatch(script, /codesign[^\n]*--deep[^\n]*--sign/);
  const syntax = spawnSync("bash", ["-n", path.join(scripts, "package-macos.sh")]);
  assert.equal(syntax.status, 0);
  const node = await readFile(path.join(scripts, "..", "macos", "entitlements", "node.plist"), "utf8");
  for (const key of ["cs.allow-jit", "cs.allow-unsigned-executable-memory", "cs.disable-library-validation", "automation.apple-events"]) {
    assert.match(node, new RegExp(`<key>com\\.apple\\.security\\.${key.replace(/\./g, "\\.")}</key><true/>`));
  }
  const app = await readFile(path.join(scripts, "..", "macos", "entitlements", "jarvis.plist"), "utf8");
  assert.deepEqual([...app.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort(),
    ["com.apple.security.automation.apple-events", "com.apple.security.device.audio-input"]);
});
