import { z } from "zod";

export const HARNESS_VERSION = 1 as const;
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const TimestampSchema = z.iso.datetime();
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const CounterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const TextSchema = z.string().trim().min(1).max(16_000);
export const RelativePathSchema = z.string().min(1).max(240).refine(
  (path) => !/[\\\x00-\x1f\x7f:%]/.test(path) && !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Expected a normalized relative POSIX file path without traversal or encoding",
);

export const BudgetLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(100),
  maxModelCalls: z.number().int().min(1).max(100),
  maxTokens: z.number().int().min(128).max(1_000_000),
  maxOutputTokensPerCall: z.number().int().min(64).max(16_384),
  maxWallTimeMs: z.number().int().min(1_000).max(3_600_000),
  estimatedUsdLimit: z.number().finite().min(0).max(1_000).nullable(),
}).refine((value) => value.maxOutputTokensPerCall <= value.maxTokens, "Output cap exceeds token budget");
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

export const UsageSchema = z.strictObject({
  steps: CounterSchema,
  modelCalls: CounterSchema,
  inputTokens: CounterSchema,
  outputTokens: CounterSchema,
  reservedTokens: CounterSchema,
  accounting: z.enum(["measured", "partial", "unknown"]),
  estimatedUsd: z.number().finite().min(0).nullable(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ImageRefSchema = z.string().max(256).regex(/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/);
export const SandboxPolicySchema = z.strictObject({
  backend: z.literal("docker"),
  image: ImageRefSchema.nullable(),
  network: z.literal("none"),
  cpus: z.number().finite().min(0.25).max(4),
  memoryMiB: z.number().int().min(64).max(8_192),
  pidsLimit: z.number().int().min(8).max(256),
  workspaceMiB: z.number().int().min(8).max(512),
  maxArtifactBytes: z.number().int().min(1).max(64 * 1_024 * 1_024),
  maxArtifactFiles: z.number().int().min(1).max(256),
  maxLogBytes: z.number().int().min(1_024).max(1_048_576),
});
export const RoomPolicySchema = z.strictObject({
  revision: RevisionSchema,
  maxConcurrentWorkers: z.number().int().min(1).max(8),
  maxNodes: z.number().int().min(1).max(32),
  maxDependenciesPerNode: z.number().int().min(0).max(16),
  runBudget: BudgetLimitsSchema,
  authoringBudget: BudgetLimitsSchema,
  sandbox: SandboxPolicySchema,
  hostActions: z.literal("approval_only"),
  attention: z.enum(["normal", "quiet"]),
});
export type RoomPolicy = z.infer<typeof RoomPolicySchema>;

export function defaultRoomPolicy(image: string | null = null): RoomPolicy {
  return RoomPolicySchema.parse({
    revision: 1, maxConcurrentWorkers: 2, maxNodes: 12, maxDependenciesPerNode: 8,
    runBudget: { maxSteps: 24, maxModelCalls: 12, maxTokens: 24_000, maxOutputTokensPerCall: 2_048, maxWallTimeMs: 900_000, estimatedUsdLimit: null },
    authoringBudget: { maxSteps: 4, maxModelCalls: 3, maxTokens: 6_000, maxOutputTokensPerCall: 2_048, maxWallTimeMs: 60_000, estimatedUsdLimit: null },
    sandbox: { backend: "docker", image, network: "none", cpus: 1, memoryMiB: 512, pidsLimit: 64,
      workspaceMiB: 128, maxArtifactBytes: 8_388_608, maxArtifactFiles: 128, maxLogBytes: 65_536 },
    hostActions: "approval_only", attention: "normal",
  });
}

export const RoomSchema = z.strictObject({
  version: z.literal(HARNESS_VERSION), id: IdSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2_000),
  status: z.enum(["active", "paused", "archived"]),
  revision: RevisionSchema, policy: RoomPolicySchema,
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
});
export type Room = z.infer<typeof RoomSchema>;

export const PlanNodeSchema = z.strictObject({
  id: IdSchema, title: z.string().trim().min(1).max(120),
  role: z.enum(["builder", "researcher", "reviewer", "tester"]),
  instructions: TextSchema,
  dependencies: z.array(IdSchema).max(16),
  inputFrom: z.array(IdSchema).max(16),
  outputPaths: z.array(RelativePathSchema).min(1).max(32),
  limits: BudgetLimitsSchema,
});
export type PlanNode = z.infer<typeof PlanNodeSchema>;
export const PlanDraftSchema = z.strictObject({
  goal: TextSchema, nodes: z.array(PlanNodeSchema).min(1).max(32),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;
export const PlanSchema = z.strictObject({
  version: z.literal(HARNESS_VERSION), id: IdSchema, roomId: IdSchema,
  revision: RevisionSchema, policyRevision: RevisionSchema,
  status: z.enum(["draft", "accepted"]), digest: DigestSchema.nullable(),
  goal: TextSchema, nodes: z.array(PlanNodeSchema).min(1).max(32),
  createdAt: TimestampSchema, acceptedAt: TimestampSchema.nullable(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const AttemptRefSchema = z.strictObject({
  roomId: IdSchema, runId: IdSchema, nodeId: IdSchema, attemptId: IdSchema,
});
export type AttemptRef = z.infer<typeof AttemptRefSchema>;
export const ArtifactRefSchema = z.strictObject({
  roomId: IdSchema, runId: IdSchema, artifactId: IdSchema, digest: DigestSchema,
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export const ArtifactFileSchema = z.strictObject({
  path: RelativePathSchema, sha256: DigestSchema, bytes: CounterSchema,
  mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(100),
});
export const ArtifactManifestSchema = z.strictObject({
  version: z.literal(HARNESS_VERSION), id: IdSchema,
  roomId: IdSchema, runId: IdSchema, nodeId: IdSchema, attemptId: IdSchema,
  planDigest: DigestSchema, digest: DigestSchema, createdAt: TimestampSchema,
  files: z.array(ArtifactFileSchema).min(1).max(256),
  inputDigests: z.array(DigestSchema).max(32),
  verification: z.enum(["unverified", "passed", "failed"]),
  verificationSummary: z.string().max(2_000),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export const NodeStateSchema = z.strictObject({
  nodeId: IdSchema,
  status: z.enum(["queued", "running", "waiting_question", "completed", "failed", "blocked", "cancel_requested", "cancelled", "interrupted"]),
  attemptId: IdSchema.nullable(), attemptNumber: CounterSchema,
  startedAt: TimestampSchema.nullable(), finishedAt: TimestampSchema.nullable(),
  operation: z.string().max(500).nullable(),
  artifactIds: z.array(IdSchema).max(256), usage: UsageSchema,
  error: z.string().max(2_000).nullable(),
});
export const RunSchema = z.strictObject({
  version: z.literal(HARNESS_VERSION), id: IdSchema, roomId: IdSchema,
  planId: IdSchema, planRevision: RevisionSchema, planDigest: DigestSchema,
  policy: RoomPolicySchema, revision: RevisionSchema,
  status: z.enum(["queued", "running", "waiting_question", "paused", "completed", "failed", "cancel_requested", "cancelled", "interrupted"]),
  nodes: z.array(NodeStateSchema).min(1).max(32), usage: UsageSchema,
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
  cancelConfirmed: z.boolean(),
});
export type Run = z.infer<typeof RunSchema>;
export type NodeState = z.infer<typeof NodeStateSchema>;

export const AuthoringSchema = z.strictObject({
  id: IdSchema, roomId: IdSchema, requestId: IdSchema, revision: RevisionSchema,
  policyRevision: RevisionSchema, goal: TextSchema,
  status: z.enum(["authoring", "waiting_question", "completed", "failed", "cancelled", "interrupted"]),
  planId: IdSchema.nullable(), usage: UsageSchema,
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
  error: z.string().max(2_000).nullable(),
});
export type Authoring = z.infer<typeof AuthoringSchema>;
