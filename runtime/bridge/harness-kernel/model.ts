import { z } from "zod";
import { AttemptRefSchema, CounterSchema, IdSchema, RoomPolicySchema, RoomSchema, UsageSchema, type Usage } from "../harness-contracts/domain.ts";
import { AnswerQuestionRequestSchema } from "../harness-contracts/interactions.ts";
import { AuthoringCheckpointSchema, HarnessEventSchema, HarnessStateSchema } from "../harness-contracts/service.ts";
import { WorkerCheckpointSchema, WorkerResultSchema, WorkerSpecSchema } from "../harness-contracts/worker.ts";

export const zeroUsage = (): Usage => ({ steps: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0,
  reservedTokens: 0, accounting: "measured", estimatedUsd: null });

export function addUsage(a: Usage, b: Usage): Usage {
  return { steps: a.steps + b.steps, modelCalls: a.modelCalls + b.modelCalls,
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    reservedTokens: a.reservedTokens + b.reservedTokens,
    accounting: a.accounting === "unknown" || b.accounting === "unknown" ? "unknown" :
      a.accounting === "partial" || b.accounting === "partial" ? "partial" : "measured",
    estimatedUsd: a.estimatedUsd === null || b.estimatedUsd === null ? null : a.estimatedUsd + b.estimatedUsd };
}

export const AttemptSchema = z.strictObject({
  ref: AttemptRefSchema, spec: WorkerSpecSchema,
  phase: z.enum(["intent", "active", "settled", "uncertain"]), stopped: z.boolean(),
  nextSequence: CounterSchema, resourceId: z.string().max(256).nullable(),
  baseUsage: UsageSchema, usage: UsageSchema,
  startedMs: CounterSchema, elapsedMs: CounterSchema, wallReservationMs: CounterSchema,
  stopReason: z.string().max(2_000).nullable(), result: WorkerResultSchema.nullable(),
});
export type Attempt = z.infer<typeof AttemptSchema>;
export const NodeLedgerSchema = z.strictObject({
  runId: IdSchema, nodeId: IdSchema, baseUsage: UsageSchema,
  checkpoint: WorkerCheckpointSchema.nullable(), answer: AnswerQuestionRequestSchema.nullable(),
});
export type NodeLedger = z.infer<typeof NodeLedgerSchema>;
export const AuthorJobSchema = z.strictObject({
  authoringId: IdSchema, room: RoomSchema, generation: CounterSchema,
  checkpoint: AuthoringCheckpointSchema.nullable(), answer: AnswerQuestionRequestSchema.nullable(),
  activeMs: CounterSchema, startedMs: CounterSchema,
});
export type AuthorJob = z.infer<typeof AuthorJobSchema>;
export const DatabaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: HarnessStateSchema,
  events: z.array(HarnessEventSchema).max(1_000),
  attempts: z.array(AttemptSchema).max(10_000),
  ledgers: z.array(NodeLedgerSchema).max(10_000),
  authorJobs: z.array(AuthorJobSchema).max(1_000),
  planPolicies: z.array(z.strictObject({ planId: IdSchema, policy: RoomPolicySchema })).max(1_000),
  requests: z.array(z.strictObject({ key: z.string().max(400), digest: z.string().length(64), entityId: IdSchema })).max(10_000),
  cancelledRuns: z.array(IdSchema).max(1_000),
  lastRoomId: IdSchema.nullable(), lastRunId: IdSchema.nullable(),
});
export type Database = z.infer<typeof DatabaseSchema>;

export function boundedDatabase(input: unknown): Database {
  const db = DatabaseSchema.parse(input);
  if (db.state.rooms.length > 100 || db.state.plans.length > 1_000 || db.state.runs.length > 1_000 ||
      db.state.authorings.length > 1_000 || db.state.questions.length > 5_000 || db.state.artifacts.length > 10_000) {
    throw new Error("Harness history limit reached; archive/export data before creating more work");
  }
  return db;
}
