import { z } from "zod";
import { ActionRefSchema, ReviewableActionSchema } from "../assistant/contracts.ts";

export const CLOUD_VERSION = 1 as const;
export const CloudId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const timestamp = z.iso.datetime(), revision = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PairStartSchema = z.strictObject({ deviceId: CloudId, label: z.string().trim().min(1).max(120) });
export const PairCompleteSchema = z.strictObject({ pairingId: CloudId, deviceId: CloudId });
export const DeviceSchema = z.strictObject({ version: z.literal(1), id: CloudId, label: z.string().max(120),
  tokenHash: digest, generation: z.number().int().nonnegative(), createdAt: timestamp, revokedAt: timestamp.nullable() });

export const RemoteApprovalReceiptSchema = z.strictObject({
  version: z.literal(1), id: CloudId, proposalId: CloudId, projectId: CloudId, deviceId: CloudId,
  deviceGeneration: revision, serverEpoch: revision, actionRef: ActionRefSchema, actionDigest: digest,
  credentialId: z.string().min(1).max(2048), nonce: CloudId, issuedAt: timestamp, expiresAt: timestamp,
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
});
export type RemoteApprovalReceipt = z.infer<typeof RemoteApprovalReceiptSchema>;
export const RemoteActionProposalSchema = z.strictObject({
  version: z.literal(1), id: CloudId, projectId: CloudId, deviceId: CloudId, deviceGeneration: revision,
  serverEpoch: revision, revision, action: ReviewableActionSchema, digest,
  status: z.enum(["pending", "executing", "completed", "invalidated", "unknown"]),
  createdAt: timestamp, expiresAt: timestamp, receiptId: CloudId.nullable(), commandId: CloudId.nullable(),
});
export type RemoteActionProposal = z.infer<typeof RemoteActionProposalSchema>;
export const CreateRemoteActionSchema = z.strictObject({ projectId: CloudId, deviceId: CloudId, ref: ActionRefSchema });

export const SnapshotSelectionSchema = z.strictObject({ kind: z.enum(["source", "memory"]), id: CloudId, revision, sha256: digest });
export const RetentionGrantInputSchema = z.strictObject({ deviceId: CloudId, projectId: CloudId,
  selected: z.array(SnapshotSelectionSchema).min(1).max(500), expiresAt: timestamp,
  maxBytes: z.number().int().min(1).max(8 * 1024 * 1024), processors: z.array(CloudId).min(1).max(10),
});
export const RetentionGrantSchema = RetentionGrantInputSchema.extend({ version: z.literal(1), id: CloudId,
  revision, createdAt: timestamp, revokedAt: timestamp.nullable() });
export type RetentionGrant = z.infer<typeof RetentionGrantSchema>;
export const SyncSnapshotsSchema = z.strictObject({ requestId: CloudId, grantId: CloudId, grantRevision: revision,
  snapshots: z.array(SnapshotSelectionSchema.extend({ text: z.string().max(128_000) })).min(1).max(100),
});
export const RetainedSnapshotSchema = SnapshotSelectionSchema.extend({ version: z.literal(1), grantId: CloudId,
  grantRevision: revision, projectId: CloudId, deviceId: CloudId, text: z.string().max(128_000), syncedAt: timestamp });
export const ChannelPolicyInputSchema = z.strictObject({ projectId: CloudId, channel: z.enum(["telegram", "phone"]),
  destinationId: z.string().min(1).max(160), allowDetails: z.boolean(), allowProactive: z.boolean(), expiresAt: timestamp,
});
export const ChannelPolicySchema = ChannelPolicyInputSchema.extend({ version: z.literal(1), id: CloudId, revision,
  createdAt: timestamp, revokedAt: timestamp.nullable() });

export const CommandPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot.request"), grantId: CloudId, grantRevision: revision, projectId: CloudId }),
  z.strictObject({ kind: z.literal("action.execute"), proposalId: CloudId, action: ReviewableActionSchema, receipt: RemoteApprovalReceiptSchema }),
  z.strictObject({ kind: z.literal("work.cancel"), projectId: CloudId, jobId: CloudId }),
]);
export type CommandPayload = z.infer<typeof CommandPayloadSchema>;
export const CloudCommandSchema = z.strictObject({ version: z.literal(1), type: z.literal("command"), id: CloudId,
  deviceId: CloudId, generation: revision, serverEpoch: revision, sequence: revision, digest,
  payload: CommandPayloadSchema, createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(["queued", "sent", "completed", "failed", "unknown", "cancelled"]),
});
export type CloudCommand = z.infer<typeof CloudCommandSchema>;
export const DeviceReceiptSchema = z.strictObject({ version: z.literal(1), type: z.literal("receipt"),
  id: CloudId, commandId: CloudId, deviceId: CloudId, generation: revision, serverEpoch: revision,
  commandDigest: digest, status: z.enum(["completed", "failed", "unknown"]),
  // A bounded status label, never source contents, credentials or arbitrary logs.
  code: z.enum(["ok", "rejected", "stale", "unavailable", "interrupted", "unknown"]),
});
export type DeviceReceipt = z.infer<typeof DeviceReceiptSchema>;
export const DeviceReconciliationSchema = DeviceReceiptSchema.omit({ type: true }).extend({ type: z.literal("reconcile"),
  originalGeneration: revision, originalServerEpoch: revision });
export const DeviceFrameSchema = z.discriminatedUnion("type", [DeviceReceiptSchema,
  DeviceReconciliationSchema,
  z.strictObject({ version: z.literal(1), type: z.literal("heartbeat"), deviceId: CloudId, generation: revision, serverEpoch: revision }),
]);
export const ServerWelcomeSchema = z.strictObject({ version: z.literal(1), type: z.literal("device.welcome"),
  deviceId: CloudId, generation: revision, serverEpoch: revision, receiptPublicKey: z.string().max(2048) });

const CredentialSchema = z.strictObject({ id: z.string().max(2048), publicKey: z.string().max(8192), counter: z.number().int().nonnegative(),
  transports: z.array(z.string().max(40)).max(10), createdAt: timestamp });
const ChallengeSchema = z.strictObject({ id: CloudId, kind: z.enum(["registration", "session", "action", "call"]), challenge: z.string().max(2048),
  binding: z.string().max(2048).nullable(), sessionHash: digest.nullable(), expiresAt: timestamp, used: z.boolean() });
export const CloudStateSchema = z.strictObject({ version: z.literal(1), ownerId: CloudId, serverEpoch: revision, stopped: z.boolean().default(false),
  signingPrivateKey: z.string().max(4096), signingPublicKey: z.string().max(2048), sequence: z.number().int().nonnegative(),
  devices: z.array(DeviceSchema).max(10),
  pairings: z.array(z.strictObject({ id: CloudId, deviceId: CloudId, label: z.string().max(120), tokenHash: digest, expiresAt: timestamp, used: z.boolean() })).max(30),
  enrollments: z.array(z.strictObject({ tokenHash: digest, deviceId: CloudId, expiresAt: timestamp, used: z.boolean() })).max(30),
  credentials: z.array(CredentialSchema).max(10), challenges: z.array(ChallengeSchema).max(300),
  sessions: z.array(z.strictObject({ tokenHash: digest, credentialId: z.string().max(2048), expiresAt: timestamp })).max(30),
  proposals: z.array(RemoteActionProposalSchema).max(1000), receipts: z.array(RemoteApprovalReceiptSchema).max(1000),
  deviceOffers: z.array(z.strictObject({ deviceId: CloudId, projectId: CloudId, generation: revision, serverEpoch: revision,
    action: ReviewableActionSchema, createdAt: timestamp })).max(500),
  commands: z.array(CloudCommandSchema).max(2000), deviceReceipts: z.array(DeviceReceiptSchema).max(2000),
  grants: z.array(RetentionGrantSchema).max(500), snapshots: z.array(RetainedSnapshotSchema).max(1000),
  syncReceipts: z.array(z.strictObject({ requestId: CloudId, deviceId: CloudId, grantId: CloudId, digest, accepted: z.number().int().nonnegative() })).max(2000),
  channelPolicies: z.array(ChannelPolicySchema).max(100),
});
export type CloudState = z.infer<typeof CloudStateSchema>;
