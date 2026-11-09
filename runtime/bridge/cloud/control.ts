import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type AuthenticatorTransport } from "@simplewebauthn/server";
import { actionDigest, type ActionRef, type ReviewableAction, ReviewableActionSchema } from "../assistant/index.ts";
import { canonicalJson } from "../harness-contracts/validation.ts";
import { containsCredentialLikeData } from "../../agent/lib/memory.ts";
import { BridgeError } from "../errors.ts";
import { CloudStore } from "./store.ts";
import {
  ChannelPolicyInputSchema, CloudId, CloudStateSchema, CommandPayloadSchema, CreateRemoteActionSchema, DeviceFrameSchema, DeviceReceiptSchema,
  PairCompleteSchema, PairStartSchema, RemoteApprovalReceiptSchema, RetentionGrantInputSchema, SyncSnapshotsSchema,
  type CloudCommand, type CloudState, type CommandPayload, type DeviceReceipt, type RemoteActionProposal, type RemoteApprovalReceipt, type RetentionGrant,
} from "./contracts.ts";

export interface CloudOptions {
  dataDirectory: string; publicOrigin: string; bootstrapToken?: string; allowLoopbackForTests?: boolean; now?: () => Date;
  localExecutorId?: string;
  readAction?: (ref: ActionRef, scope: { projectId: string; deviceId: string }) => Promise<ReviewableAction | null>;
  executeAction?: (action: ReviewableAction, receipt: RemoteApprovalReceipt) => Promise<{ outcome: "completed" | "failed" | "queued" | "unknown"; commandId?: string }>;
  /** Exact durable command observation only; must never invoke an action. */
  readActionResult?: (command: CloudCommand) => Promise<{ version: 1; status: "completed" | "failed" | "unknown";
    code: "ok" | "rejected" | "stale" | "unavailable" | "interrupted" | "unknown" }>;
  readCall?: (callSid: string) => Promise<{ callSid: string; projectId: string; status: "ringing" | "in_progress" } | null>;
  authorizeCall?: (callSid: string, proof: { credentialId: string; verifiedAt: string; expiresAt: string; ownerSessionId: string }) => Promise<void>;
  revokeCallAuthorizations?: () => void | Promise<void>;
}
export type CloudActor = { kind: "device"; deviceId: string } | { kind: "owner"; sessionHash: string; credentialId: string };
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");
const equalHash = (value: string, expected: string): boolean => /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex"));
const keyOf = (value: { kind: string; id: string; revision: number; sha256: string }) => `${value.kind}:${value.id}:${value.revision}:${value.sha256}`;
export const cloudCommandDigest = (command: Pick<CloudCommand, "deviceId" | "generation" | "serverEpoch" | "payload" | "expiresAt">): string => hash(canonicalJson({
  deviceId: command.deviceId, generation: command.generation, serverEpoch: command.serverEpoch, payload: command.payload, expiresAt: command.expiresAt,
}));
export function remoteActionCommand(action: ReviewableAction, receipt: RemoteApprovalReceipt, sequence = 1): CloudCommand {
  const command = { version: 1 as const, type: "command" as const, id: receipt.id, deviceId: receipt.deviceId,
    generation: receipt.deviceGeneration, serverEpoch: receipt.serverEpoch, sequence,
    payload: { kind: "action.execute" as const, proposalId: receipt.proposalId, action, receipt },
    createdAt: receipt.issuedAt, expiresAt: receipt.expiresAt, status: "sent" as const };
  return { ...command, digest: cloudCommandDigest(command) };
}
export function verifyRemoteApprovalReceipt(raw: unknown, publicKey: string, expected: {
  deviceId: string; deviceGeneration: number; serverEpoch: number; action: ReviewableAction; now?: Date;
}): RemoteApprovalReceipt {
  const receipt = RemoteApprovalReceiptSchema.parse(raw), { signature, ...payload } = receipt;
  if (receipt.deviceId !== expected.deviceId || receipt.deviceGeneration !== expected.deviceGeneration || receipt.serverEpoch !== expected.serverEpoch ||
      receipt.actionDigest !== actionDigest(expected.action) || canonicalJson(receipt.actionRef) !== canonicalJson({ taskId: expected.action.taskId, interactionId: expected.action.interactionId, revision: expected.action.revision, optionId: expected.action.optionId }) ||
      Date.parse(receipt.expiresAt) <= (expected.now ?? new Date()).getTime() || Date.parse(receipt.issuedAt) > (expected.now ?? new Date()).getTime() + 5000 ||
      Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt) > 120_000 || Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt) ||
      !verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(publicKey), Buffer.from(signature, "base64url"))) throw new BridgeError("Remote approval receipt is invalid, stale or bound to another action.", 403);
  return receipt;
}

export class CloudControlPlane {
  readonly publicOrigin: string;
  readonly rpId: string;
  private readonly options: CloudOptions;
  private readonly store = new CloudStore();
  private state!: CloudState;
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  private readonly connections = new Map<string, { generation: number; send: (frame: unknown) => void; close: () => void; seen: number }>();
  private constructor(options: CloudOptions) {
    this.options = options; const origin = new URL(options.publicOrigin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
        (origin.protocol !== "https:" && !(options.allowLoopbackForTests === true && loopback && origin.protocol === "http:"))) throw new Error("Cloud gateway requires an approved HTTPS origin");
    this.publicOrigin = origin.origin; this.rpId = origin.hostname;
    if (options.bootstrapToken && options.bootstrapToken.length < 32) throw new Error("Cloud bootstrap credential is too short");
  }
  static async open(options: CloudOptions): Promise<CloudControlPlane> {
    const control = new CloudControlPlane(options);
    try {
      control.state = await control.store.open(options.dataDirectory, () => {
        const keys = generateKeyPairSync("ed25519");
        return { version: 1, ownerId: randomUUID(), serverEpoch: 1, sequence: 0, stopped: false,
          signingPrivateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          signingPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          devices: [], pairings: [], enrollments: [], credentials: [], challenges: [], sessions: [], proposals: [], receipts: [],
          deviceOffers: [], commands: [], deviceReceipts: [], grants: [], snapshots: [], syncReceipts: [], channelPolicies: [] };
      });
      await control.mutate(state => {
        state.serverEpoch++; state.sessions = []; state.challenges = []; state.enrollments = []; state.pairings = []; state.deviceOffers = [];
        for (const device of state.devices) device.generation++;
        for (const proposal of state.proposals) if (proposal.status === "pending" || proposal.status === "executing") proposal.status = proposal.status === "executing" ? "unknown" : "invalidated";
        for (const command of state.commands) if (command.status === "queued" || command.status === "sent") command.status = command.status === "sent" ? "unknown" : "cancelled";
        if (options.localExecutorId) {
          CloudId.parse(options.localExecutorId);
          if (!options.readAction || !options.executeAction) throw new Error("Internal cloud executor requires existing-authority adapters");
          if (!state.devices.some(device => device.id === options.localExecutorId)) state.devices.push({ version: 1, id: options.localExecutorId,
            label: "Cloud runtime", tokenHash: hash(secret()), generation: 1, createdAt: control.time(), revokedAt: null });
        }
      });
      return control;
    } catch (error) { control.store.close(); throw error; }
  }
  private now(): number { return (this.options.now?.() ?? new Date()).getTime(); }
  private time(): string { return new Date(this.now()).toISOString(); }
  private until(ms: number): string { return new Date(this.now() + ms).toISOString(); }
  private ready(): void { if (this.failed || this.closed) throw new BridgeError("Cloud control is unavailable; reconcile durable state before continuing.", 503); }
  private mutate<T>(operation: (state: CloudState) => T | Promise<T>): Promise<T> {
    this.ready();
    const next = this.queue.then(async () => {
      this.ready(); const state = structuredClone(this.state); this.prune(state);
      const result = await operation(state);
      // User-visible capacity errors are not database durability failures.
      if (!CloudStateSchema.safeParse(state).success || Buffer.byteLength(JSON.stringify(state)) > 24 * 1024 * 1024) throw new BridgeError("Cloud history capacity reached; inspect retained state before adding more work.", 413);
      try { this.store.save(state); } catch (error) { this.failed = true; for (const connection of this.connections.values()) connection.close(); this.connections.clear(); throw error; }
      this.state = state; return structuredClone(result);
    });
    this.queue = next.catch(() => {}); return next;
  }
  private prune(state: CloudState): void {
    const valid = (entry: { expiresAt: string }) => Date.parse(entry.expiresAt) > this.now();
    state.sessions = state.sessions.filter(valid); state.challenges = state.challenges.filter(valid);
    state.pairings = state.pairings.filter(valid); state.enrollments = state.enrollments.filter(valid);
    const grants = new Set(state.grants.filter(grant => !grant.revokedAt && valid(grant)).map(grant => grant.id));
    state.snapshots = state.snapshots.filter(snapshot => grants.has(snapshot.grantId));
  }
  health() { return { version: 1, status: this.closed || this.failed ? "unavailable" : "ready", configured: true, passkeyEnrolled: this.state.credentials.length > 0 }; }
  admission() {
    return { version: 1 as const, ready: !this.closed && !this.failed && !this.state.stopped, stopped: this.state.stopped,
      reason: this.failed ? "persistence_failed" : this.closed ? "closed" : this.state.stopped ? "stopped" : null };
  }
  runtimeExecutorBinding() {
    this.ready(); if (!this.options.localExecutorId) throw new BridgeError("Cloud runtime executor is not configured.", 503);
    const device = this.device(this.state, this.options.localExecutorId);
    return { deviceId: device.id, generation: device.generation, serverEpoch: this.state.serverEpoch, receiptPublicKey: this.state.signingPublicKey };
  }
  private device(state: CloudState, id: string) {
    const device = state.devices.find(device => device.id === id && !device.revokedAt);
    if (!device) throw new BridgeError("Paired device unavailable.", 403); return device;
  }
  authenticateDevice(token: string | undefined, expectedId?: string): CloudActor & { kind: "device" } {
    this.ready(); if (!token || token.length > 200) throw new BridgeError("Device authentication required.", 401);
    const device = this.state.devices.find(device => !device.revokedAt && equalHash(token, device.tokenHash));
    if (!device || (expectedId && device.id !== expectedId)) throw new BridgeError("Device authentication required.", 401);
    return { kind: "device", deviceId: device.id };
  }
  authenticateOwner(token: string | undefined): CloudActor & { kind: "owner" } {
    this.ready(); if (!token || token.length > 200) throw new BridgeError("Passkey sign-in required.", 401);
    const session = this.state.sessions.find(session => equalHash(token, session.tokenHash) && Date.parse(session.expiresAt) > this.now());
    if (!session) throw new BridgeError("Passkey sign-in required.", 401);
    return { kind: "owner", sessionHash: session.tokenHash, credentialId: session.credentialId };
  }
  private actor(state: CloudState, actor: CloudActor): void {
    if (actor.kind === "device") this.device(state, actor.deviceId);
    else if (!state.sessions.some(session => session.tokenHash === actor.sessionHash && session.credentialId === actor.credentialId && Date.parse(session.expiresAt) > this.now())) throw new BridgeError("Passkey session expired.", 401);
  }
  async startPairing(raw: unknown, bootstrap: string | undefined) {
    const input = PairStartSchema.parse(raw);
    if (!this.options.bootstrapToken || !bootstrap || !equalHash(bootstrap, hash(this.options.bootstrapToken))) throw new BridgeError("Native bootstrap credential required.", 403);
    return this.mutate(state => {
      if (state.devices.some(device => device.id === input.deviceId)) throw new BridgeError("Device identity already exists; use a new paired identity.", 409);
      const pairingToken = secret(), pairingId = randomUUID(), expiresAt = this.until(300_000);
      state.pairings.push({ id: pairingId, ...input, tokenHash: hash(pairingToken), expiresAt, used: false });
      return { version: 1, pairingId, pairingToken, expiresAt };
    });
  }
  async completePairing(raw: unknown, token: string | undefined) {
    const input = PairCompleteSchema.parse(raw);
    return this.mutate(state => {
      const pairing = state.pairings.find(pairing => pairing.id === input.pairingId && pairing.deviceId === input.deviceId);
      if (!pairing || pairing.used || !token || !equalHash(token, pairing.tokenHash)) throw new BridgeError("Pairing is invalid or already consumed.", 403);
      if (state.devices.some(device => device.id === input.deviceId)) throw new BridgeError("Device identity already paired.", 409);
      pairing.used = true; const deviceToken = secret();
      state.devices.push({ version: 1, id: input.deviceId, label: pairing.label, tokenHash: hash(deviceToken), generation: 0, createdAt: this.time(), revokedAt: null });
      return { version: 1, deviceId: input.deviceId, deviceToken, generation: 0, receiptPublicKey: state.signingPublicKey };
    });
  }
  async connectDevice(actor: CloudActor & { kind: "device" }, send: (frame: unknown) => void, close: () => void) {
    const welcome = await this.mutate(state => {
      const device = this.device(state, actor.deviceId); device.generation++;
      for (const proposal of state.proposals) if (proposal.deviceId === device.id && ["pending", "executing"].includes(proposal.status)) proposal.status = proposal.status === "executing" ? "unknown" : "invalidated";
      for (const command of state.commands) if (command.deviceId === device.id && ["queued", "sent"].includes(command.status)) command.status = command.status === "sent" ? "unknown" : "cancelled";
      state.deviceOffers = state.deviceOffers.filter(offer => offer.deviceId !== device.id);
      return { version: 1 as const, type: "device.welcome" as const, deviceId: device.id, generation: device.generation, serverEpoch: state.serverEpoch, receiptPublicKey: state.signingPublicKey };
    });
    this.connections.get(actor.deviceId)?.close(); this.connections.set(actor.deviceId, { generation: welcome.generation, send, close, seen: this.now() });
    send(welcome); return welcome;
  }
  disconnectDevice(deviceId: string, generation: number): void { if (this.connections.get(deviceId)?.generation === generation) this.connections.delete(deviceId); }
  private live(state: CloudState, deviceId: string) {
    const device = this.device(state, deviceId), connection = this.connections.get(deviceId);
    if (deviceId === this.options.localExecutorId) return device;
    if (!connection || connection.generation !== device.generation || this.now() - connection.seen > 90_000) throw new BridgeError("Paired Mac is offline; reconnect and review current state.", 409);
    return device;
  }
  async receiveDeviceFrame(actor: CloudActor & { kind: "device" }, raw: unknown) {
    const frame = DeviceFrameSchema.parse(raw);
    if (frame.deviceId !== actor.deviceId) throw new BridgeError("Device frame identity mismatch.", 403);
    const device = this.device(this.state, actor.deviceId);
    if (frame.generation !== device.generation || frame.serverEpoch !== this.state.serverEpoch) throw new BridgeError("Device ownership generation changed.", 409);
    if (frame.type === "heartbeat") { const connection = this.connections.get(actor.deviceId); if (connection?.generation === frame.generation) connection.seen = this.now(); return { version: 1, type: "heartbeat.ack", generation: frame.generation, serverEpoch: frame.serverEpoch }; }
    return this.mutate(state => {
      const receipt = DeviceReceiptSchema.parse(frame.type === "reconcile" ? { version: 1, type: "receipt", id: frame.id, commandId: frame.commandId,
        deviceId: frame.deviceId, generation: frame.originalGeneration, serverEpoch: frame.originalServerEpoch, commandDigest: frame.commandDigest, status: frame.status, code: frame.code } : frame);
      const command = state.commands.find(command => command.id === receipt.commandId && command.deviceId === actor.deviceId);
      if (!command || command.digest !== receipt.commandDigest || command.generation !== receipt.generation || command.serverEpoch !== receipt.serverEpoch) throw new BridgeError("Receipt does not match an issued command.", 409);
      const old = state.deviceReceipts.find(old => old.id === receipt.id || old.commandId === receipt.commandId);
      if (frame.type === "reconcile" && old && canonicalJson({ ...old, id: receipt.id }) === canonicalJson(receipt)) return { version: 1, accepted: true, duplicate: true };
      if (old && !(frame.type === "reconcile" && old.status === "unknown" && old.id !== receipt.id)) { if (canonicalJson(old) !== canonicalJson(receipt)) throw new BridgeError("Receipt replay changed content.", 409); return { version: 1, accepted: true, duplicate: true }; }
      if (frame.type === "reconcile" ? command.status !== "unknown" : command.status !== "sent") throw new BridgeError("Command outcome cannot be replayed or overwritten.", 409);
      if (old) state.deviceReceipts = state.deviceReceipts.filter(item => item.commandId !== receipt.commandId);
      command.status = receipt.status; state.deviceReceipts.push(receipt);
      if (command.payload.kind === "action.execute") {
        const proposalId = command.payload.proposalId, proposal = state.proposals.find(proposal => proposal.id === proposalId);
        if (proposal) proposal.status = receipt.status === "completed" ? "completed" : "unknown";
      }
      return { version: 1, accepted: true, duplicate: false };
    });
  }
  async enqueueCommand(deviceId: string, raw: unknown): Promise<CloudCommand> {
    const payload = CommandPayloadSchema.parse(raw);
    const command = await this.mutate(state => {
      if (state.stopped && payload.kind !== "work.cancel") throw new BridgeError("Cloud work is stopped. Explicitly resume before preparing new work.", 409);
      const device = this.live(state, deviceId), expiresAt = this.until(120_000);
      if (payload.kind === "action.execute") {
        const proposal = state.proposals.find(proposal => proposal.id === payload.proposalId);
        if (!proposal || proposal.status !== "executing" || proposal.receiptId !== payload.receipt.id || proposal.commandId !== null) throw new BridgeError("Remote action has no unused authorization.", 409);
        verifyRemoteApprovalReceipt(payload.receipt, state.signingPublicKey, { deviceId, deviceGeneration: device.generation, serverEpoch: state.serverEpoch, action: payload.action, now: new Date(this.now()) });
      }
      if (payload.kind === "snapshot.request") { const grant = this.grant(state, payload.grantId); if (grant.deviceId !== deviceId || grant.projectId !== payload.projectId || grant.revision !== payload.grantRevision) throw new BridgeError("Snapshot command exceeds its retention grant.", 403); }
      const command: CloudCommand = { version: 1, type: "command", id: randomUUID(), deviceId, generation: device.generation, serverEpoch: state.serverEpoch,
        sequence: ++state.sequence, payload, expiresAt, createdAt: this.time(), status: "sent", digest: "" };
      command.digest = cloudCommandDigest(command); state.commands.push(command);
      if (Buffer.byteLength(JSON.stringify(command)) > 384 * 1024) throw new BridgeError("Command exceeds the device frame limit; use local review.", 413);
      if (payload.kind === "action.execute") state.proposals.find(proposal => proposal.id === payload.proposalId)!.commandId = command.id;
      return command;
    });
    try { const connection = this.connections.get(deviceId); if (!connection || connection.generation !== command.generation) throw new Error(); connection.send(command); }
    catch { await this.mutate(state => { const current = state.commands.find(item => item.id === command.id)!; current.status = "unknown";
      if (current.payload.kind === "action.execute") { const proposalId = current.payload.proposalId; state.proposals.find(item => item.id === proposalId)!.status = "unknown"; } }); }
    return structuredClone(this.state.commands.find(item => item.id === command.id)!);
  }
  private async resolveAction(state: CloudState, ref: ActionRef, projectId: string, deviceId: string): Promise<ReviewableAction | null> {
    const exactRef = { taskId: ref.taskId, interactionId: ref.interactionId, revision: ref.revision, optionId: ref.optionId };
    if (this.options.readAction && (!this.options.localExecutorId || deviceId === this.options.localExecutorId)) return this.options.readAction(exactRef, { projectId, deviceId });
    const generation = this.device(state, deviceId).generation;
    return state.deviceOffers.find(offer => offer.deviceId === deviceId && offer.projectId === projectId && offer.generation === generation && offer.serverEpoch === state.serverEpoch &&
      canonicalJson(exactRef) === canonicalJson({ taskId: offer.action.taskId, interactionId: offer.action.interactionId, revision: offer.action.revision, optionId: offer.action.optionId }))?.action ?? null;
  }
  async offerAction(actor: CloudActor & { kind: "device" }, raw: unknown) {
    const input = z.strictObject({ projectId: CloudId, generation: z.number().int().positive(), serverEpoch: z.number().int().positive(), action: ReviewableActionSchema }).parse(raw);
    if (Buffer.byteLength(JSON.stringify(input)) > 320 * 1024) throw new BridgeError("Action review exceeds the remote limit; use local review.", 413);
    await this.mutate(state => {
      const device = this.live(state, actor.deviceId);
      if (input.generation !== device.generation || input.serverEpoch !== state.serverEpoch) throw new BridgeError("Stale device action offer.", 409);
      state.deviceOffers = state.deviceOffers.filter(offer => !(offer.deviceId === device.id && offer.action.taskId === input.action.taskId && offer.action.interactionId === input.action.interactionId));
      state.deviceOffers.push({ deviceId: device.id, projectId: input.projectId, generation: device.generation, serverEpoch: state.serverEpoch, action: input.action, createdAt: this.time() });
      for (const proposal of state.proposals) if (proposal.deviceId === device.id && proposal.action.taskId === input.action.taskId && proposal.action.interactionId === input.action.interactionId && proposal.status === "pending") proposal.status = "invalidated";
    });
    return this.createActionProposal({ projectId: input.projectId, deviceId: actor.deviceId, ref: {
      taskId: input.action.taskId, interactionId: input.action.interactionId, revision: input.action.revision, optionId: input.action.optionId } });
  }
  async createActionProposal(raw: unknown): Promise<RemoteActionProposal> {
    const input = CreateRemoteActionSchema.parse(raw);
    return this.mutate(async state => {
      if (state.stopped) throw new BridgeError("Cloud work is stopped. Explicitly resume before preparing new work.", 409);
      const device = this.live(state, input.deviceId), current = await this.resolveAction(state, input.ref, input.projectId, input.deviceId);
      if (!current) throw new BridgeError("Exact pending action is unavailable.", 409);
      const action = ReviewableActionSchema.parse(current), digest = actionDigest(action);
      if (canonicalJson(input.ref) !== canonicalJson({ taskId: action.taskId, interactionId: action.interactionId, revision: action.revision, optionId: action.optionId })) throw new BridgeError("Pending action reference changed.", 409);
      const pending = state.proposals.find(proposal => proposal.deviceId === input.deviceId && proposal.digest === digest && proposal.status === "pending" &&
        proposal.deviceGeneration === device.generation && proposal.serverEpoch === state.serverEpoch && Date.parse(proposal.expiresAt) > this.now());
      if (pending) return pending;
      if (state.proposals.some(proposal => proposal.deviceId === input.deviceId && proposal.digest === digest && ["executing", "completed", "failed", "unknown"].includes(proposal.status))) throw new BridgeError("This exact action was already submitted; inspect its existing outcome.", 409);
      if (containsCredentialLikeData(action.exactArguments) || containsCredentialLikeData(action.reviewText)) throw new BridgeError("Credential-bearing actions require local review.", 403);
      const proposal: RemoteActionProposal = { version: 1, id: randomUUID(), projectId: input.projectId, deviceId: input.deviceId,
        deviceGeneration: device.generation, serverEpoch: state.serverEpoch, revision: 1, action, digest, status: "pending", createdAt: this.time(), expiresAt: this.until(300_000), receiptId: null, commandId: null };
      state.proposals.push(proposal); return proposal;
    });
  }
  proposal(id: string, actor: CloudActor) { this.ready(); this.actor(this.state, actor); const proposal = this.state.proposals.find(proposal => proposal.id === id);
    if (!proposal || actor.kind === "device" && proposal.deviceId !== actor.deviceId) throw new BridgeError("Remote action unavailable.", 404); return structuredClone(proposal); }
  async startEnrollment(actor: CloudActor) {
    return this.mutate(state => { this.actor(state, actor); if (actor.kind !== "device") throw new BridgeError("Passkey enrollment requires a paired native device.", 403);
      const token = secret(), expiresAt = this.until(300_000); state.enrollments.push({ tokenHash: hash(token), deviceId: actor.deviceId, expiresAt, used: false });
      return { version: 1, enrollmentToken: token, expiresAt, url: `${this.publicOrigin}/v1/cloud/enroll#token=${token}` }; });
  }
  async registrationOptions(token: string) {
    return this.mutate(async state => {
      const enrollment = state.enrollments.find(enrollment => !enrollment.used && equalHash(token, enrollment.tokenHash));
      if (!enrollment) throw new BridgeError("Native enrollment invitation expired.", 403);
      this.device(state, enrollment.deviceId);
      const options = await generateRegistrationOptions({ rpName: "Jarvis", rpID: this.rpId, userID: Buffer.from(state.ownerId), userName: "Jarvis owner",
        attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: state.credentials.map(credential => ({ id: credential.id, transports: credential.transports as AuthenticatorTransport[] })) });
      const challengeId = randomUUID(); state.challenges.push({ id: challengeId, kind: "registration", challenge: options.challenge,
        binding: enrollment.tokenHash, sessionHash: null, expiresAt: this.until(120_000), used: false });
      return { version: 1, challengeId, options };
    });
  }
  private takeChallenge(state: CloudState, id: string, kind: CloudState["challenges"][number]["kind"], sessionHash: string | null) {
    const challenge = state.challenges.find(challenge => challenge.id === id && challenge.kind === kind && challenge.sessionHash === sessionHash && !challenge.used && Date.parse(challenge.expiresAt) > this.now());
    if (!challenge) throw new BridgeError("Passkey challenge is stale, consumed or bound elsewhere.", 403); return challenge;
  }
  async finishRegistration(token: string, challengeId: string, response: RegistrationResponseJSON) {
    return this.mutate(async state => {
      const challenge = this.takeChallenge(state, challengeId, "registration", null), enrollment = state.enrollments.find(enrollment => !enrollment.used && equalHash(token, enrollment.tokenHash));
      if (!enrollment || enrollment.tokenHash !== challenge.binding) throw new BridgeError("Enrollment invitation does not match.", 403);
      this.device(state, enrollment.deviceId);
      const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.publicOrigin, expectedRPID: this.rpId, requireUserVerification: true });
      if (!verification.verified || !verification.registrationInfo) throw new BridgeError("Passkey registration failed.", 403);
      const credential = verification.registrationInfo.credential;
      if (state.credentials.some(existing => existing.id === credential.id)) throw new BridgeError("Passkey already registered.", 409);
      state.credentials.push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter,
        transports: credential.transports ?? [], createdAt: this.time() }); challenge.used = true; enrollment.used = true;
      return { version: 1, registered: true };
    });
  }
  async authenticationOptions() {
    return this.mutate(async state => {
      if (!state.credentials.length) throw new BridgeError("Enroll a passkey from the paired Mac first.", 409);
      const options = await generateAuthenticationOptions({ rpID: this.rpId, userVerification: "required", allowCredentials: state.credentials.map(credential => ({ id: credential.id, transports: credential.transports as AuthenticatorTransport[] })) });
      const challengeId = randomUUID(); state.challenges.push({ id: challengeId, kind: "session", challenge: options.challenge, binding: null, sessionHash: null, expiresAt: this.until(120_000), used: false });
      return { version: 1, challengeId, options };
    });
  }
  private async assertion(state: CloudState, challenge: CloudState["challenges"][number], response: AuthenticationResponseJSON) {
    const credential = state.credentials.find(credential => credential.id === response.id);
    if (!credential) throw new BridgeError("Unrecognized passkey.", 403);
    const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.publicOrigin,
      expectedRPID: this.rpId, requireUserVerification: true, credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, "base64url"), counter: credential.counter,
        transports: credential.transports as AuthenticatorTransport[] } });
    if (!verification.verified) throw new BridgeError("Passkey verification failed.", 403);
    credential.counter = verification.authenticationInfo.newCounter; challenge.used = true; return credential;
  }
  async finishAuthentication(challengeId: string, response: AuthenticationResponseJSON) {
    return this.mutate(async state => {
      const challenge = this.takeChallenge(state, challengeId, "session", null), credential = await this.assertion(state, challenge, response);
      const sessionToken = secret(), expiresAt = this.until(900_000); state.sessions = state.sessions.slice(-29); state.sessions.push({ tokenHash: hash(sessionToken), credentialId: credential.id, expiresAt });
      return { version: 1, authenticated: true, sessionToken, expiresAt };
    });
  }
  async approvalOptions(proposalId: string, actor: CloudActor & { kind: "owner" }) {
    return this.mutate(async state => {
      this.actor(state, actor); const proposal = state.proposals.find(proposal => proposal.id === proposalId);
      if (!proposal || proposal.status !== "pending" || Date.parse(proposal.expiresAt) <= this.now()) throw new BridgeError("Action review expired or is no longer pending.", 409);
      this.live(state, proposal.deviceId);
      const current = await this.resolveAction(state, proposal.action, proposal.projectId, proposal.deviceId);
      if (!current || actionDigest(current) !== proposal.digest) throw new BridgeError("Action changed; prepare a new exact review.", 409);
      const options = await generateAuthenticationOptions({ rpID: this.rpId, userVerification: "required", allowCredentials: state.credentials.map(credential => ({ id: credential.id })) });
      const challengeId = randomUUID(); state.challenges.push({ id: challengeId, kind: "action", challenge: options.challenge,
        binding: `${proposal.id}:${proposal.revision}:${proposal.digest}`, sessionHash: actor.sessionHash, expiresAt: this.until(120_000), used: false });
      return { version: 1, challengeId, options, proposal: structuredClone(proposal) };
    });
  }
  async finishApproval(proposalId: string, challengeId: string, response: AuthenticationResponseJSON, actor: CloudActor & { kind: "owner" }) {
    const prepared = await this.mutate(async state => {
      this.actor(state, actor); const challenge = this.takeChallenge(state, challengeId, "action", actor.sessionHash), proposal = state.proposals.find(proposal => proposal.id === proposalId);
      if (!proposal || proposal.status !== "pending" || Date.parse(proposal.expiresAt) <= this.now() || challenge.binding !== `${proposal.id}:${proposal.revision}:${proposal.digest}`) throw new BridgeError("Approval no longer matches the exact pending action.", 409);
      const device = this.live(state, proposal.deviceId);
      if (device.generation !== proposal.deviceGeneration || state.serverEpoch !== proposal.serverEpoch) throw new BridgeError("Executor ownership changed.", 409);
      const credential = await this.assertion(state, challenge, response);
      const current = await this.resolveAction(state, proposal.action, proposal.projectId, proposal.deviceId);
      if (!current || actionDigest(current) !== proposal.digest) throw new BridgeError("Action changed; review it again.", 409);
      const content = { version: 1 as const, id: randomUUID(), proposalId: proposal.id, projectId: proposal.projectId, deviceId: proposal.deviceId,
        deviceGeneration: device.generation, serverEpoch: state.serverEpoch,
        actionRef: { taskId: proposal.action.taskId, interactionId: proposal.action.interactionId, revision: proposal.action.revision, optionId: proposal.action.optionId },
        actionDigest: proposal.digest, credentialId: credential.id, nonce: randomUUID(), issuedAt: this.time(), expiresAt: this.until(120_000) };
      const receipt: RemoteApprovalReceipt = { ...content, signature: sign(null, Buffer.from(canonicalJson(content)), createPrivateKey(state.signingPrivateKey)).toString("base64url") };
      state.receipts.push(receipt); proposal.receiptId = receipt.id; proposal.status = "executing";
      if (this.options.executeAction && (!this.options.localExecutorId || receipt.deviceId === this.options.localExecutorId)) {
        // The exact local command is durable before dispatch, including when a
        // response is lost or the gateway restarts before learning its outcome.
        const command = remoteActionCommand(proposal.action, receipt, ++state.sequence);
        state.commands.push(command); proposal.commandId = command.id;
      }
      return { action: proposal.action, receipt };
    });
    // Durable single-use fence precedes the only existing execution authority.
    try {
      if (this.options.executeAction && (!this.options.localExecutorId || prepared.receipt.deviceId === this.options.localExecutorId)) {
        const result = await this.options.executeAction(prepared.action, prepared.receipt);
        await this.mutate(state => { const proposal = state.proposals.find(proposal => proposal.id === proposalId)!;
          if (["completed", "failed"].includes(proposal.status)) return;
          if (result.commandId && result.commandId !== proposal.commandId) throw new BridgeError("Execution command binding changed.", 409);
          proposal.status = result.outcome === "completed" || result.outcome === "failed" ? result.outcome : result.outcome === "queued" && !state.stopped ? "executing" : "unknown";
          const command = state.commands.find(command => command.id === proposal.commandId);
          if (command) command.status = proposal.status === "completed" || proposal.status === "failed" ? proposal.status : "unknown";
        });
      } else await this.enqueueCommand(prepared.receipt.deviceId, { kind: "action.execute", proposalId, action: prepared.action, receipt: prepared.receipt });
    } catch { await this.mutate(state => {
      const proposal = state.proposals.find(proposal => proposal.id === proposalId)!;
      if (!["completed", "failed"].includes(proposal.status)) proposal.status = "unknown";
      const command = state.commands.find(command => command.id === proposal.commandId);
      if (command && !["completed", "failed"].includes(command.status)) command.status = "unknown";
    }); }
    return this.proposal(proposalId, actor);
  }
  /** Observe a frozen command journal entry, even after expiry/restart/Stop.
   * No action resolution, approval, dispatch or retry occurs on this path. */
  async reconcileLocalExecutions(actor: CloudActor & { kind: "owner" }, proposalId?: string): Promise<{ checked: number; updated: number }> {
    this.ready(); this.actor(this.state, actor);
    if (!this.options.readActionResult) return { checked: 0, updated: 0 };
    const commands = this.state.commands.filter(command => command.payload.kind === "action.execute" &&
      (!this.options.localExecutorId || command.deviceId === this.options.localExecutorId) && ["sent", "unknown"].includes(command.status) &&
      this.state.proposals.some(proposal => proposal.commandId === command.id && (!proposalId || proposal.id === proposalId) && ["executing", "unknown"].includes(proposal.status))).slice(0, 20);
    let checked = 0, updated = 0; const deadline = Date.now() + 2_500;
    for (const command of commands) {
      if (Date.now() >= deadline) break;
      let result, timeout: NodeJS.Timeout | undefined;
      try { result = z.strictObject({ version: z.literal(1), status: z.enum(["completed", "failed", "unknown"]),
        code: z.enum(["ok", "rejected", "stale", "unavailable", "interrupted", "unknown"]) }).parse(await Promise.race([
          this.options.readActionResult(structuredClone(command)), new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Receipt observation unavailable")), Math.max(1, deadline - Date.now()));
          }),
        ])); }
      catch { continue; }
      finally { clearTimeout(timeout); }
      checked++; if (result.status === "unknown") continue;
      const terminal = result.status;
      const changed = await this.mutate(state => {
        this.actor(state, actor);
        const current = state.commands.find(value => value.id === command.id && value.digest === command.digest);
        if (!current || current.payload.kind !== "action.execute" || !["sent", "unknown"].includes(current.status)) return false;
        const payload = current.payload;
        const proposal = state.proposals.find(proposal => proposal.id === payload.proposalId && proposal.commandId === current.id &&
          proposal.receiptId === payload.receipt.id && proposal.digest === payload.receipt.actionDigest);
        if (!proposal || !["executing", "unknown"].includes(proposal.status)) return false;
        current.status = terminal; proposal.status = terminal; return true;
      });
      if (changed) updated++;
    }
    return { checked, updated };
  }
  async callOptions(callSid: string, actor: CloudActor & { kind: "owner" }) {
    if (!/^CA[0-9a-fA-F]{32}$/.test(callSid) || !this.options.readCall || !this.options.authorizeCall) throw new BridgeError("Live call authentication is unavailable.", 409);
    return this.mutate(async state => {
      if (state.stopped) throw new BridgeError("Cloud calls are stopped.", 409);
      this.actor(state, actor); const call = await this.options.readCall!(callSid);
      if (!call || call.callSid !== callSid || !["ringing", "in_progress"].includes(call.status)) throw new BridgeError("Call is no longer active.", 409);
      const options = await generateAuthenticationOptions({ rpID: this.rpId, userVerification: "required", allowCredentials: state.credentials.map(credential => ({ id: credential.id })) });
      const challengeId = randomUUID(); state.challenges.push({ id: challengeId, kind: "call", challenge: options.challenge, binding: callSid, sessionHash: actor.sessionHash, expiresAt: this.until(120_000), used: false });
      return { version: 1, challengeId, options, callSid };
    });
  }
  async finishCall(callSid: string, challengeId: string, response: AuthenticationResponseJSON, actor: CloudActor & { kind: "owner" }) {
    const proof = await this.mutate(async state => {
      if (state.stopped) throw new BridgeError("Cloud calls are stopped.", 409);
      this.actor(state, actor); const challenge = this.takeChallenge(state, challengeId, "call", actor.sessionHash);
      if (challenge.binding !== callSid || !this.options.readCall || !this.options.authorizeCall) throw new BridgeError("Call challenge identity mismatch.", 403);
      const credential = await this.assertion(state, challenge, response), call = await this.options.readCall(callSid);
      if (!call || call.callSid !== callSid || !["ringing", "in_progress"].includes(call.status)) throw new BridgeError("Call ended before verification.", 409);
      return { credentialId: credential.id, verifiedAt: this.time(), expiresAt: this.until(300_000), ownerSessionId: actor.sessionHash };
    });
    await this.options.authorizeCall!(callSid, proof); return { version: 1, authorized: true, callSid, expiresAt: proof.expiresAt };
  }
  private grant(state: CloudState, id: string): RetentionGrant {
    const grant = state.grants.find(grant => grant.id === id && !grant.revokedAt && Date.parse(grant.expiresAt) > this.now());
    if (!grant) throw new BridgeError("Cloud retention grant is unavailable or expired.", 403); return grant;
  }
  private boundedExpiry(expiresAt: string) { if (Date.parse(expiresAt) <= this.now() || Date.parse(expiresAt) > this.now() + 30 * 86400000) throw new BridgeError("Cloud grant expiry must be within the next 30 days.", 400); }
  async createRetentionGrant(raw: unknown, actor: CloudActor) {
    const input = RetentionGrantInputSchema.parse(raw); this.boundedExpiry(input.expiresAt);
    if (new Set(input.selected.map(keyOf)).size !== input.selected.length || new Set(input.processors).size !== input.processors.length) throw new BridgeError("Duplicate retention selections.", 400);
    return this.mutate(state => { this.actor(state, actor); this.device(state, input.deviceId); if (actor.kind === "device" && actor.deviceId !== input.deviceId) throw new BridgeError("Retention grant device mismatch.", 403);
      const grant: RetentionGrant = { ...input, version: 1, id: randomUUID(), revision: 1, createdAt: this.time(), revokedAt: null }; state.grants.push(grant); return grant; });
  }
  async revokeRetentionGrant(id: string, expectedRevision: number, actor: CloudActor) {
    return this.mutate(state => { this.actor(state, actor); const grant = this.grant(state, id);
      if (actor.kind === "device" && actor.deviceId !== grant.deviceId) throw new BridgeError("Grant device mismatch.", 403);
      if (grant.revision !== expectedRevision) throw new BridgeError("Retention grant changed.", 409);
      grant.revision++; grant.revokedAt = this.time(); state.snapshots = state.snapshots.filter(snapshot => snapshot.grantId !== id); return grant; });
  }
  async syncSnapshots(raw: unknown, actor: CloudActor & { kind: "device" }) {
    const input = SyncSnapshotsSchema.parse(raw), requestDigest = hash(canonicalJson(input));
    return this.mutate(state => {
      this.actor(state, actor); const grant = this.grant(state, input.grantId);
      if (grant.deviceId !== actor.deviceId || grant.revision !== input.grantRevision) throw new BridgeError("Snapshot sync exceeds current retention authority.", 403);
      const old = state.syncReceipts.find(receipt => receipt.requestId === input.requestId);
      if (old) { if (old.deviceId !== actor.deviceId || old.digest !== requestDigest) throw new BridgeError("Sync request identity was reused with different content.", 409); return { version: 1, accepted: old.accepted, duplicate: true }; }
      const selected = new Set(grant.selected.map(keyOf));
      for (const snapshot of input.snapshots) {
        if (!selected.has(keyOf(snapshot)) || hash(snapshot.text) !== snapshot.sha256 || Buffer.byteLength(snapshot.text) > 128_000 || containsCredentialLikeData(snapshot.text)) throw new BridgeError("Snapshot is not an exact selected credential-free immutable version.", 403);
        const key = keyOf(snapshot), existing = state.snapshots.find(existing => existing.grantId === grant.id && keyOf(existing) === key);
        if (existing && existing.text !== snapshot.text) throw new BridgeError("Immutable snapshot content changed.", 409);
        if (!existing) state.snapshots.push({ ...snapshot, version: 1, grantId: grant.id, grantRevision: grant.revision, projectId: grant.projectId, deviceId: actor.deviceId, syncedAt: this.time() });
      }
      if (state.snapshots.filter(snapshot => snapshot.grantId === grant.id).reduce((sum, snapshot) => sum + Buffer.byteLength(snapshot.text), 0) > grant.maxBytes) throw new BridgeError("Snapshot retention byte allowance exceeded.", 413);
      state.syncReceipts.push({ requestId: input.requestId, deviceId: actor.deviceId, grantId: grant.id, digest: requestDigest, accepted: input.snapshots.length });
      return { version: 1, accepted: input.snapshots.length, duplicate: false };
    });
  }
  readSnapshots(projectId: string, processor: string) {
    this.ready(); CloudId.parse(projectId); CloudId.parse(processor);
    const grants = new Set(this.state.grants.filter(grant => grant.projectId === projectId && !grant.revokedAt && Date.parse(grant.expiresAt) > this.now() && grant.processors.includes(processor)).map(grant => grant.id));
    return structuredClone(this.state.snapshots.filter(snapshot => snapshot.projectId === projectId && grants.has(snapshot.grantId)));
  }
  authorizeSnapshot(ref: { grantId: string; grantRevision: number; kind: "source" | "memory"; id: string; revision: number; sha256: string }, projectId: string, processor: string): boolean {
    try { this.ready(); const grant = this.grant(this.state, ref.grantId);
      return grant.revision === ref.grantRevision && grant.projectId === projectId && grant.processors.includes(processor) &&
        this.state.snapshots.some(snapshot => snapshot.grantId === ref.grantId && snapshot.grantRevision === ref.grantRevision && snapshot.projectId === projectId && keyOf(snapshot) === keyOf(ref));
    } catch { return false; }
  }
  listRetentionGrants(actor: CloudActor) { this.ready(); this.actor(this.state, actor); return structuredClone(this.state.grants.filter(grant => actor.kind === "owner" || grant.deviceId === actor.deviceId)); }
  async createChannelPolicy(raw: unknown, actor: CloudActor) {
    const input = ChannelPolicyInputSchema.parse(raw); this.boundedExpiry(input.expiresAt);
    if (input.channel === "phone" ? !/^\+[1-9][0-9]{7,14}$/.test(input.destinationId) : !/^[1-9][0-9]{0,19}$/.test(input.destinationId)) throw new BridgeError("Use an exact verified destination identity.", 400);
    return this.mutate(state => { this.actor(state, actor); const policy = { ...input, version: 1 as const, id: randomUUID(), revision: 1, createdAt: this.time(), revokedAt: null };
      for (const old of state.channelPolicies) if (!old.revokedAt && old.projectId === input.projectId && old.channel === input.channel && old.destinationId === input.destinationId) { old.revokedAt = this.time(); old.revision++; }
      state.channelPolicies.push(policy); return policy; });
  }
  authorizeDisclosure(input: { projectId: string; channel: "telegram" | "phone"; destinationId: string; proactive: boolean }): boolean {
    if (this.failed || this.closed || this.state.stopped) return false;
    return this.state.channelPolicies.some(policy => !policy.revokedAt && Date.parse(policy.expiresAt) > this.now() && policy.projectId === input.projectId && policy.channel === input.channel && policy.destinationId === input.destinationId && policy.allowDetails && (!input.proactive || policy.allowProactive));
  }
  async revokeChannelPolicy(id: string, actor: CloudActor) {
    return this.mutate(state => { this.actor(state, actor); const policy = state.channelPolicies.find(policy => policy.id === id);
      if (!policy) throw new BridgeError("Channel policy not found.", 404); policy.revokedAt = this.time(); policy.revision++; return policy; });
  }
  async revokeDevice(id: string, actor: CloudActor) {
    const result = await this.mutate(state => { this.actor(state, actor); if (actor.kind === "device" && actor.deviceId !== id) throw new BridgeError("Device revocation scope mismatch.", 403);
      const device = this.device(state, id); device.revokedAt = this.time(); device.generation++;
      state.deviceOffers = state.deviceOffers.filter(offer => offer.deviceId !== id);
      for (const proposal of state.proposals) if (proposal.deviceId === id && ["pending", "executing"].includes(proposal.status)) proposal.status = proposal.status === "executing" ? "unknown" : "invalidated";
      for (const grant of state.grants) if (grant.deviceId === id && !grant.revokedAt) { grant.revokedAt = this.time(); grant.revision++; }
      state.snapshots = state.snapshots.filter(snapshot => snapshot.deviceId !== id); return { version: 1, revoked: true }; });
    this.connections.get(id)?.close(); this.connections.delete(id); return result;
  }
  overview(actor: CloudActor & { kind: "owner" }) {
    this.ready(); this.actor(this.state, actor);
    return { version: 1, devices: this.state.devices.map(({ id, label, generation, revokedAt }) => ({ id, label, generation, revokedAt, connected: this.connections.has(id) || id === this.options.localExecutorId })),
      proposals: this.state.proposals.map(({ id, projectId, status, expiresAt }) => ({ id, projectId, status, expiresAt })),
      grants: structuredClone(this.state.grants), channelPolicies: structuredClone(this.state.channelPolicies) };
  }
  async logout(actor: CloudActor & { kind: "owner" }) { await this.mutate(state => { this.actor(state, actor); state.sessions = state.sessions.filter(session => session.tokenHash !== actor.sessionHash); }); }
  async stopAll() {
    await this.mutate(state => {
      state.stopped = true; state.challenges = []; state.deviceOffers = [];
      for (const proposal of state.proposals) if (["pending", "executing"].includes(proposal.status)) proposal.status = proposal.status === "pending" ? "invalidated" : "unknown";
      for (const command of state.commands) if (["queued", "sent"].includes(command.status)) command.status = command.status === "queued" ? "cancelled" : "unknown";
    });
    await this.options.revokeCallAuthorizations?.();
    return { version: 1, stopped: true, callAuthorizationRevoked: Boolean(this.options.revokeCallAuthorizations) };
  }
  async resume(actor: CloudActor) { return this.mutate(state => { this.actor(state, actor); state.stopped = false; return { version: 1, resumed: true }; }); }
  async purgeExpired(): Promise<void> { await this.mutate(() => {}); }
  async close() { for (const connection of this.connections.values()) connection.close(); this.connections.clear(); await this.queue; this.closed = true; this.store.close(); }
}
