import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebSocket } from "ws";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { CloudControlPlane, CloudStore, createCloudGateway, verifyRemoteApprovalReceipt, cloudCommandDigest,
  type CloudOptions, type CloudActor, type CloudCommand, type DeviceReceipt } from "../bridge/cloud/index.ts";
import type { ReviewableAction } from "../bridge/assistant/index.ts";
import { cloudReviewJs } from "../bridge/cloud/web.ts";

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest();
const bootstrap = randomBytes(32).toString("base64url");
// A software test authenticator builds genuine COSE/CBOR and signs assertions.
// Production verifies these through @simplewebauthn/server, not an injected verifier.
function cbor(value: unknown): Buffer {
  const size = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const result = Buffer.alloc(3); result[0] = (major << 5) | 25; result.writeUInt16BE(length, 1); return result;
  };
  if (typeof value === "number") return size(value < 0 ? 1 : 0, value < 0 ? -value - 1 : value);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([size(3, bytes.length), bytes]); }
  if (value instanceof Uint8Array) return Buffer.concat([size(2, value.length), value]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, unknown>);
  return Buffer.concat([size(5, entries.length), ...entries.flatMap(([key, entry]) => [cbor(key), cbor(entry)])]);
}
class TestAuthenticator {
  private readonly pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  private readonly bytes = randomBytes(32);
  readonly id = this.bytes.toString("base64url");
  private counter = 0;
  registration(challenge: string, origin: string, flags = 0x45): RegistrationResponseJSON {
    const key = this.pair.publicKey.export({ format: "jwk" }), rpId = new URL(origin).hostname;
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(key.x!, "base64url")], [-3, Buffer.from(key.y!, "base64url")]]));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.bytes.length);
    const authData = Buffer.concat([sha(rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), length, this.bytes, cose]);
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })).toString("base64url"),
      attestationObject: cbor({ fmt: "none", attStmt: {}, authData }).toString("base64url"), transports: ["internal"],
    } };
  }
  assertion(challenge: string, origin: string, options: { flags?: number; rpId?: string } = {}): AuthenticationResponseJSON {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++this.counter);
    const authenticatorData = Buffer.concat([sha(options.rpId ?? new URL(origin).hostname), Buffer.from([options.flags ?? 0x05]), counter]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"),
      signature: sign("sha256", Buffer.concat([authenticatorData, sha(clientDataJSON)]), this.pair.privateKey).toString("base64url"),
    } };
  }
}
async function fixture(options: Partial<CloudOptions> & { noDirectAuthority?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-cloud-"));
  const origin = options.publicOrigin ?? "https://jarvis.example";
  let clock = Date.parse("2026-11-09T12:00:00.000Z"), executions = 0;
  let action: ReviewableAction = { taskId: "task-1", interactionId: "approval-1", revision: 1, optionId: "approve",
    toolName: "save_note", exactArguments: '{"title":"Experiment","content":"Trial A"}',
    reviewText: 'Save note: {"title":"Experiment","content":"Trial A"}', voiceAllowed: true };
  const config: CloudOptions = { dataDirectory: directory, publicOrigin: origin, bootstrapToken: bootstrap, now: () => new Date(clock),
    ...(options.noDirectAuthority ? {} : { async readAction() { return structuredClone(action); }, async executeAction() { executions++; return { outcome: "completed" as const }; } }), ...options };
  let control = await CloudControlPlane.open(config);
  const start = await control.startPairing({ deviceId: "mac-1", label: "Personal Mac" }, bootstrap);
  const pair = await control.completePairing({ pairingId: start.pairingId, deviceId: "mac-1" }, start.pairingToken);
  const device = control.authenticateDevice(pair.deviceToken), frames: unknown[] = [];
  let welcome = await control.connectDevice(device, frame => frames.push(frame), () => {});
  const authenticator = new TestAuthenticator();
  const enrollment = await control.startEnrollment(device), registration = await control.registrationOptions(enrollment.enrollmentToken);
  await control.finishRegistration(enrollment.enrollmentToken, registration.challengeId, authenticator.registration(registration.options.challenge, origin));
  async function login() { const challenge = await control.authenticationOptions(); const result = await control.finishAuthentication(challenge.challengeId, authenticator.assertion(challenge.options.challenge, origin)); return { token: result.sessionToken, actor: control.authenticateOwner(result.sessionToken) }; }
  let session = await login();
  return { directory, config, origin, pair, device, frames, authenticator, get control() { return control; }, get welcome() { return welcome; }, get owner() { return session.actor; }, get ownerToken() { return session.token; },
    get action() { return action; }, set action(value: ReviewableAction) { action = value; }, executions: () => executions, advance(ms: number) { clock += ms; },
    async propose() { return control.createActionProposal({ projectId: "project-1", deviceId: "mac-1", ref: { taskId: action.taskId, interactionId: action.interactionId, revision: action.revision, optionId: action.optionId } }); },
    async reconnect() { welcome = await control.connectDevice(device, frame => frames.push(frame), () => {}); },
    async restart() { await control.close(); control = await CloudControlPlane.open(config); welcome = await control.connectDevice(control.authenticateDevice(pair.deviceToken), frame => frames.push(frame), () => {}); session = await login(); },
    async cleanup() { await control.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("real passkey verification binds origin, RP, user verification, exact action and one-use receipt", async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose(), approval = await f.control.approvalOptions(proposal.id, f.owner);
    await assert.rejects(f.control.finishApproval(proposal.id, approval.challengeId, f.authenticator.assertion(approval.options.challenge, "https://evil.example"), f.owner));
    await assert.rejects(f.control.finishApproval(proposal.id, approval.challengeId, f.authenticator.assertion(approval.options.challenge, f.origin, { rpId: "evil.example" }), f.owner));
    await assert.rejects(f.control.finishApproval(proposal.id, approval.challengeId, f.authenticator.assertion(approval.options.challenge, f.origin, { flags: 0x01 }), f.owner));
    assert.equal(f.executions(), 0);
    const response = f.authenticator.assertion(approval.options.challenge, f.origin);
    const result = await f.control.finishApproval(proposal.id, approval.challengeId, response, f.owner);
    assert.equal(result.status, "completed"); assert.equal(f.executions(), 1);
    await assert.rejects(f.control.finishApproval(proposal.id, approval.challengeId, response, f.owner), /stale|consumed/);
    await assert.rejects(f.propose(), /already submitted/); assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test("passkey approval rejects changed actions, expired reviews and ownership changes", async t => {
  for (const mode of ["changed", "expired", "reconnected", "wrong-binding"] as const) await t.test(mode, async () => {
    const f = await fixture();
    try {
      const proposal = await f.propose(), approval = await f.control.approvalOptions(proposal.id, f.owner);
      if (mode === "changed") f.action = { ...f.action, revision: 2, exactArguments: '{"title":"Changed"}' };
      if (mode === "expired") f.advance(120001);
      if (mode === "reconnected") await f.reconnect();
      const id = mode === "wrong-binding" ? randomUUID() : proposal.id;
      await assert.rejects(f.control.finishApproval(id, approval.challengeId, f.authenticator.assertion(approval.options.challenge, f.origin), f.owner));
      assert.equal(f.executions(), 0);
    } finally { await f.cleanup(); }
  });
});

test("native device offers yield signed commands, not completed effects; receipts and reconciliation are fenced", async () => {
  const f = await fixture({ noDirectAuthority: true });
  try {
    const proposal = await f.control.offerAction(f.device, { projectId: "project-1", generation: f.welcome.generation, serverEpoch: f.welcome.serverEpoch, action: f.action });
    const approval = await f.control.approvalOptions(proposal.id, f.owner);
    assert.equal((await f.control.finishApproval(proposal.id, approval.challengeId, f.authenticator.assertion(approval.options.challenge, f.origin), f.owner)).status, "executing");
    const command = f.frames.find(frame => (frame as CloudCommand).type === "command") as CloudCommand;
    assert.equal(command.payload.kind, "action.execute"); assert.equal(command.digest, cloudCommandDigest(command));
    if (command.payload.kind !== "action.execute") throw new Error("Wrong command");
    const receipt = command.payload.receipt;
    assert.equal(verifyRemoteApprovalReceipt(receipt, f.pair.receiptPublicKey, { deviceId: "mac-1", deviceGeneration: f.welcome.generation, serverEpoch: f.welcome.serverEpoch, action: f.action, now: new Date("2026-11-09T12:00:00Z") }).id, receipt.id);
    assert.throws(() => verifyRemoteApprovalReceipt({ ...receipt, projectId: "other" }, f.pair.receiptPublicKey, { deviceId: "mac-1", deviceGeneration: f.welcome.generation, serverEpoch: f.welcome.serverEpoch, action: f.action }), /invalid/);
    const result: DeviceReceipt = { version: 1, type: "receipt", id: randomUUID(), commandId: command.id, deviceId: "mac-1", generation: command.generation,
      serverEpoch: command.serverEpoch, commandDigest: command.digest, status: "unknown", code: "unknown" };
    await f.control.receiveDeviceFrame(f.device, result);
    assert.equal(f.control.proposal(proposal.id, f.owner).status, "unknown");
    assert.equal((await f.control.receiveDeviceFrame(f.device, result)).duplicate, true);
    await f.reconnect(); await assert.rejects(f.control.receiveDeviceFrame(f.device, result), /generation/);
    await f.control.receiveDeviceFrame(f.device, { ...result, type: "reconcile", id: randomUUID(), generation: f.welcome.generation, serverEpoch: f.welcome.serverEpoch,
      originalGeneration: command.generation, originalServerEpoch: command.serverEpoch, status: "completed", code: "ok" });
    assert.equal(f.control.proposal(proposal.id, f.owner).status, "completed");
    await assert.rejects(f.control.receiveDeviceFrame(f.device, { ...result, type: "reconcile", id: randomUUID(), generation: f.welcome.generation, serverEpoch: f.welcome.serverEpoch,
      originalGeneration: command.generation, originalServerEpoch: command.serverEpoch, status: "failed", code: "rejected" }), /replay|overwritten/);
  } finally { await f.cleanup(); }
});

test("failed or interrupted effects never automatically execute again after restart", async () => {
  let calls = 0; const f = await fixture({ async executeAction() { calls++; throw new Error("network outcome lost"); } });
  try {
    const proposal = await f.propose(), approval = await f.control.approvalOptions(proposal.id, f.owner);
    assert.equal((await f.control.finishApproval(proposal.id, approval.challengeId, f.authenticator.assertion(approval.options.challenge, f.origin), f.owner)).status, "unknown");
    const previousOwnerToken = f.ownerToken; await f.restart();
    assert.throws(() => f.control.authenticateOwner(previousOwnerToken), /sign-in/);
    await assert.rejects(f.propose(), /already submitted/); assert.equal(calls, 1);
    assert.equal(f.control.proposal(proposal.id, f.owner).status, "unknown");
  } finally { await f.cleanup(); }
});

test("durability failure before authorization prevents execution and fences further work", async () => {
  const f = await fixture(), save = CloudStore.prototype.save;
  try {
    const proposal = await f.propose(), approval = await f.control.approvalOptions(proposal.id, f.owner);
    CloudStore.prototype.save = function(state) { if (state.proposals.some(proposal => proposal.status === "executing")) throw new Error("injected disk failure"); return save.call(this, state); };
    await assert.rejects(f.control.finishApproval(proposal.id, approval.challengeId, f.authenticator.assertion(approval.options.challenge, f.origin), f.owner), /injected/);
    assert.equal(f.executions(), 0); assert.equal(f.control.health().status, "unavailable");
    await assert.rejects(f.propose(), /unavailable/);
    CloudStore.prototype.save = save; await f.restart();
    assert.equal(f.control.proposal(proposal.id, f.owner).status, "invalidated"); assert.equal(f.executions(), 0);
  } finally { CloudStore.prototype.save = save; await f.cleanup(); }
});

test("retained immutable snapshots enforce selection, processor, device, expiry and separate disclosure policy", async () => {
  const f = await fixture();
  try {
    const text = "Selected immutable experiment observation", selection = { kind: "source" as const, id: "source-version-1", revision: 1, sha256: sha(text).toString("hex") };
    const grant = await f.control.createRetentionGrant({ deviceId: "mac-1", projectId: "project-1", selected: [selection], expiresAt: "2026-11-10T12:00:00Z", maxBytes: 5000, processors: ["research"] }, f.device);
    const request = { requestId: "sync-1", grantId: grant.id, grantRevision: grant.revision, snapshots: [{ ...selection, text }] };
    assert.equal((await f.control.syncSnapshots(request, f.device)).duplicate, false);
    assert.equal((await f.control.syncSnapshots(request, f.device)).duplicate, true);
    await assert.rejects(f.control.syncSnapshots({ ...request, snapshots: [{ ...selection, text: "changed" }] }, f.device), /reused/);
    await assert.rejects(f.control.syncSnapshots({ ...request, requestId: "sync-2", snapshots: [{ ...selection, revision: 2, text }] }, f.device), /exact selected/);
    assert.equal(f.control.readSnapshots("other-project", "research").length, 0); assert.equal(f.control.readSnapshots("project-1", "other-processor").length, 0);
    const retained = f.control.readSnapshots("project-1", "research")[0]; assert.equal(retained.text, text); assert.equal(retained.grantRevision, 1);
    assert.equal(f.control.authorizeSnapshot(retained, "project-1", "research"), true);
    const disclosure = { projectId: "project-1", channel: "telegram" as const, destinationId: "123456", proactive: true };
    assert.equal(f.control.authorizeDisclosure(disclosure), false);
    const policy = await f.control.createChannelPolicy({ ...disclosure, allowDetails: true, allowProactive: false, expiresAt: "2026-11-10T12:00:00Z", proactive: undefined }, f.owner).catch(() => undefined);
    assert.equal(policy, undefined, "Unknown policy fields must be rejected");
    const allowed = await f.control.createChannelPolicy({ projectId: "project-1", channel: "telegram", destinationId: "123456", allowDetails: true, allowProactive: false, expiresAt: "2026-11-10T12:00:00Z" }, f.owner);
    assert.equal(f.control.authorizeDisclosure({ ...disclosure, proactive: false }), true); assert.equal(f.control.authorizeDisclosure(disclosure), false);
    assert.equal(f.control.authorizeDisclosure({ ...disclosure, destinationId: "999", proactive: false }), false);
    await f.control.revokeChannelPolicy(allowed.id, f.owner); assert.equal(f.control.authorizeDisclosure({ ...disclosure, proactive: false }), false);
    await f.control.revokeRetentionGrant(grant.id, 1, f.device); assert.equal(f.control.readSnapshots("project-1", "research").length, 0);
    assert.equal(f.control.authorizeSnapshot(retained, "project-1", "research"), false);
    await assert.rejects(f.control.syncSnapshots(request, f.device), /unavailable|expired/);
    await f.restart(); assert.equal(f.control.readSnapshots("project-1", "research").length, 0);
  } finally { await f.cleanup(); }
});

test("cloud retention expires without further disclosure and housekeeping removes stored content", async () => {
  const f = await fixture();
  try {
    const text = "Unique retained payload 7e3ce375", selection = { kind: "memory", id: "memory-1", revision: 1, sha256: sha(text).toString("hex") };
    const grant = await f.control.createRetentionGrant({ deviceId: "mac-1", projectId: "project-1", selected: [selection], expiresAt: "2026-11-09T12:00:01Z", maxBytes: 1000, processors: ["research"] }, f.device);
    await f.control.syncSnapshots({ requestId: "one", grantId: grant.id, grantRevision: 1, snapshots: [{ ...selection, text }] }, f.device);
    f.advance(1001); assert.equal(f.control.readSnapshots("project-1", "research").length, 0); await f.control.purgeExpired();
    await f.control.close(); assert.equal((await readFile(join(f.directory, "cloud", "control.sqlite"))).includes(Buffer.from(text)), false);
  } finally { await f.cleanup(); }
});

test("call passkey verification is bound to the exact still-active CallSid", async () => {
  let active = true; const callSid = `CA${"a".repeat(32)}`, authorized: string[] = [];
  const f = await fixture({ async readCall(id) { return active && id === callSid ? { callSid, projectId: "project-1", status: "in_progress" } : null; },
    async authorizeCall(id, proof) { assert.ok(proof.credentialId); assert.ok(proof.ownerSessionId); authorized.push(id); } });
  try {
    const challenge = await f.control.callOptions(callSid, f.owner);
    await assert.rejects(f.control.finishCall(`CA${"b".repeat(32)}`, challenge.challengeId, f.authenticator.assertion(challenge.options.challenge, f.origin), f.owner), /identity/);
    active = false; await assert.rejects(f.control.finishCall(callSid, challenge.challengeId, f.authenticator.assertion(challenge.options.challenge, f.origin), f.owner), /ended/);
    assert.equal(authorized.length, 0); active = true;
    await f.control.finishCall(callSid, challenge.challengeId, f.authenticator.assertion(challenge.options.challenge, f.origin), f.owner);
    assert.deepEqual(authorized, [callSid]);
    await assert.rejects(f.control.finishCall(callSid, challenge.challengeId, f.authenticator.assertion(challenge.options.challenge, f.origin), f.owner), /consumed/);
  } finally { await f.cleanup(); }
});

test("cloud gateway exposes only narrow authenticated routes and actual outbound-device websocket", async () => {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const f = await fixture({ publicOrigin: origin, allowLoopbackForTests: true });
  const gateway = createCloudGateway(f.control); server.on("request", gateway.handler); server.on("upgrade", gateway.upgrade);
  const request = (path: string, options: RequestInit = {}) => fetch(origin + path, options);
  let ws: WebSocket | undefined;
  try {
    assert.equal((await request("/v1/cloud/health")).status, 200);
    assert.equal((await request("/v1/tasks")).status, 404);
    assert.equal((await request("/v1/cloud/overview")).status, 401);
    assert.equal((await request("/v1/cloud/webauthn/authentication/options", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
    const ownerHeaders = { cookie: `jarvis_cloud_test=${f.ownerToken}`, origin, "content-type": "application/json" };
    assert.equal((await request("/v1/cloud/overview", { headers: ownerHeaders })).status, 200);
    assert.equal((await request("/v1/cloud/enrollment/start", { method: "POST", headers: { authorization: "Bearer local-native-token", "content-type": "application/json" }, body: "{}" })).status, 401);
    const page = await request("/v1/cloud/review"); assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.doesNotMatch(await page.text(), /deviceToken|signingPrivateKey/); new Function(cloudReviewJs);
    ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/cloud/device/connect?deviceId=mac-1`, { headers: { authorization: `Bearer ${f.pair.deviceToken}` } });
    const welcomePromise = once(ws, "message"); await once(ws, "open");
    const [welcomeBytes] = await welcomePromise, welcome = JSON.parse(String(welcomeBytes)); assert.equal(welcome.type, "device.welcome");
    const ack = once(ws, "message"); ws.send(JSON.stringify({ version: 1, type: "heartbeat", deviceId: "mac-1", generation: welcome.generation, serverEpoch: welcome.serverEpoch }));
    assert.equal(JSON.parse(String((await ack)[0])).type, "heartbeat.ack");
    const rejection = new WebSocket(`ws://127.0.0.1:${address.port}/v1/cloud/device/connect?deviceId=mac-1`, { headers: { authorization: "Bearer bad-token" } });
    await new Promise<void>(resolve => { rejection.on("error", () => resolve()); });
  } finally { ws?.terminate(); await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test("pairing, stored credential isolation and schema migration preserve private durable state", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.control.startPairing({ deviceId: "other", label: "Other" }, "native-or-model-token"), /bootstrap/);
    const start = await f.control.startPairing({ deviceId: "second", label: "Second" }, bootstrap);
    const second = await f.control.completePairing({ pairingId: start.pairingId, deviceId: "second" }, start.pairingToken);
    await assert.rejects(f.control.completePairing({ pairingId: start.pairingId, deviceId: "second" }, start.pairingToken), /consumed/);
    assert.notEqual(second.deviceToken, f.pair.deviceToken);
    await f.control.close(); const file = join(f.directory, "cloud", "control.sqlite"), contents = await readFile(file);
    assert.equal(contents.includes(Buffer.from(f.pair.deviceToken)), false); assert.equal(contents.includes(Buffer.from(bootstrap)), false);
    assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(join(f.directory, "cloud"))).mode & 0o777, 0o700);
    const db = new DatabaseSync(file); db.exec("ALTER TABLE state DROP COLUMN checksum; PRAGMA user_version=1;"); db.close();
    await f.restart(); assert.equal(f.control.health().passkeyEnrolled, true);
    const backups = (await readdir(join(f.directory, "cloud"))).filter(name => name.startsWith("schema-v1-")); assert.equal(backups.length, 1);
    assert.equal((await stat(join(f.directory, "cloud", backups[0]))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
  await assert.rejects(CloudControlPlane.open({ dataDirectory: "/tmp/not-created-cloud", publicOrigin: "http://public.example" }), /HTTPS/);
});
