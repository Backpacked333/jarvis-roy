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
  const keys = generateKeyPairSync("ed25519"), now = Date.now(); let executions = 0;
  const action = { taskId: "task", interactionId: "approval", revision: 1, optionId: "approve", toolName: "save_note", exactArguments: '{"text":"approved"}', reviewText: 'Tool: save_note\nExact arguments (JSON): {"text":"approved"}', voiceAllowed: true };
  const options = { dataDirectory, enabled: true, now: () => now, authority: { async readAction() { return action; }, async executeAction() { executions++; throw new Error("uncertain effect"); } }, async projectForAction() { return "project"; } };
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
  } finally { await runtime.close(); await rm(dataDirectory, { recursive: true, force: true }); }
});
