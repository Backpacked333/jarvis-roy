import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
const backup = await import(new URL("../../scripts/cloud-backup.mjs", import.meta.url).href);
const { deploymentFiles, renderDeployment } = await import(new URL("../../scripts/cloud-render.mjs", import.meta.url).href);
const { cloudEnvironment } = await import(new URL("../../scripts/cloud-runtime.mjs", import.meta.url).href);
const recovery = await import(new URL("../../scripts/cloud-recovery.mjs", import.meta.url).href);
const { inspectCloudConfiguration, runCloudReadiness } = await import(new URL("../../scripts/cloud-readiness.mjs", import.meta.url).href);
async function directory(t: TestContext) {
  const value = await mkdtemp(path.join(tmpdir(), "jarvis-deploy-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(value, { recursive: true, force: true }); });
  return value;
}

test("deployment renders disabled service artifacts with private ports, ordered deny routes and no credentials", async (t) => {
  const output = path.join(await directory(t), "prepared");
  const result = await renderDeployment(output, { domain: "jarvis.example.com" });
  assert.equal(result.activated, false);
  const caddy = await readFile(path.join(output, "Caddyfile"), "utf8");
  assert.match(caddy, /route \{[\s\S]*respond @native 404[\s\S]*reverse_proxy @cloud 127\.0\.0\.1:39300[\s\S]*respond 404/);
  assert.match(caddy, /header_up -X-Jarvis-Native-Token/);
  assert.match(await readFile(path.join(output, "jarvis-bridge.service"), "utf8"), /NoNewPrivileges=true/);
  assert.throws(() => deploymentFiles({ domain: "evil.example\nreverse_proxy 1.2.3.4" }));
  await assert.rejects(renderDeployment(output, { domain: "jarvis.example.com" }));
});

test("cloud role environments separate broker, native and provider authority without forwarding credentials to Eve", () => {
  const source = { JARVIS_LOCAL_TOKEN: "local", JARVIS_NATIVE_TOKEN: "native", JARVIS_CLOUD_RUNTIME_TOKEN: "broker", JARVIS_CLOUD_BOOTSTRAP_TOKEN: "bootstrap",
    AI_GATEWAY_API_KEY: "provider", JARVIS_INTEGRATION_KEY: "integration", JARVIS_GOOGLE_CLIENT_SECRET: "google", JARVIS_DATA_DIR: "/state", NODE_OPTIONS: "private", RANDOM_SECRET: "private" };
  const runtime = cloudEnvironment("runtime", source), gateway = cloudEnvironment("gateway", source), bridge = cloudEnvironment("bridge", source);
  assert.equal(runtime.AI_GATEWAY_API_KEY, "provider");
  for (const key of ["JARVIS_NATIVE_TOKEN", "JARVIS_CLOUD_RUNTIME_TOKEN", "JARVIS_CLOUD_BOOTSTRAP_TOKEN", "JARVIS_INTEGRATION_KEY", "JARVIS_GOOGLE_CLIENT_SECRET", "NODE_OPTIONS", "RANDOM_SECRET"]) assert.equal(runtime[key], undefined);
  assert.equal(runtime.WORKFLOW_LOCAL_DATA_DIR, "/state/eve-workflows"); assert.equal(runtime.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS, "0");
  assert.equal(gateway.JARVIS_CLOUD_RUNTIME_TOKEN, "broker"); assert.equal(gateway.JARVIS_GOOGLE_CLIENT_SECRET, "google");
  assert.equal(gateway.JARVIS_NATIVE_TOKEN, undefined); assert.equal(gateway.AI_GATEWAY_API_KEY, undefined);
  assert.equal(bridge.JARVIS_NATIVE_TOKEN, "native"); assert.equal(bridge.JARVIS_CLOUD_RUNTIME_TOKEN, "broker");
  assert.equal(bridge.JARVIS_INTEGRATION_KEY, undefined);
});

test("encrypted backups round-trip immutable sources and SQLite bytes into a private inactive directory", async (t) => {
  const root = await directory(t), source = path.join(root, "source"), archive = path.join(root, "jarvis-2026-11-09T120000Z.jvb"), restored = path.join(root, "restored");
  await mkdir(path.join(source, "sources"), { recursive: true });
  await writeFile(path.join(source, "sources", "private.txt"), "Private project evidence");
  const database = randomBytes(8192); await writeFile(path.join(source, "knowledge.sqlite"), database);
  await writeFile(path.join(source, "empty"), "");
  const key = randomBytes(32), created = await backup.createEncryptedBackup({ source, output: archive, key });
  assert.equal(created.encrypted, true); assert.equal(created.fileCount, 3);
  assert.equal((await readFile(archive)).includes(Buffer.from("Private project evidence")), false);
  const result = await backup.restoreEncryptedBackup({ archive, destination: restored, key });
  assert.equal(result.authenticated, true); assert.equal(result.activated, false);
  assert.deepEqual(await readFile(path.join(restored, "knowledge.sqlite")), database);
  assert.equal(result.reviewRequired, true);
  await assert.rejects(recovery.assertRestoreReviewed(restored), /recovery review/);
  assert.equal((await stat(path.join(restored, "sources", "private.txt"))).mode & 0o777, 0o600);
  assert.equal((await stat(restored)).mode & 0o777, 0o700);
  await assert.rejects(backup.restoreEncryptedBackup({ archive, destination: restored, key }), /must not exist/);
  await assert.rejects(backup.createEncryptedBackup({ source, output: archive, key }), /already exists/);
});

test("restored state blocks service launch until an exact private stopped-service review is recorded", async (t) => {
  const root = await directory(t), restored = path.join(root, "restored"), reviewFile = path.join(root, "review.json");
  await mkdir(restored);
  const marker = await recovery.markRestoredDirectory(restored, { archiveSha256: "a".repeat(64), backupCreatedAt: "2026-11-09T00:00:00Z" });
  const launch = spawnSync(process.execPath, [new URL("../../scripts/cloud-runtime.mjs", import.meta.url).pathname, "gateway"], { encoding: "utf8", env: { ...process.env, JARVIS_DATA_DIR: restored } });
  assert.equal(launch.status, 1); assert.match(launch.stderr, /blocked pending/);
  const review = { version: 1, restoreId: marker.restoreId, archiveSha256: marker.archiveSha256, reviewer: "Operator",
    reviewedAt: new Date().toISOString(), pendingActionsReviewed: true, effectsAfterBackupReconciled: true,
    previouslyScheduledWorkReviewed: true, providerCredentialsReviewed: true, unresolvedEffects: "remain_unknown_do_not_retry" };
  await writeFile(reviewFile, JSON.stringify({ ...review, restoreId: "another-restore" }), { mode: 0o600 });
  await assert.rejects(recovery.reviewRestoration({ directory: restored, reviewFile, isActive: async () => false }), /does not match/);
  await writeFile(reviewFile, JSON.stringify(review));
  await assert.rejects(recovery.reviewRestoration({ directory: restored, reviewFile, isActive: async () => true }), /Stop every/);
  await chmod(reviewFile, 0o644);
  await assert.rejects(recovery.reviewRestoration({ directory: restored, reviewFile, isActive: async () => false }), /private/);
  await chmod(reviewFile, 0o600);
  assert.equal((await recovery.reviewRestoration({ directory: restored, reviewFile, isActive: async () => false })).activated, false);
  await recovery.assertRestoreReviewed(restored);
  const receipt = JSON.parse(await readFile(path.join(restored, `.jarvis-recovery-${marker.restoreId}.json`), "utf8"));
  assert.equal(receipt.unresolvedEffects, "remain_unknown_do_not_retry"); assert.equal(receipt.previouslyScheduledWorkReviewed, true);
});

test("wrong keys, altered archives, symlink sources and failed output leave no activated restore", async (t) => {
  const root = await directory(t), source = path.join(root, "source"), archive = path.join(root, "archive.jvb"), key = randomBytes(32);
  await mkdir(source); await writeFile(path.join(source, "state"), "private");
  await backup.createEncryptedBackup({ source, output: archive, key });
  const destination = path.join(root, "restored");
  await assert.rejects(backup.restoreEncryptedBackup({ archive, destination, key: randomBytes(32) }), /authentication/);
  const bytes = await readFile(archive); bytes[bytes.length - 20] ^= 1; await writeFile(archive, bytes);
  await assert.rejects(backup.restoreEncryptedBackup({ archive, destination, key }), /authentication/);
  await assert.rejects(access(destination));
  assert.equal((await readdir(root)).some(file => file.startsWith(".jarvis-restore-")), false);
  await symlink("/etc/passwd", path.join(source, "link"));
  await assert.rejects(backup.createEncryptedBackup({ source, output: path.join(root, "other.jvb"), key }), /symbolic/);
  assert.equal((await readdir(root)).some(file => file.endsWith(".partial")), false);
});

test("authenticated malicious manifests cannot traverse directories or bypass per-file checksums", async (t) => {
  const root = await directory(t), key = randomBytes(32), magic = Buffer.from("JARVIS-BACKUP-1\n");
  for (const name of ["../escape", "/absolute", "valid"]) {
    const manifest = Buffer.from(JSON.stringify({ version: 1, files: [{ path: name, bytes: 3, sha256: "0".repeat(64) }] }));
    const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(magic);
    const archive = path.join(root, randomBytes(8).toString("hex") + ".jvb");
    await writeFile(archive, Buffer.concat([magic, iv, cipher.update(Buffer.concat([length, manifest, Buffer.from("bad")])), cipher.final(), cipher.getAuthTag()]));
    await assert.rejects(backup.restoreEncryptedBackup({ archive, destination: path.join(root, "restored"), key }));
  }
  await assert.rejects(access(path.join(root, "restored")));
});

test("off-host retention runs only after matching remote checksum and rejects unsafe SSH targets", async (t) => {
  const root = await directory(t), archive = path.join(root, "jarvis-2026-11-09T120000Z.jvb");
  await writeFile(archive, "encrypted-fixture"); const hash = createHash("sha256").update("encrypted-fixture").digest("hex");
  const calls: string[][] = [];
  const runner = async (command: string, args: string[]) => { calls.push([command, ...args]); return { code: 0, output: args.at(-1)?.startsWith("sha256sum") ? hash + " archive" : "" }; };
  assert.equal((await backup.uploadVerifiedBackup(archive, "backup@backup.example.com:/srv/jarvis", runner)).retentionDays, 30);
  assert.match(calls.at(-1)!.at(-1)!, /-mtime \+30 -delete/);
  assert.ok(calls.every(call => call.includes("StrictHostKeyChecking=yes")));
  calls.length = 0;
  await assert.rejects(backup.uploadVerifiedBackup(archive, "backup@backup.example.com:/srv/jarvis", async (command: string, args: string[]) => { calls.push([command, ...args]); return { code: 0, output: "wrong" }; }), /checksum/);
  assert.equal(calls.some(call => call.at(-1)!.includes("-delete")), false);
  for (const target of ["root@localhost:/tmp", "root@127.0.0.1:/tmp", "root@backup.example.com:/tmp/../other", "root@backup.example.com:/tmp;touch bad"]) assert.throws(() => backup.parseOffhostTarget(target));
});

test("CLI errors redact secret arguments and failed readiness never enables a worker", async (t) => {
  const root = await directory(t), key = path.join(root, "key"); await writeFile(key, randomBytes(32).toString("hex")); await chmod(key, 0o600);
  const result = spawnSync(process.execPath, [new URL("../../scripts/cloud-backup.mjs", import.meta.url).pathname, "restore", "--archive", "PRIVATE_CREDENTIAL_FIXTURE", "--destination", path.join(root, "new"), "--key-file", key], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal((result.stderr + result.stdout).includes("PRIVATE_CREDENTIAL_FIXTURE"), false);
  const environment = { JARVIS_ENABLE_CLOUD: "1", AI_GATEWAY_API_KEY: "provider", JARVIS_MODEL: "model", JARVIS_CLOUD_ORIGIN: "https://jarvis.example.com", JARVIS_WORKER_IMAGE: "sha256:" + "a".repeat(64),
    JARVIS_LOCAL_TOKEN: "a".repeat(64), JARVIS_NATIVE_TOKEN: "b".repeat(64), JARVIS_CLOUD_RUNTIME_TOKEN: "c".repeat(64), JARVIS_CLOUD_BOOTSTRAP_TOKEN: "d".repeat(64) };
  assert.equal(inspectCloudConfiguration(environment, 'ID=ubuntu\nVERSION_ID="24.04"', "24.0.0").checks.every((check: { status: string }) => check.status === "pass"), true);
  const report = await runCloudReadiness({ environment, osRelease: 'ID=ubuntu\nVERSION_ID="24.04"', nodeVersion: "24.0.0", runtimeDirectory: root,
    fetcher: async (url: string) => new Response("", { status: url.includes("/health") || url.startsWith("http:") ? 200 : 404 }), workerProbe: async () => false });
  assert.equal(report.ready, false); assert.equal(report.checks.find((check: { code: string }) => check.code === "worker_actual_enforcement").status, "fail");
  assert.equal(JSON.stringify(report).includes(environment.JARVIS_CLOUD_RUNTIME_TOKEN), false);
});
