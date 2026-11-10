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
  await writeFile(path.join(root, "service-guard.mjs"), "// guard\n");
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await writeFile(path.join(root, "bridge", "server.ts"), "");
  await mkdir(path.join(root, "agent"), { recursive: true });
  await mkdir(path.join(root, "workers"), { recursive: true });
  for (const file of ["controller.py", "sandbox_ops.py", "requirements.txt"]) await writeFile(path.join(root, "workers", file), "");
}

/** A stand-in for a Node distribution: an executable with its licence one level up. */
async function fakeNode(root: string) {
  await mkdir(path.join(root, "bin"), { recursive: true });
  await copyFile(process.execPath, path.join(root, "bin", "node"));
  await chmod(path.join(root, "bin", "node"), 0o755);
  await writeFile(path.join(root, "LICENSE"), "licence\n");
  return path.join(root, "bin", "node");
}

test("staging refuses symlinks that escape the runtime tree and a missing build", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-stage-refuse-");
  const runtime = path.join(directory, "runtime");
  await fakeRuntime(runtime);
  const node = await fakeNode(path.join(directory, "node"));
  const install = async () => { throw new Error("install must not run"); };
  const out = path.join(directory, "Resources");
  await symlink("/etc", path.join(runtime, "agent", "escape"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node, install }), /escapes/);
  await rm(path.join(runtime, "agent", "escape"));
  await writeFile(path.join(directory, "outside.txt"), "outside");
  await symlink("../../outside.txt", path.join(runtime, "bridge", "outside-tree"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node, install }), /escap/);
  await rm(path.join(runtime, "bridge", "outside-tree"));
  await symlink(path.join(directory, "missing"), path.join(runtime, "bridge", "dangling"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node, install }), /dangling/);
  await rm(path.join(runtime, "bridge", "dangling"));
  await rm(path.join(runtime, "service-guard.mjs"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node, install }), /service-guard\.mjs/);
  await writeFile(path.join(runtime, "service-guard.mjs"), "// guard\n");
  await rm(path.join(runtime, ".output", "server", "index.mjs"));
  await assert.rejects(stage.stageRuntime({ runtime, out, node, install }), /built runtime/);
  // Nothing is left behind in Resources after a refusal.
  assert.deepEqual(existsSync(out) ? await readdir(out) : [], []);
  assert.throws(() => stage.parseArguments(["--runtime", "r", "--out", "o"]), /--node is required/);
  assert.throws(() => stage.parseArguments(["--runtime", "r", "--runtime", "r"]), /twice/);
  assert.throws(() => stage.parseArguments(["--launcher", "l"]), /Unknown argument/);
});

test("pruning removes build-only and Linux-only native packages at any depth", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-prune-");
  const modules = path.join(directory, "node_modules");
  for (const dir of ["rolldown", "@rolldown/binding-darwin-arm64", "@oxc-project/types", "eve/node_modules/rolldown", "eve/node_modules/@rolldown/pluginutils",
    "@huggingface/transformers", "onnxruntime-node", "onnxruntime-web", "onnxruntime-common", "sharp", "@img/sharp-darwin-arm64", "zod", "sqlite-vec", ".bin", "@scope/keep"]) {
    await mkdir(path.join(modules, dir), { recursive: true });
  }
  await stage.prunePackages(modules);
  assert.deepEqual((await readdir(modules)).sort(), ["@scope", "eve", "sqlite-vec", "zod"]);
  assert.deepEqual(await readdir(path.join(modules, "eve", "node_modules")), []);
  assert.deepEqual(await readdir(path.join(modules, "@scope")), ["keep"]);
});

test("staging lays out exactly the payload the app looks for and leaves its neighbours alone", async (t) => {
  const directory = await temporaryDirectory(t, "jarvis-stage-layout-");
  const runtime = path.join(directory, "runtime");
  await fakeRuntime(runtime);
  await writeFile(path.join(runtime, ".env"), "SECRET=never-copied\n");
  await writeFile(path.join(runtime, "bridge", ".env.local"), "SECRET=never-copied\n");
  await mkdir(path.join(runtime, "workers", ".venv"), { recursive: true });
  await mkdir(path.join(runtime, ".eve"), { recursive: true });
  await mkdir(path.join(runtime, "node_modules", "typescript"), { recursive: true });
  const node = await fakeNode(path.join(directory, "node"));
  const resources = path.join(directory, "Jarvis.app", "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, "AppIcon.icns"), "icon");
  await mkdir(path.join(resources, "runtime", "stale"), { recursive: true });
  // The production install is replaced by a fixture; the real one needs the network.
  const install = async (target: string) => {
    for (const dir of ["eve", "zod", "rolldown", ".bin"]) await mkdir(path.join(target, "node_modules", dir), { recursive: true });
    await writeFile(path.join(target, "node_modules", "eve", "package.json"), "{}");
  };
  const staged = await stage.stageRuntime({ runtime, out: resources, node, install });
  assert.equal(staged.node, path.join(resources, "node", "bin", "node"));
  assert.equal(staged.runtime, path.join(resources, "runtime"));
  assert.deepEqual((await readdir(resources)).sort(), ["AppIcon.icns", "node", "runtime"]);
  assert.deepEqual((await readdir(path.join(resources, "runtime"))).sort(),
    [".output", "agent", "bridge", "node_modules", "package-lock.json", "package.json", "service-guard.mjs", "workers"]);
  assert.deepEqual((await readdir(path.join(resources, "runtime", "node_modules"))).sort(), ["eve", "zod"]);
  assert.deepEqual((await readdir(path.join(resources, "runtime", "workers"))).sort(), ["controller.py", "requirements.txt", "sandbox_ops.py"]);
  assert.deepEqual(await readdir(path.join(resources, "runtime", "bridge")), ["server.ts"]);
  assert.equal((await stat(staged.node)).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(resources, "node", "LICENSE"), "utf8"), "licence\n");

  // The same layout is what the smoke check requires before it starts anything.
  await assert.rejects(smoke.smokeBundle(path.join(directory, "missing")), /bundle is missing/);
  const first = await smoke.fingerprint(resources);
  assert.deepEqual(await smoke.fingerprint(resources), first);
  await writeFile(path.join(resources, "runtime", "written-at-runtime"), "x");
  assert.notEqual((await smoke.fingerprint(resources)).digest, first.digest);
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
  // A packaged app must never point back at the machine that built it, and is checked before it is imaged.
  assert.match(script, /rm -f "\$RESOURCES\/runtime-location\.json"/);
  assert.ok(script.indexOf("smoke-bundle.mjs") < script.indexOf("hdiutil create"));
  assert.equal(spawnSync("bash", ["-n", path.join(scripts, "package-macos.sh")]).status, 0);
  const build = await readFile(path.join(scripts, "build-macos.sh"), "utf8");
  // A source build must not silently keep running a runtime left behind by packaging.
  assert.match(build, /rm -rf "\$APP\/Contents\/Resources\/runtime" "\$APP\/Contents\/Resources\/node"/);
  const node = await readFile(path.join(scripts, "..", "macos", "entitlements", "node.plist"), "utf8");
  for (const key of ["cs.allow-jit", "cs.allow-unsigned-executable-memory", "cs.disable-library-validation", "automation.apple-events"]) {
    assert.match(node, new RegExp(`<key>com\\.apple\\.security\\.${key.replace(/\./g, "\\.")}</key><true/>`));
  }
  const app = await readFile(path.join(scripts, "..", "macos", "entitlements", "jarvis.plist"), "utf8");
  assert.deepEqual([...app.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort(),
    ["com.apple.security.automation.apple-events", "com.apple.security.device.audio-input"]);
  const first = await readFile(path.join(scripts, "first-launch.txt"), "utf8");
  assert.match(first, /Open Anyway/);
  assert.match(script, /first-launch\.txt/);
});
