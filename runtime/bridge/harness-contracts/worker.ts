import { z } from "zod";
import {
  ArtifactManifestSchema, ArtifactRefSchema, AttemptRefSchema, CounterSchema, DigestSchema,
  PlanNodeSchema, RelativePathSchema, RoomPolicySchema, TimestampSchema, UsageSchema,
  type ArtifactRef, type AttemptRef, type ArtifactManifest,
} from "./domain.ts";
import { AnswerQuestionRequestSchema, QuestionPromptSchema } from "./interactions.ts";

export const ContinuationSchema = z.strictObject({
  version: z.literal(1),
  summary: z.string().max(8_000),
  history: z.array(z.strictObject({ role: z.enum(["user", "assistant", "tool"]), content: z.string().max(8_000) })).max(64),
  completedStepIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,96}$/)).max(100),
  usage: UsageSchema,
});
export type Continuation = z.infer<typeof ContinuationSchema>;
export const WorkerCheckpointSchema = z.strictObject({
  version: z.literal(1), ref: AttemptRefSchema,
  sequence: CounterSchema, createdAt: TimestampSchema,
  resumeMode: z.literal("continue_after_answer"),
  continuation: ContinuationSchema,
  artifacts: z.array(ArtifactManifestSchema).max(32),
  question: QuestionPromptSchema,
});
export type WorkerCheckpoint = z.infer<typeof WorkerCheckpointSchema>;
export const WorkerSpecSchema = z.strictObject({
  version: z.literal(1), ref: AttemptRefSchema, planDigest: DigestSchema,
  node: PlanNodeSchema, policy: RoomPolicySchema,
  inputs: z.array(ArtifactManifestSchema).max(32),
  checkpoint: WorkerCheckpointSchema.nullable(),
  answer: AnswerQuestionRequestSchema.nullable(),
}).superRefine((spec, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (spec.node.id !== spec.ref.nodeId) fail("Worker node binding mismatch");
  if ((spec.checkpoint === null) !== (spec.answer === null)) fail("Checkpoint and answer must be supplied together");
  if (spec.inputs.some((artifact) => artifact.roomId !== spec.ref.roomId || artifact.runId !== spec.ref.runId ||
    artifact.planDigest !== spec.planDigest || !spec.node.inputFrom.includes(artifact.nodeId))) fail("Unscoped artifact input");
  if (spec.checkpoint && spec.answer) {
    const old = spec.checkpoint.ref;
    const target = spec.answer.binding.target;
    if (old.roomId !== spec.ref.roomId || old.runId !== spec.ref.runId || old.nodeId !== spec.ref.nodeId || old.attemptId === spec.ref.attemptId) fail("Resume must use a new attempt in the same node");
    if (target.scope !== "node" || target.roomId !== old.roomId || target.runId !== old.runId || target.nodeId !== old.nodeId || target.attemptId !== old.attemptId) fail("Resume answer is not bound to the checkpoint attempt");
    if (spec.checkpoint.artifacts.some((artifact) => artifact.roomId !== old.roomId || artifact.runId !== old.runId || artifact.nodeId !== old.nodeId || artifact.planDigest !== spec.planDigest)) fail("Unscoped checkpoint artifact");
  }
});
export type WorkerSpec = z.infer<typeof WorkerSpecSchema>;

export const WorkerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), ref: AttemptRefSchema, sequence: CounterSchema, at: TimestampSchema, resourceId: z.string().min(1).max(256) }),
  z.strictObject({ type: z.literal("progress"), ref: AttemptRefSchema, sequence: CounterSchema, at: TimestampSchema, operation: z.string().max(500) }),
  z.strictObject({ type: z.literal("usage"), ref: AttemptRefSchema, sequence: CounterSchema, at: TimestampSchema, usage: UsageSchema }),
]);
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export const WorkerResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), ref: AttemptRefSchema, usage: UsageSchema, artifacts: z.array(ArtifactManifestSchema).min(1).max(32), summary: z.string().max(4_000) }),
  z.strictObject({ status: z.literal("waiting_question"), ref: AttemptRefSchema, usage: UsageSchema, checkpoint: WorkerCheckpointSchema }),
  z.strictObject({ status: z.literal("failed"), ref: AttemptRefSchema, usage: UsageSchema, error: z.string().max(2_000) }),
  z.strictObject({ status: z.literal("cancelled"), ref: AttemptRefSchema, usage: UsageSchema, confirmed: z.boolean() }),
  z.strictObject({ status: z.literal("interrupted"), ref: AttemptRefSchema, usage: UsageSchema, reason: z.string().max(2_000) }),
]);
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export const CancellationSchema = z.strictObject({ ref: AttemptRefSchema, confirmed: z.boolean(), reason: z.string().max(2_000).nullable() });
export type Cancellation = z.infer<typeof CancellationSchema>;
export type Reconciliation =
  | { state: "running"; ref: AttemptRef }
  | { state: "settled"; ref: AttemptRef; result: WorkerResult }
  | { state: "missing" | "unknown"; ref: AttemptRef; reason: string };

export interface WorkerContext {
  signal: AbortSignal;
  emit(event: WorkerEvent): Promise<void>;
}

export interface ArtifactReader {
  read(ref: ArtifactRef, path: string, maxBytes: number): Promise<{ manifest: ArtifactManifest; bytes: Uint8Array }>;
}

export interface WorkerRunner {
  readonly artifacts: ArtifactReader;
  availability(): Promise<{ available: boolean; reason: string | null }>;
  run(spec: WorkerSpec, context: WorkerContext): Promise<WorkerResult>;
  cancel(ref: AttemptRef): Promise<Cancellation>;
  reconcile(ref: AttemptRef): Promise<Reconciliation>;
}

export const ArtifactReadRequestSchema = z.strictObject({ ref: ArtifactRefSchema, path: RelativePathSchema });
