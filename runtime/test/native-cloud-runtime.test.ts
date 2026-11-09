import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeCloudRuntime } from "../bridge/native-cloud-runtime.ts";
import { actionDigest } from "../bridge/assistant/coordinator.ts";
import { cloudCommandDigest } from "../bridge/cloud/control.ts";
import { canonicalJson } from "../bridge/harness-contracts/validation.ts";
import type { CloudCommand } from "../bridge/cloud/contracts.ts";

test("remote native approval binds signature, project, device and current exact action and cannot replay after uncertainty", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "jarvis-native-remote-"));
  const keys = generateKeyPairSync("ed25519"), now = Date.now(); let executions = 0, handoffFails = true, observations = 0;
  let observed: "unknown" | "completed" = "unknown";
  const action = { taskId: "task", interactionId: "approval", revision: 1, optionId: "approve", toolName: "save_note", exactArguments: '{"text":"approved"}', reviewText: 'Tool: save_note\nExact arguments (JSON): {"text":"approved"}', voiceAllowed: true };
  const options = { dataDirectory, enabled: true, now: () => now, authority: { async readAction() { return action; }, async executeAction() { executions++; if (handoffFails) throw new Error("uncertain effect"); } }, async projectForAction() { return "project"; },
    async observeAction(_id: string, _room: boolean, _option: string, reference: { taskId: string; interactionId: string; revision: number; optionId: string }) {
      assert.deepEqual(reference, { taskId: action.taskId, interactionId: action.interactionId, revision: 1, optionId: "approve" }); observations++; return observed;
    } };
  let runtime = await NativeCloudRuntime.open(options);
  const pair = { version: 1, profileId: "cloud", origin: "https://jarvis.example", deviceId: "mac", generation: 1, serverEpoch: 1, receiptPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
  await runtime.pair(pair);
  function command(projectId = "project"): CloudCommand {
    const unsigned = { version: 1 as const, id: randomUUID(), proposalId: "proposal", projectId, deviceId: "mac", deviceGeneration: 1, serverEpoch: 1,
      actionRef: { taskId: action.taskId, interactionId: action.interactionId, revision: 1, optionId: "approve" }, actionDigest: actionDigest(action),
      credentialId: "owner-passkey", nonce: randomUUID(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString("base64url") };
    const envelope = { version: 1 as const, type: "command" as const, id: randomUUID(), deviceId: "mac", generation: 1, serverEpoch: 1, sequence: 1,
      payload: { kind: "action.execute" as const, proposalId: "proposal", action, receipt }, createdAt: new Date(now).toISOString(), expiresAt: receipt.expiresAt, status: "sent" as const };
    return { ...envelope, digest: cloudCommandDigest(envelope) };
  }
  try {
    assert.equal((await runtime.execute({ version: 1, profileId: "cloud", command: command("wrong-project") })).status, "failed");
    const tampered = command();
    assert.equal(tampered.payload.kind, "action.execute");
    if (tampered.payload.kind === "action.execute") tampered.payload.action = { ...action, exactArguments: '{}' };
    assert.equal((await runtime.execute({ version: 1, profileId: "cloud", command: tampered })).status, "failed");
    assert.equal(executions, 0);
    const original = command(), input = { version: 1, profileId: "cloud", command: original };
    assert.equal((await runtime.execute(input)).status, "unknown"); assert.equal(executions, 1);
    await runtime.close(); runtime = await NativeCloudRuntime.open(options);
    assert.equal((await runtime.execute(input)).status, "unknown"); assert.equal(executions, 1);
    const replay = { ...original, id: randomUUID() };
    assert.equal((await runtime.execute({ ...input, command: replay })).status, "failed"); assert.equal(executions, 1);
    await assert.rejects(runtime.pair({ ...pair, generation: 0 }));
    await assert.rejects(runtime.pair({ ...pair, origin: "https://another.example" }), /identity changed/);
    const query = { version: 1, profileId: "cloud", commandId: original.id, commandDigest: original.digest, originalGeneration: 1, originalServerEpoch: 1 };
    observed = "completed";
    assert.equal((await runtime.result(query)).status, "unknown"); assert.equal(observations, 0); assert.equal(executions, 1);
    assert.equal((await runtime.result({ ...query, commandId: "never-dispatched" })).status, "unknown");
    handoffFails = false; observed = "unknown";
    const handedOff = command(), handedQuery = { ...query, commandId: handedOff.id, commandDigest: handedOff.digest };
    assert.equal((await runtime.execute({ ...input, command: handedOff })).status, "unknown"); assert.equal(executions, 2);
    await runtime.close(); runtime = await NativeCloudRuntime.open({ ...options, now: () => now + 300000 });
    await runtime.pair({ ...pair, generation: 2, serverEpoch: 2 }); observed = "completed";
    assert.equal((await runtime.result(handedQuery)).status, "completed"); assert.equal(executions, 2);
    const count = observations;
    assert.equal((await runtime.result(handedQuery)).status, "completed"); assert.equal(observations, count);
    assert.equal((await runtime.execute({ ...input, command: handedOff })).code, "stale"); assert.equal(executions, 2);
    await assert.rejects(runtime.result({ ...handedQuery, commandDigest: "0".repeat(64) }), /identity/);
    await assert.rejects(runtime.result({ ...handedQuery, originalGeneration: 2 }), /binding/);
    await runtime.pair({ ...pair, profileId: "other-profile", generation: 2, serverEpoch: 2 });
    await assert.rejects(runtime.result({ ...handedQuery, profileId: "other-profile" }), /binding/);
  } finally { await runtime.close(); await rm(dataDirectory, { recursive: true, force: true }); }
});

test("native receipt migration keeps legacy uncertainty and creates a private pre-migration database", async () => {
  const { mkdir, readdir, stat } = await import("node:fs/promises"), { DatabaseSync } = await import("node:sqlite");
  const dataDirectory = await mkdtemp(join(tmpdir(), "jarvis-native-migrate-")), directory = join(dataDirectory, "native-cloud");
  await mkdir(directory, { mode: 0o700 });
  const old = new DatabaseSync(join(directory, "receipts.sqlite"));
  old.exec("CREATE TABLE profiles(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE commands(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL); PRAGMA user_version=1");
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const pair = { version: 1, profileId: "cloud", origin: "https://jarvis.example", deviceId: "mac", generation: 1, serverEpoch: 1, receiptPublicKey: key };
  old.prepare("INSERT INTO profiles VALUES (?,?)").run("cloud", JSON.stringify(pair));
  old.prepare("INSERT INTO commands VALUES (?,?,?,?)").run("legacy-command", "a".repeat(64), "receipt", JSON.stringify({ version: 1, status: "unknown", code: "unknown" })); old.close();
  const runtime = await NativeCloudRuntime.open({ dataDirectory, enabled: true,
    authority: { async readAction() { assert.fail("Observation must not read an executable action"); }, async executeAction() { assert.fail("Migration must not replay an action"); } }, async projectForAction() { return "project"; } });
  try {
    assert.equal((await runtime.result({ version: 1, profileId: "cloud", commandId: "legacy-command", commandDigest: "a".repeat(64), originalGeneration: 1, originalServerEpoch: 1 })).status, "unknown");
    const backups = (await readdir(directory)).filter(name => name.endsWith(".backup.sqlite")); assert.equal(backups.length, 1);
    assert.equal((await stat(join(directory, backups[0]))).mode & 0o777, 0o600);
    const snapshot = new DatabaseSync(join(directory, backups[0]), { readOnly: true });
    try { assert.equal(snapshot.prepare("PRAGMA user_version").get()?.user_version, 1); assert.equal(snapshot.prepare("SELECT count(*) AS n FROM commands").get()?.n, 1); } finally { snapshot.close(); }
  } finally { await runtime.close(); await rm(dataDirectory, { recursive: true, force: true }); }
});
