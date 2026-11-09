import { z } from "zod";
import {
  ArtifactManifestSchema, AuthoringSchema, CounterSchema, IdSchema, PlanDraftSchema, PlanSchema,
  RevisionSchema, RoomPolicySchema, RoomSchema, RunSchema, TextSchema, TimestampSchema,
  type ArtifactManifest, type Authoring, type Plan, type PlanDraft, type Room, type RoomPolicy, type Run, type Usage,
} from "./domain.ts";
import {
  HarnessApprovalSchema, QuestionSchema, type AnswerQuestionRequest, type Question, type QuestionPrompt, type VoiceAnswerRequest,
} from "./interactions.ts";
import { ContinuationSchema, type Continuation, type WorkerRunner } from "./worker.ts";
import type { RoomArchive, RoomArchiveSummary } from "../harness-kernel/archive.ts";

export const CreateRoomRequestSchema = z.strictObject({
  requestId: IdSchema, title: z.string().trim().min(1).max(120), description: z.string().max(2_000), policy: RoomPolicySchema,
});
export const UpdateRoomRequestSchema = z.strictObject({
  expectedRevision: RevisionSchema, title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(), status: z.enum(["active", "paused", "archived"]).optional(),
  policy: RoomPolicySchema.optional(),
});
export const AuthorPlanRequestSchema = z.strictObject({ requestId: IdSchema, expectedRoomRevision: RevisionSchema, goal: TextSchema });
export const UpdatePlanRequestSchema = z.strictObject({ expectedRevision: RevisionSchema, draft: PlanDraftSchema });
export const AcceptPlanRequestSchema = z.strictObject({ expectedRevision: RevisionSchema });
export const StartRunRequestSchema = z.strictObject({ requestId: IdSchema, planId: IdSchema, expectedPlanRevision: RevisionSchema, planDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export const RunControlRequestSchema = z.strictObject({ expectedRevision: RevisionSchema });
export const RetryNodeRequestSchema = z.strictObject({ expectedRevision: RevisionSchema, previousAttemptId: IdSchema });
export const HarnessStateSchema = z.strictObject({
  version: z.literal(1), sequence: CounterSchema, ready: z.boolean(),
  defaultPolicy: RoomPolicySchema,
  worker: z.strictObject({ available: z.boolean(), reason: z.string().max(2_000).nullable() }),
  rooms: z.array(RoomSchema), plans: z.array(PlanSchema), authorings: z.array(AuthoringSchema),
  runs: z.array(RunSchema), questions: z.array(QuestionSchema),
  approvals: z.array(HarnessApprovalSchema), artifacts: z.array(ArtifactManifestSchema),
});
export type HarnessState = z.infer<typeof HarnessStateSchema>;
export const HarnessEventSchema = z.strictObject({
  version: z.literal(1), sequence: CounterSchema, at: TimestampSchema,
  roomId: IdSchema, runId: IdSchema.nullable(), entityId: IdSchema, revision: RevisionSchema,
  type: z.enum(["room.updated", "plan.updated", "authoring.updated", "run.updated", "question.updated", "artifact.created", "approval.updated"]),
});
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export const HarnessEventsSchema = z.strictObject({
  version: z.literal(1), events: z.array(HarnessEventSchema).max(1_000), nextSequence: CounterSchema, resetRequired: z.boolean(),
});
export type HarnessEvents = z.infer<typeof HarnessEventsSchema>;

export const AuthoringCheckpointSchema = z.strictObject({ version: z.literal(1), continuation: ContinuationSchema });
export type AuthoringCheckpoint = z.infer<typeof AuthoringCheckpointSchema>;
export interface AuthoringInput {
  room: Room;
  authoring: Authoring;
  checkpoint: AuthoringCheckpoint | null;
  answer: AnswerQuestionRequest | null;
}
export type AuthoringResult =
  | { status: "completed"; draft: PlanDraft; usage: Usage }
  | { status: "waiting_question"; question: QuestionPrompt; checkpoint: AuthoringCheckpoint; usage: Usage }
  | { status: "failed"; error: string; usage: Usage };
export interface PlanAuthor {
  author(input: AuthoringInput, context: { signal: AbortSignal }): Promise<AuthoringResult>;
}
export interface AuthorModel {
  complete(input: { system: string; prompt: string; maxOutputTokens: number; signal: AbortSignal }): Promise<{
    text: string; inputTokens: number | null; outputTokens: number | null;
  }>;
}
export interface PlanAuthorOptions { model: string; modelClient?: AuthorModel; fetch?: typeof fetch }

export interface QuestionRouter {
  attention(): Promise<Question[]>;
  answerVoice(input: VoiceAnswerRequest): Promise<Question>;
}
export interface QuestionRouterOptions {
  harness: Pick<HarnessService, "state" | "answerQuestion">;
  now?: () => Date;
}

export interface HarnessKernelOptions {
  dataDirectory: string;
  worker: WorkerRunner;
  author: PlanAuthor;
  maxActiveWorkers?: number;
  defaultPolicy?: RoomPolicy;
  now?: () => Date;
  createId?: () => string;
}

export interface HarnessService {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  state(): Promise<HarnessState>;
  events(after: number, roomId?: string): Promise<HarnessEvents>;
  createRoom(input: z.infer<typeof CreateRoomRequestSchema>): Promise<Room>;
  updateRoom(roomId: string, input: z.infer<typeof UpdateRoomRequestSchema>): Promise<Room>;
  authorPlan(roomId: string, input: z.infer<typeof AuthorPlanRequestSchema>): Promise<Authoring>;
  cancelAuthoring(roomId: string, authoringId: string, input: z.infer<typeof RunControlRequestSchema>): Promise<Authoring>;
  updatePlan(roomId: string, planId: string, input: z.infer<typeof UpdatePlanRequestSchema>): Promise<Plan>;
  acceptPlan(roomId: string, planId: string, input: z.infer<typeof AcceptPlanRequestSchema>): Promise<Plan>;
  startRun(roomId: string, input: z.infer<typeof StartRunRequestSchema>): Promise<Run>;
  pauseRun(roomId: string, runId: string, input: z.infer<typeof RunControlRequestSchema>): Promise<Run>;
  resumeRun(roomId: string, runId: string, input: z.infer<typeof RunControlRequestSchema>): Promise<Run>;
  cancelRun(roomId: string, runId: string, input: z.infer<typeof RunControlRequestSchema>): Promise<Run>;
  retryNode(roomId: string, runId: string, nodeId: string, input: z.infer<typeof RetryNodeRequestSchema>): Promise<Run>;
  answerQuestion(input: AnswerQuestionRequest): Promise<Question>;
  artifact(roomId: string, runId: string, artifactId: string): Promise<ArtifactManifest>;
  archiveRoom?(roomId: string, expectedRevision: number): Promise<RoomArchiveSummary>;
  listArchives?(roomId?: string): Promise<RoomArchiveSummary[]>;
  readArchive?(archiveId: string, roomId: string): Promise<RoomArchive>;
}

export interface WorkerRunnerOptions {
  dataDirectory: string;
  model: string;
  dockerBinary?: string;
  pythonBinary?: string;
  fetch?: typeof fetch;
}

export const HARNESS_ROUTES = {
  state: "/v1/harness/state", events: "/v1/harness/events", rooms: "/v1/harness/rooms",
  room: "/v1/harness/rooms/:roomId",
  author: "/v1/harness/rooms/:roomId/author",
  cancelAuthoring: "/v1/harness/rooms/:roomId/authorings/:authoringId/cancel",
  plan: "/v1/harness/rooms/:roomId/plans/:planId",
  acceptPlan: "/v1/harness/rooms/:roomId/plans/:planId/accept",
  runs: "/v1/harness/rooms/:roomId/runs",
  controlRun: "/v1/harness/rooms/:roomId/runs/:runId/:action",
  retryNode: "/v1/harness/rooms/:roomId/runs/:runId/nodes/:nodeId/retry",
  answerQuestion: "/v1/harness/questions/:questionId/answer",
  answerVoice: "/v1/harness/questions/:questionId/voice-answer",
  artifact: "/v1/harness/rooms/:roomId/runs/:runId/artifacts/:artifactId/content",
} as const;

export type { Continuation, RoomPolicy };
