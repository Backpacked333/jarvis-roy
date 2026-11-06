import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "../errors.ts";
import {
  defaultRoomPolicy, IdSchema, PlanDraftSchema, RoomPolicySchema, UsageSchema,
  type ArtifactManifest, type AttemptRef, type Authoring, type BudgetLimits, type NodeState,
  type Plan, type Room, type Run, type Usage,
} from "../harness-contracts/domain.ts";
import {
  assertAnswerMatches, QuestionPromptSchema, type AnswerQuestionRequest, type Question,
  type QuestionPrompt, type QuestionTarget,
} from "../harness-contracts/interactions.ts";
import {
  AcceptPlanRequestSchema, AuthoringCheckpointSchema, AuthorPlanRequestSchema, CreateRoomRequestSchema,
  RetryNodeRequestSchema, RunControlRequestSchema, StartRunRequestSchema, UpdatePlanRequestSchema,
  UpdateRoomRequestSchema, type HarnessEvent, type HarnessKernelOptions, type HarnessService,
} from "../harness-contracts/service.ts";
import { acceptPlan, canonicalJson, sha256, validateArtifact, validatePlan } from "../harness-contracts/validation.ts";
import {
  CancellationSchema, WorkerEventSchema, WorkerResultSchema, WorkerSpecSchema,
  type WorkerEvent, type WorkerResult, type WorkerSpec,
} from "../harness-contracts/worker.ts";
import { addUsage, boundedDatabase, zeroUsage, type Attempt, type Database, type NodeLedger } from "./model.ts";
import { SqliteKernelStore, type KernelStore } from "./store.ts";
import { isSafeClarification, isSafeClarificationAnswer } from "../harness-interactions/clarification-safety.ts";

const AuthorResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), draft: PlanDraftSchema, usage: UsageSchema }),
  z.strictObject({ status: z.literal("waiting_question"), question: QuestionPromptSchema,
    checkpoint: AuthoringCheckpointSchema, usage: UsageSchema }),
  z.strictObject({ status: z.literal("failed"), error: z.string().max(2_000), usage: UsageSchema }),
]);
const active = (a: Attempt) => !a.stopped;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const conflict = (message: string): never => { throw new BridgeError(message, 409); };
const missing = (): never => { throw new BridgeError("Scoped harness resource not found", 404); };
const revision = (actual: number, expected: number) => {
  if (actual !== expected) conflict("Stale revision; refresh before changing this resource");
};
const copy = <T>(value: T): T => structuredClone(value);
const terminal = new Set<Run["status"]>(["completed", "failed", "cancelled"]);

async function bounded<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker control deadline exceeded")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export class HarnessKernel implements HarnessService {
  private db: Database;
  private readonly options: HarnessKernelOptions;
  private readonly store: KernelStore;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly maximum: number;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  private failure: string | null = null;
  private pumping = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly workers = new Map<string, { controller: AbortController; timer: NodeJS.Timeout }>();
  private readonly authors = new Map<string, { controller: AbortController; timer: NodeJS.Timeout; generation: number }>();

  constructor(options: HarnessKernelOptions, store: KernelStore = new SqliteKernelStore(options.dataDirectory)) {
    this.options = options;
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.createId ?? randomUUID;
    this.maximum = options.maxActiveWorkers ?? 2;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 32) throw new Error("Invalid global worker limit");
    this.db = { schemaVersion: 1, state: { version: 1, sequence: 0, ready: false,
      defaultPolicy: RoomPolicySchema.parse(options.defaultPolicy ?? defaultRoomPolicy()),
      worker: { available: false, reason: "Kernel has not initialized" }, rooms: [], plans: [], authorings: [],
      runs: [], questions: [], approvals: [], artifacts: [] }, events: [], attempts: [], ledgers: [],
      authorJobs: [], planPolicies: [], requests: [], cancelledRuns: [], lastRoomId: null, lastRunId: null };
  }

  initialize(): Promise<void> {
    if (this.closed || this.closing) return Promise.reject(new Error("Kernel is shut down"));
    if (this.initialized) return Promise.resolve();
    this.initializing ??= this.initializeOnce();
    return this.initializing;
  }

  private async initializeOnce(): Promise<void> {
    try {
      const unloaded = this.db;
      this.db = await this.store.open(this.db);
      try { this.validateLoaded(); }
      catch (error) {
        this.db = unloaded;
        throw error;
      }
      this.commit((db) => {
        db.state.ready = false;
        db.state.defaultPolicy = RoomPolicySchema.parse(this.options.defaultPolicy ?? defaultRoomPolicy());
        for (const author of db.state.authorings) {
          if (author.status !== "authoring") continue;
          this.unknownAuthorUsage(db, author);
          author.status = "interrupted";
          author.error = "Authoring was interrupted by restart; submit a new goal to retry";
          this.touchAuthor(db, author);
        }
      });
      for (const attempt of this.db.attempts.filter(active)) await this.reconcile(attempt.ref);
      const availability = await bounded(this.options.worker.availability()).catch(() => ({ available: false, reason: "Worker availability could not be verified" }));
      this.commit((db) => {
        db.state.worker = { available: availability.available === true,
          reason: typeof availability.reason === "string" ? availability.reason.slice(0, 2_000) : null };
        db.state.ready = true;
        this.expireQuestions(db);
      });
      this.initialized = true;
      this.kick();
    } catch (error) {
      this.failure = "Kernel initialization failed; no work was dispatched";
      this.store.close();
      throw error;
    }
  }

  async state() {
    if (this.initialized && !this.closed && !this.failure && this.db.state.questions.some((q) => q.status === "pending" &&
        Date.parse(q.expiresAt) <= this.milliseconds())) {
      this.commit((db) => this.expireQuestions(db));
      this.kick();
    }
    const state = copy(this.db.state);
    state.ready = this.initialized && !this.closing && !this.failure;
    if (this.failure) state.worker = { available: false, reason: this.failure };
    return state;
  }

  async events(after: number, roomId?: string) {
    this.requireReady();
    if (!Number.isSafeInteger(after) || after < 0) throw new BridgeError("Invalid event cursor", 400);
    if (roomId !== undefined) this.room(this.db, IdSchema.parse(roomId));
    const first = this.db.events[0]?.sequence ?? this.db.state.sequence + 1;
    return { version: 1 as const, events: copy(this.db.events.filter((event) => event.sequence > after &&
      (roomId === undefined || event.roomId === roomId))), nextSequence: this.db.state.sequence,
    resetRequired: after < first - 1 || after > this.db.state.sequence };
  }

  async createRoom(input: z.infer<typeof CreateRoomRequestSchema>): Promise<Room> {
    this.requireReady();
    const request = CreateRoomRequestSchema.parse(input);
    return this.commit((db) => {
      const key = `room:${request.requestId}`;
      const previous = this.request(db, key, request);
      if (previous) return this.room(db, previous);
      const at = this.timestamp();
      const room: Room = { version: 1, id: this.id(db), title: request.title, description: request.description,
        status: "active", revision: 1, policy: { ...request.policy, revision: 1 }, createdAt: at, updatedAt: at };
      db.state.rooms.push(room);
      this.recordRequest(db, key, request, room.id);
      this.event(db, "room.updated", room.id, null, room.id, room.revision);
      return room;
    });
  }

  async updateRoom(roomId: string, input: z.infer<typeof UpdateRoomRequestSchema>): Promise<Room> {
    this.requireReady();
    const request = UpdateRoomRequestSchema.parse(input);
    const room = this.commit((db) => {
      const room = this.room(db, roomId);
      revision(room.revision, request.expectedRevision);
      if (request.title !== undefined) room.title = request.title;
      if (request.description !== undefined) room.description = request.description;
      if (request.status !== undefined) room.status = request.status;
      if (request.policy !== undefined) {
        revision(room.policy.revision, request.policy.revision);
        room.policy = { ...request.policy, revision: room.policy.revision + 1 };
      }
      room.revision++;
      room.updatedAt = this.timestamp();
      this.event(db, "room.updated", roomId, null, roomId, room.revision);
      return room;
    });
    this.kick();
    return room;
  }

  async authorPlan(roomId: string, input: z.infer<typeof AuthorPlanRequestSchema>): Promise<Authoring> {
    this.requireReady();
    const request = AuthorPlanRequestSchema.parse(input);
    const result = this.commit((db) => {
      const room = this.room(db, roomId);
      const key = `author:${roomId}:${request.requestId}`;
      const previous = this.request(db, key, request);
      if (previous) return { author: this.author(db, roomId, previous), launch: false };
      revision(room.revision, request.expectedRoomRevision);
      if (room.status !== "active") conflict("Room is not active");
      if (db.state.authorings.filter((a) => a.status === "authoring").length >= this.maximum ||
          db.state.authorings.some((a) => a.roomId === roomId && a.status === "authoring")) conflict("Authoring concurrency limit reached");
      const at = this.timestamp();
      const author: Authoring = { id: this.id(db), roomId, requestId: request.requestId, revision: 1,
        policyRevision: room.policy.revision, goal: request.goal, status: "authoring", planId: null,
        usage: zeroUsage(), createdAt: at, updatedAt: at, error: null };
      db.state.authorings.push(author);
      db.authorJobs.push({ authoringId: author.id, room: copy(room), generation: 1,
        checkpoint: null, answer: null, activeMs: 0, startedMs: this.milliseconds() });
      this.recordRequest(db, key, request, author.id);
      this.event(db, "authoring.updated", roomId, null, author.id, author.revision);
      return { author, launch: true };
    });
    if (result.launch) this.launchAuthor(result.author.id);
    return result.author;
  }

  async cancelAuthoring(roomId: string, authoringId: string, input: z.infer<typeof RunControlRequestSchema>) {
    this.requireReady();
    const request = RunControlRequestSchema.parse(input);
    const author = this.commit((db) => {
      const author = this.author(db, roomId, authoringId);
      revision(author.revision, request.expectedRevision);
      if (!["authoring", "waiting_question"].includes(author.status)) conflict("Authoring is already settled");
      if (author.status === "authoring") this.unknownAuthorUsage(db, author);
      author.status = "cancelled";
      this.cancelQuestions(db, (q) => q.target.scope === "authoring" && q.target.authoringId === authoringId);
      this.touchAuthor(db, author);
      return author;
    });
    this.authors.get(authoringId)?.controller.abort();
    this.clearAuthor(authoringId);
    return author;
  }

  async updatePlan(roomId: string, planId: string, input: z.infer<typeof UpdatePlanRequestSchema>) {
    this.requireReady();
    const request = UpdatePlanRequestSchema.parse(input);
    return this.commit((db) => {
      const room = this.room(db, roomId);
      const plan = this.plan(db, roomId, planId);
      revision(plan.revision, request.expectedRevision);
      if (plan.status !== "draft") conflict("Accepted plans are immutable; author a new plan");
      const changed = this.checkedPlan({ ...plan, ...request.draft, revision: plan.revision + 1,
        policyRevision: room.policy.revision }, room.policy);
      Object.assign(plan, changed);
      db.planPolicies.find((p) => p.planId === planId)!.policy = copy(room.policy);
      this.event(db, "plan.updated", roomId, null, planId, plan.revision);
      return plan;
    });
  }

  async acceptPlan(roomId: string, planId: string, input: z.infer<typeof AcceptPlanRequestSchema>) {
    this.requireReady();
    const request = AcceptPlanRequestSchema.parse(input);
    return this.commit((db) => {
      const room = this.room(db, roomId);
      const plan = this.plan(db, roomId, planId);
      revision(plan.revision, request.expectedRevision);
      this.checkedPlan(plan, room.policy);
      if (plan.status === "accepted") return plan;
      Object.assign(plan, acceptPlan(plan, room.policy, this.now()));
      this.event(db, "plan.updated", roomId, null, planId, plan.revision);
      return plan;
    });
  }

  async startRun(roomId: string, input: z.infer<typeof StartRunRequestSchema>): Promise<Run> {
    this.requireReady();
    const request = StartRunRequestSchema.parse(input);
    const result = this.commit((db) => {
      const room = this.room(db, roomId);
      const key = `run:${roomId}:${request.requestId}`;
      const previous = this.request(db, key, request);
      if (previous) return this.run(db, roomId, previous);
      if (room.status !== "active") conflict("Room is not active");
      const plan = this.plan(db, roomId, request.planId);
      revision(plan.revision, request.expectedPlanRevision);
      this.checkedPlan(plan, room.policy);
      if (plan.status !== "accepted" || plan.digest !== request.planDigest) conflict("Run requires the exact accepted plan digest");
      if (!db.state.worker.available || room.policy.sandbox.image === null) conflict("An available, explicitly pinned isolated worker is required");
      const at = this.timestamp();
      const run: Run = { version: 1, id: this.id(db), roomId, planId: plan.id, planRevision: plan.revision,
        planDigest: plan.digest!, policy: copy(room.policy), revision: 1, status: "queued", nodes: plan.nodes.map((node) => ({
          nodeId: node.id, status: "queued", attemptId: null, attemptNumber: 0, startedAt: null,
          finishedAt: null, operation: null, artifactIds: [], usage: { ...zeroUsage(), reservedTokens: node.limits.maxTokens }, error: null,
        })), usage: zeroUsage(), createdAt: at, updatedAt: at, cancelConfirmed: false };
      run.usage = run.nodes.reduce((sum, node) => addUsage(sum, node.usage), zeroUsage());
      db.state.runs.push(run);
      for (const node of run.nodes) db.ledgers.push({ runId: run.id, nodeId: node.nodeId,
        baseUsage: zeroUsage(), checkpoint: null, answer: null });
      this.recordRequest(db, key, request, run.id);
      this.event(db, "run.updated", roomId, run.id, run.id, run.revision);
      return run;
    });
    this.kick();
    return result;
  }

  async pauseRun(roomId: string, runId: string, input: z.infer<typeof RunControlRequestSchema>) {
    this.requireReady();
    const request = RunControlRequestSchema.parse(input);
    return this.commit((db) => {
      const run = this.run(db, roomId, runId);
      revision(run.revision, request.expectedRevision);
      if (terminal.has(run.status) || db.cancelledRuns.includes(runId)) conflict("Run cannot be paused");
      run.status = "paused";
      this.touchRun(db, run);
      return run;
    });
  }

  async resumeRun(roomId: string, runId: string, input: z.infer<typeof RunControlRequestSchema>) {
    this.requireReady();
    const request = RunControlRequestSchema.parse(input);
    const result = this.commit((db) => {
      const run = this.run(db, roomId, runId);
      revision(run.revision, request.expectedRevision);
      if (run.status !== "paused" || db.cancelledRuns.includes(runId)) conflict("Only a paused run can resume");
      if (this.room(db, roomId).status !== "active") conflict("Room is not active");
      run.status = "queued";
      this.touchRun(db, run);
      return run;
    });
    this.kick();
    return result;
  }

  async cancelRun(roomId: string, runId: string, input: z.infer<typeof RunControlRequestSchema>): Promise<Run> {
    this.requireReady();
    const request = RunControlRequestSchema.parse(input);
    const result = this.commit((db) => {
      const run = this.run(db, roomId, runId);
      revision(run.revision, request.expectedRevision);
      if (run.status === "completed" || run.status === "cancelled") conflict("Run is already settled");
      if (!db.cancelledRuns.includes(runId)) db.cancelledRuns.push(runId);
      run.status = "cancel_requested";
      for (const node of run.nodes) {
        if (["completed", "failed", "blocked", "cancelled"].includes(node.status)) continue;
        const attempt = this.currentAttempt(db, node);
        if (attempt && !attempt.stopped) {
          attempt.stopReason = "Cancellation requested";
          node.status = "cancel_requested";
        } else { node.status = "cancelled"; node.finishedAt = this.timestamp(); node.usage.reservedTokens = node.usage.accounting === "measured" ? 0 : node.usage.reservedTokens; }
      }
      this.cancelQuestions(db, (q) => q.target.scope === "node" && q.target.runId === runId);
      this.touchRun(db, run);
      return run;
    });
    for (const attempt of this.db.attempts.filter((a) => a.ref.runId === runId && active(a))) void this.stopAttempt(attempt.ref);
    return result;
  }

  async retryNode(roomId: string, runId: string, nodeId: string, input: z.infer<typeof RetryNodeRequestSchema>) {
    this.requireReady();
    const request = RetryNodeRequestSchema.parse(input);
    const existing = this.run(this.db, roomId, runId);
    revision(existing.revision, request.expectedRevision);
    const previous = existing.nodes.find((node) => node.nodeId === nodeId) ?? missing();
    if (previous.attemptId !== request.previousAttemptId) conflict("Retry names an obsolete attempt");
    if (!["failed", "interrupted"].includes(previous.status) || this.db.cancelledRuns.includes(runId)) conflict("Node cannot be retried");
    if (this.currentAttempt(this.db, previous)?.stopped !== true) {
      await this.stopAttempt({ roomId, runId, nodeId, attemptId: request.previousAttemptId }, "Explicit retry requires confirmed stop");
      conflict("Stop reconciliation changed the run; refresh and explicitly retry again");
    }
    const result = this.commit((db) => {
      const run = this.run(db, roomId, runId);
      revision(run.revision, request.expectedRevision);
      const node = run.nodes.find((node) => node.nodeId === nodeId) ?? missing();
      if (node.attemptId !== request.previousAttemptId || !["failed", "interrupted"].includes(node.status) || db.cancelledRuns.includes(runId)) conflict("Node cannot be retried");
      if (node.usage.accounting !== "measured") conflict("Unknown usage retains the full reservation; create a new explicitly budgeted run");
      const definition = this.plan(db, roomId, run.planId).nodes.find((n) => n.id === nodeId)!;
      const ledger = this.ledger(db, runId, nodeId);
      ledger.baseUsage = { ...node.usage, reservedTokens: 0 };
      ledger.checkpoint = null;
      ledger.answer = null;
      this.remainingLimits(db, run, node, ledger);
      node.status = "queued";
      node.error = null;
      node.finishedAt = null;
      node.usage.reservedTokens = Math.max(0, definition.limits.maxTokens - node.usage.inputTokens - node.usage.outputTokens);
      for (const dependent of run.nodes) if (dependent.status === "blocked") {
        dependent.status = "queued"; dependent.error = null; dependent.finishedAt = null;
        const limit = this.plan(db, roomId, run.planId).nodes.find((n) => n.id === dependent.nodeId)!.limits.maxTokens;
        dependent.usage.reservedTokens = Math.max(0, limit - dependent.usage.inputTokens - dependent.usage.outputTokens);
      }
      if (run.status !== "paused") run.status = "queued";
      this.touchRun(db, run);
      return run;
    });
    this.kick();
    return result;
  }

  async answerQuestion(input: AnswerQuestionRequest): Promise<Question> {
    this.requireReady();
    let authorId: string | null = null;
    const result = this.commit((db) => {
      const question = db.state.questions.find((q) => q.id === input?.binding?.questionId) ?? missing();
      let answer: AnswerQuestionRequest;
      try { answer = assertAnswerMatches(question, input, this.now()); }
      catch (error) {
        if (error instanceof z.ZodError) throw error;
        throw new BridgeError(error instanceof Error ? error.message : "Question binding conflict", 409);
      }
      if (!isSafeClarification(question.question) || !isSafeClarificationAnswer(answer)) {
        throw new BridgeError("Sensitive information cannot be requested or supplied through clarifications", 400);
      }
      const target = question.target;
      const room = this.room(db, target.roomId);
      if (room.status === "archived") conflict("Archived room cannot resume work");
      if (target.scope === "node") {
        const run = this.run(db, room.id, target.runId);
        const node = run.nodes.find((n) => n.nodeId === target.nodeId) ?? missing();
        const attempt = this.currentAttempt(db, node) ?? missing();
        if (node.status !== "waiting_question" || node.attemptId !== target.attemptId || !attempt.stopped ||
            db.cancelledRuns.includes(run.id)) conflict("Question no longer belongs to a suspended node");
        if (attempt.result?.status !== "waiting_question") throw new BridgeError("Missing stopped checkpoint", 409);
        if (node.usage.accounting !== "measured") conflict("Cannot resume with unknown usage");
        const ledger = this.ledger(db, run.id, node.nodeId);
        ledger.checkpoint = copy(attempt.result.checkpoint);
        ledger.answer = answer;
        ledger.baseUsage = copy(attempt.result.usage);
        this.remainingLimits(db, run, node, ledger);
        node.status = "queued";
        node.finishedAt = null;
        if (run.status !== "paused") run.status = "queued";
        this.touchRun(db, run);
      } else {
        const author = this.author(db, room.id, target.authoringId);
        const job = db.authorJobs.find((job) => job.authoringId === author.id)!;
        if (author.status !== "waiting_question" || !job.checkpoint) conflict("Authoring question is no longer resumable");
        if (author.usage.accounting !== "measured" || room.policy.revision !== job.room.policy.revision) conflict("Authoring budget or policy changed; submit a new goal");
        if (db.state.authorings.filter((a) => a.status === "authoring").length >= this.maximum) conflict("Authoring concurrency limit reached");
        this.checkUsage(author.usage, job.room.policy.authoringBudget, zeroUsage());
        if (author.usage.modelCalls >= job.room.policy.authoringBudget.maxModelCalls ||
            author.usage.inputTokens + author.usage.outputTokens >= job.room.policy.authoringBudget.maxTokens ||
            job.activeMs >= job.room.policy.authoringBudget.maxWallTimeMs) conflict("Authoring budget exhausted");
        job.answer = answer;
        job.generation++;
        job.startedMs = this.milliseconds();
        author.status = "authoring";
        this.touchAuthor(db, author);
        authorId = author.id;
      }
      question.status = "answered";
      question.revision++;
      question.answer = { text: answer.text, choiceId: answer.choiceId, answeredAt: this.timestamp() };
      this.questionEvent(db, question);
      return question;
    });
    if (authorId !== null) this.launchAuthor(authorId);
    this.kick();
    return result;
  }

  async artifact(roomId: string, runId: string, artifactId: string): Promise<ArtifactManifest> {
    this.requireReady();
    this.run(this.db, roomId, runId);
    const artifact = this.db.state.artifacts.find((a) => a.roomId === roomId && a.runId === runId && a.id === artifactId) ?? missing();
    return copy(artifact);
  }

  private launchAuthor(authoringId: string): void {
    if (this.closed || this.closing || this.failure) return;
    const author = this.db.state.authorings.find((a) => a.id === authoringId)!;
    const job = this.db.authorJobs.find((job) => job.authoringId === authoringId)!;
    const generation = job.generation;
    if (this.authors.get(authoringId)?.generation === generation) return;
    this.clearAuthor(authoringId);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      this.authorFailure(authoringId, generation, "Authoring wall-time budget exhausted");
      this.clearAuthor(authoringId, generation);
    }, Math.max(1, job.room.policy.authoringBudget.maxWallTimeMs - job.activeMs));
    timer.unref();
    this.authors.set(authoringId, { controller, timer, generation });
    const input = copy({ room: job.room, authoring: author, checkpoint: job.checkpoint, answer: job.answer });
    void Promise.resolve().then(() => this.options.author.author(input, { signal: controller.signal })).then((raw) => {
      if (this.closed || this.failure) return;
      this.commit((db) => {
        const author = db.state.authorings.find((a) => a.id === authoringId)!;
        const job = db.authorJobs.find((j) => j.authoringId === authoringId)!;
        if (author.status !== "authoring" || job.generation !== generation) return;
        const result = AuthorResultSchema.parse(raw);
        this.checkUsage(result.usage, job.room.policy.authoringBudget, author.usage);
        job.activeMs += Math.max(0, this.milliseconds() - job.startedMs);
        if (job.activeMs > job.room.policy.authoringBudget.maxWallTimeMs) throw new Error("Authoring wall-time budget exceeded");
        author.usage = result.usage;
        if (this.room(db, author.roomId).policy.revision !== job.room.policy.revision) throw new Error("Room policy changed during authoring; submit a new goal");
        if (result.status === "completed") {
          const plan = this.checkedPlan({ version: 1, id: this.id(db), roomId: author.roomId, revision: 1,
            policyRevision: job.room.policy.revision, status: "draft", digest: null, createdAt: this.timestamp(),
            acceptedAt: null, ...result.draft }, job.room.policy);
          db.state.plans.push(plan);
          db.planPolicies.push({ planId: plan.id, policy: copy(job.room.policy) });
          author.planId = plan.id;
          author.status = "completed";
          this.event(db, "plan.updated", plan.roomId, null, plan.id, plan.revision);
        } else if (result.status === "waiting_question") {
          if (!equal(result.checkpoint.continuation.usage, result.usage)) throw new Error("Authoring checkpoint usage mismatch");
          author.status = "waiting_question";
          job.checkpoint = result.checkpoint;
          job.answer = null;
          this.addQuestion(db, { scope: "authoring", roomId: author.roomId, authoringId }, result.question);
        } else { author.status = "failed"; author.error = result.error; }
        this.touchAuthor(db, author);
      });
    }).catch(() => this.authorFailure(authoringId, generation, "Authoring failed or returned invalid data; no plan was accepted"))
      .finally(() => this.clearAuthor(authoringId, generation));
  }

  private authorFailure(id: string, generation: number, message: string): void {
    if (this.closed || this.failure) return;
    try {
      this.commit((db) => {
        const author = db.state.authorings.find((a) => a.id === id)!;
        const job = db.authorJobs.find((j) => j.authoringId === id)!;
        if (author.status !== "authoring" || job.generation !== generation) return;
        author.status = "failed";
        author.error = message;
        author.usage.accounting = "unknown";
        author.usage.reservedTokens = Math.max(0, job.room.policy.authoringBudget.maxTokens - author.usage.inputTokens - author.usage.outputTokens);
        this.touchAuthor(db, author);
      });
    } catch { /* Persistence failures fence the kernel in commit(). */ }
  }

  private clearAuthor(id: string, generation?: number): void {
    if (generation !== undefined && this.authors.get(id)?.generation !== generation) return;
    clearTimeout(this.authors.get(id)?.timer);
    this.authors.delete(id);
  }

  private requireReady(): void {
    if (!this.initialized || this.closing || this.failure) throw new BridgeError(this.failure ?? "Harness is not ready", 503);
  }

  private commit<T>(change: (db: Database) => T, skipUnchanged = false): T {
    if (this.closed || this.failure) throw new Error(this.failure ?? "Kernel is closed");
    const next = copy(this.db);
    const result = change(next);
    boundedDatabase(next);
    if (skipUnchanged && equal(next, this.db)) return copy(result);
    try { this.store.save(next); }
    catch (error) {
      this.fence("Durable harness write failed; dispatch stopped. Restart to reconcile resources");
      throw error;
    }
    this.db = next;
    return copy(result);
  }

  private fence(reason: string): void {
    this.failure = reason;
    for (const entry of this.workers.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    for (const entry of this.authors.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    for (const attempt of this.db.attempts.filter(active)) {
      void Promise.resolve().then(() => bounded(this.options.worker.cancel(copy(attempt.ref)))).catch(() => undefined);
    }
  }

  private room(db: Database, id: string): Room { return db.state.rooms.find((r) => r.id === id) ?? missing(); }
  private run(db: Database, roomId: string, id: string): Run { this.room(db, roomId); return db.state.runs.find((r) => r.roomId === roomId && r.id === id) ?? missing(); }
  private plan(db: Database, roomId: string, id: string): Plan { this.room(db, roomId); return db.state.plans.find((p) => p.roomId === roomId && p.id === id) ?? missing(); }
  private author(db: Database, roomId: string, id: string): Authoring { this.room(db, roomId); return db.state.authorings.find((a) => a.roomId === roomId && a.id === id) ?? missing(); }
  private ledger(db: Database, runId: string, nodeId: string): NodeLedger { return db.ledgers.find((l) => l.runId === runId && l.nodeId === nodeId) ?? missing(); }
  private currentAttempt(db: Database, node: NodeState): Attempt | undefined { return db.attempts.find((a) => a.ref.attemptId === node.attemptId); }
  private timestamp(): string { return this.now().toISOString(); }
  private milliseconds(): number { return this.now().getTime(); }

  private id(db: Database): string {
    const id = IdSchema.parse(this.idFactory());
    if ([...db.state.rooms, ...db.state.plans, ...db.state.authorings, ...db.state.runs,
      ...db.state.questions, ...db.state.artifacts].some((entity) => entity.id === id) || db.attempts.some((a) => a.ref.attemptId === id)) throw new Error("ID generator collision");
    return id;
  }

  private request(db: Database, key: string, input: unknown): string | null {
    const found = db.requests.find((r) => r.key === key);
    if (!found) return null;
    if (found.digest !== sha256(canonicalJson(input))) conflict("Request ID was already used with different content");
    return found.entityId;
  }
  private recordRequest(db: Database, key: string, input: unknown, entityId: string): void {
    db.requests.push({ key, digest: sha256(canonicalJson(input)), entityId });
  }
  private event(db: Database, type: HarnessEvent["type"], roomId: string, runId: string | null, entityId: string, revision: number): void {
    db.state.sequence++;
    db.events.push({ version: 1, sequence: db.state.sequence, at: this.timestamp(), roomId, runId, entityId, revision, type });
    if (db.events.length > 1_000) db.events.splice(0, db.events.length - 1_000);
  }
  private touchAuthor(db: Database, author: Authoring): void {
    author.revision++;
    author.updatedAt = this.timestamp();
    this.event(db, "authoring.updated", author.roomId, null, author.id, author.revision);
  }
  private unknownAuthorUsage(db: Database, author: Authoring): void {
    const job = db.authorJobs.find((job) => job.authoringId === author.id)!;
    author.usage.accounting = "unknown";
    author.usage.reservedTokens = Math.max(0, job.room.policy.authoringBudget.maxTokens - author.usage.inputTokens - author.usage.outputTokens);
  }
  private questionEvent(db: Database, q: Question): void {
    this.event(db, "question.updated", q.target.roomId, q.target.scope === "node" ? q.target.runId : null, q.id, q.revision);
  }
  private addQuestion(db: Database, target: QuestionTarget, prompt: QuestionPrompt): void {
    if (!isSafeClarification(prompt)) throw new BridgeError("Unsafe clarification rejected", 400);
    const q: Question = { kind: "question", id: this.id(db), revision: 1, target, question: prompt,
      status: "pending", createdAt: this.timestamp(), expiresAt: new Date(this.milliseconds() + 86_400_000).toISOString(), answer: null };
    db.state.questions.push(q);
    this.questionEvent(db, q);
  }
  private cancelQuestions(db: Database, predicate: (q: Question) => boolean): void {
    for (const q of db.state.questions) if (q.status === "pending" && predicate(q)) {
      q.status = "cancelled"; q.revision++; this.questionEvent(db, q);
    }
  }
  private expireQuestions(db: Database): void {
    for (const q of db.state.questions) if (q.status === "pending" && Date.parse(q.expiresAt) <= this.milliseconds()) {
      q.status = "expired"; q.revision++; this.questionEvent(db, q);
      if (q.target.scope === "node") {
        const run = this.run(db, q.target.roomId, q.target.runId);
        const nodeId = q.target.nodeId;
        const node = run.nodes.find((n) => n.nodeId === nodeId)!;
        if (node.status === "waiting_question") { node.status = "failed"; node.error = "Question expired; explicitly retry or create a new run"; this.touchRun(db, run); }
      } else {
        const author = this.author(db, q.target.roomId, q.target.authoringId);
        if (author.status === "waiting_question") { author.status = "failed"; author.error = "Question expired"; this.touchAuthor(db, author); }
      }
    }
  }
  private checkedPlan(plan: Plan, policy: Room["policy"]): Plan {
    const parsed = validatePlan(plan, policy);
    if (policy.runBudget.estimatedUsdLimit !== null && (parsed.nodes.some((n) => n.limits.estimatedUsdLimit === null) ||
        parsed.nodes.reduce((sum, n) => sum + (n.limits.estimatedUsdLimit ?? 0), 0) > policy.runBudget.estimatedUsdLimit)) throw new Error("Plan estimated-dollar reservations exceed policy");
    return parsed;
  }
  private checkUsage(usage: Usage, limits: BudgetLimits, previous: Usage): void {
    UsageSchema.parse(usage);
    for (const key of ["steps", "modelCalls", "inputTokens", "outputTokens"] as const) if (usage[key] < previous[key]) throw new Error("Worker usage regressed");
    if (previous.accounting !== "measured" && usage.accounting === "measured") throw new Error("Unknown accounting cannot be silently cleared");
    if (usage.steps > limits.maxSteps || usage.modelCalls > limits.maxModelCalls ||
        usage.inputTokens + usage.outputTokens + usage.reservedTokens > limits.maxTokens ||
        (limits.estimatedUsdLimit !== null && usage.estimatedUsd !== null && usage.estimatedUsd > limits.estimatedUsdLimit)) throw new Error("Worker budget exceeded");
  }

  private kick(): void {
    if (this.pumping || !this.initialized || this.closing || this.failure) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      if (this.closing || this.failure) return;
      try {
        const specs = this.commit((db) => this.schedule(db), true);
        for (const spec of specs) this.launchWorker(spec);
      } catch {
        // Invalid local state must fail closed, not repeatedly attempt dispatch.
        if (!this.failure) this.fence("Scheduler failed closed; restart to reconcile before continuing");
      }
    });
  }

  private schedule(db: Database): WorkerSpec[] {
    this.expireQuestions(db);
    this.blockDependents(db);
    const specs: WorkerSpec[] = [];
    if (!db.state.worker.available) return specs;
    while (db.attempts.filter(active).length < this.maximum) {
      this.blockDependents(db);
      let selected = false;
      const rooms = this.rotate(db.state.rooms, db.lastRoomId);
      for (const room of rooms) {
        if (room.status !== "active") continue;
        const roomActive = db.attempts.filter((a) => a.ref.roomId === room.id && active(a)).length;
        if (roomActive >= room.policy.maxConcurrentWorkers) continue;
        const previousRun = db.attempts.filter((a) => a.ref.roomId === room.id).at(-1)?.ref.runId ?? null;
        const runs = this.rotate(db.state.runs.filter((r) => r.roomId === room.id), previousRun);
        for (const run of runs) {
          if (!["queued", "running", "waiting_question"].includes(run.status) || db.cancelledRuns.includes(run.id) ||
              roomActive >= run.policy.maxConcurrentWorkers) continue;
          const plan = this.plan(db, room.id, run.planId);
          const node = run.nodes.find((n) => n.status === "queued" && plan.nodes.find((d) => d.id === n.nodeId)!.dependencies.every((id) =>
            run.nodes.some((n) => n.nodeId === id && n.status === "completed")));
          if (!node) continue;
          const ledger = this.ledger(db, run.id, node.nodeId);
          let limits: BudgetLimits;
          try { limits = this.remainingLimits(db, run, node, ledger); }
          catch (error) {
            if (db.attempts.some((a) => a.ref.runId === run.id && active(a))) continue;
            node.status = "failed";
            node.error = error instanceof Error ? error.message.slice(0, 2_000) : "Node budget exhausted";
            node.finishedAt = this.timestamp();
            this.touchRun(db, run);
            selected = true;
            break;
          }
          const definition = plan.nodes.find((n) => n.id === node.nodeId)!;
          const inputs = definition.inputFrom.flatMap((id) => {
            const upstream = run.nodes.find((n) => n.nodeId === id)!;
            if (upstream.status !== "completed") throw new Error("Artifact prerequisite is incomplete");
            return upstream.artifactIds.map((artifactId) => db.state.artifacts.find((a) => a.id === artifactId)!);
          });
          if (inputs.length > 32) {
            node.status = "failed";
            node.error = "Upstream artifact handoff exceeds the bounded worker input count";
            node.finishedAt = this.timestamp();
            node.usage.reservedTokens = 0;
            this.touchRun(db, run);
            selected = true;
            break;
          }
          const attemptId = this.id(db);
          const spec = WorkerSpecSchema.parse({ version: 1,
            ref: { roomId: room.id, runId: run.id, nodeId: node.nodeId, attemptId }, planDigest: run.planDigest,
            node: { ...definition, limits }, policy: run.policy, inputs,
            checkpoint: ledger.checkpoint, answer: ledger.answer });
          db.attempts.push({ ref: spec.ref, spec, phase: "intent", stopped: false, nextSequence: 0, resourceId: null,
            baseUsage: copy(ledger.baseUsage), usage: copy(ledger.checkpoint?.continuation.usage ?? ledger.baseUsage),
            startedMs: this.milliseconds(), elapsedMs: 0, wallReservationMs: this.wallAllowance(db, run, node),
            stopReason: null, result: null });
          node.attemptId = attemptId;
          node.attemptNumber++;
          node.status = "running";
          node.startedAt = null;
          node.finishedAt = null;
          node.operation = "Dispatch intent persisted; waiting for isolated resource";
          node.error = null;
          ledger.checkpoint = null;
          ledger.answer = null;
          this.touchRun(db, run);
          specs.push(spec);
          db.lastRoomId = room.id;
          db.lastRunId = run.id;
          selected = true;
          break;
        }
        if (selected) break;
      }
      if (!selected) break;
    }
    return specs;
  }

  private blockDependents(db: Database): void {
    for (const run of db.state.runs) {
      const plan = this.plan(db, run.roomId, run.planId);
      let changed = false;
      let again: boolean;
      do {
        again = false;
        for (const node of run.nodes) {
          if (node.status !== "queued") continue;
          const definition = plan.nodes.find((n) => n.id === node.nodeId)!;
          if (definition.dependencies.some((id) => run.nodes.some((n) => n.nodeId === id && ["failed", "blocked", "cancelled"].includes(n.status)))) {
            node.status = "blocked";
            node.error = "A prerequisite did not complete successfully";
            node.finishedAt = this.timestamp();
            if (node.usage.accounting === "measured") node.usage.reservedTokens = 0;
            again = true; changed = true;
          }
        }
      } while (again);
      if (changed) this.touchRun(db, run);
    }
  }

  private rotate<T extends { id: string }>(items: T[], last: string | null): T[] {
    const index = items.findIndex((item) => item.id === last);
    return index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index + 1)];
  }

  private remainingLimits(db: Database, run: Run, node: NodeState, ledger: NodeLedger): BudgetLimits {
    const original = this.plan(db, run.roomId, run.planId).nodes.find((n) => n.id === node.nodeId)!.limits;
    const consumed = ledger.checkpoint?.continuation.usage ?? ledger.baseUsage;
    if (consumed.accounting !== "measured" ||
        original.maxSteps - consumed.steps < 1 || original.maxModelCalls - consumed.modelCalls < 1 ||
        original.maxTokens - consumed.inputTokens - consumed.outputTokens - consumed.reservedTokens < 128 ||
        this.wallAllowance(db, run, node) < 1_000) conflict("Cumulative node/run budget exhausted; no fresh retry or continuation budget is granted");
    return copy(original);
  }

  private wallAllowance(db: Database, run: Run, node: NodeState): number {
    const original = this.plan(db, run.roomId, run.planId).nodes.find((n) => n.id === node.nodeId)!.limits;
    const attempts = db.attempts.filter((a) => a.ref.runId === run.id);
    const wallSpent = attempts.reduce((sum, a) => sum + (a.stopped ? a.elapsedMs : a.wallReservationMs), 0);
    const nodeSpent = attempts.filter((a) => a.ref.nodeId === node.nodeId).reduce((sum, a) => sum + a.elapsedMs, 0);
    return Math.max(0, Math.min(original.maxWallTimeMs - nodeSpent, run.policy.runBudget.maxWallTimeMs - wallSpent));
  }

  private launchWorker(spec: WorkerSpec): void {
    if (this.closing || this.failure || this.closed) return;
    const persisted = this.db.attempts.find((a) => equal(a.ref, spec.ref));
    if (!persisted || persisted.stopped || persisted.stopReason !== null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void this.stopAttempt(spec.ref, "Worker wall-time budget exhausted");
    }, Math.max(1, persisted.wallReservationMs - (this.milliseconds() - persisted.startedMs)));
    timer.unref();
    this.workers.set(spec.ref.attemptId, { controller, timer });
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Dispatch cancelled before launch");
      return this.options.worker.run(copy(spec), { signal: controller.signal, emit: (event) => this.workerEvent(spec.ref, event) });
    }).then(async (result) => {
      if (this.closed || this.failure) return;
      this.commit((db) => this.applyResult(db, spec.ref, result));
      const attempt = this.db.attempts.find((a) => equal(a.ref, spec.ref));
      if (attempt && !attempt.stopped) await this.stopAttempt(spec.ref, attempt.stopReason ?? "Worker returned an uncertain result");
    }).catch(async () => {
      if (!this.closed && !this.failure) await this.stopAttempt(spec.ref, "Worker failed or returned invalid data; resource cleanup required", true);
    }).finally(() => {
      clearTimeout(this.workers.get(spec.ref.attemptId)?.timer);
      this.workers.delete(spec.ref.attemptId);
      this.kick();
    });
  }

  private async workerEvent(ref: AttemptRef, raw: WorkerEvent): Promise<void> {
    if (this.closing) throw new Error("Kernel is shutting down");
    this.commit((db) => {
      const event = WorkerEventSchema.parse(raw);
      const attempt = db.attempts.find((a) => equal(a.ref, ref)) ?? missing();
      const run = this.run(db, ref.roomId, ref.runId);
      const node = run.nodes.find((n) => n.nodeId === ref.nodeId)!;
      if (!equal(event.ref, ref) || node.attemptId !== ref.attemptId || attempt.stopped || attempt.stopReason !== null ||
          !["intent", "active"].includes(attempt.phase)) conflict("Stale or cross-scope worker event");
      if (event.sequence !== attempt.nextSequence) conflict("Worker event sequence is duplicated or gapped");
      if (event.sequence >= 1_000) conflict("Worker event count exceeded its bounded limit");
      if ((event.type === "started") !== (attempt.nextSequence === 0)) conflict("The first event must be the only resource-start event");
      this.elapsed(attempt);
      if (attempt.elapsedMs > attempt.wallReservationMs) throw new Error("Worker wall-time budget exceeded");
      if (event.type === "started") {
        attempt.resourceId = event.resourceId;
        attempt.phase = "active";
        node.startedAt = this.timestamp();
        node.operation = "Isolated worker started";
      } else if (event.type === "progress") node.operation = event.operation;
      else {
        this.checkUsage(event.usage, attempt.spec.node.limits, attempt.usage);
        attempt.usage = event.usage;
        this.nodeUsage(db, run, node, attempt, false);
      }
      attempt.nextSequence++;
      this.touchRun(db, run);
    });
  }

  private applyResult(db: Database, ref: AttemptRef, raw: WorkerResult, recovered = false): void {
    const result = WorkerResultSchema.parse(raw);
    if (!equal(ref, result.ref)) throw new Error("Worker result scope mismatch");
    const attempt = db.attempts.find((a) => equal(a.ref, ref)) ?? missing();
    const run = this.run(db, ref.roomId, ref.runId);
    const node = run.nodes.find((n) => n.nodeId === ref.nodeId)!;
    if (node.attemptId !== ref.attemptId || attempt.stopped || attempt.stopReason !== null) return;
    this.checkUsage(result.usage, attempt.spec.node.limits, attempt.usage);
    if (recovered) attempt.elapsedMs = attempt.wallReservationMs;
    else this.elapsed(attempt);
    if (attempt.elapsedMs > attempt.wallReservationMs) throw new Error("Worker wall-time budget exceeded");
    if ((result.status === "completed" || result.status === "waiting_question") && !attempt.resourceId && !recovered) throw new Error("Worker returned output without a resource-start event");
    attempt.usage = result.usage;
    attempt.result = result;
    attempt.stopped = result.status !== "interrupted" && (result.status !== "cancelled" || result.confirmed);
    attempt.phase = attempt.stopped ? "settled" : "uncertain";
    node.status = result.status === "cancelled" && !result.confirmed ? "interrupted" : result.status;
    node.finishedAt = attempt.stopped ? this.timestamp() : null;
    node.operation = null;
    if (result.status === "completed") {
      this.addArtifacts(db, run, node, attempt, result.artifacts);
      node.artifactIds = result.artifacts.map((a) => a.id);
    } else if (result.status === "waiting_question") {
      const checkpoint = result.checkpoint;
      if (!equal(checkpoint.ref, ref) || checkpoint.sequence < Math.max(0, attempt.nextSequence - 1) ||
          checkpoint.sequence > (recovered ? 1_000 : attempt.nextSequence) || !equal(checkpoint.continuation.usage, result.usage)) throw new Error("Checkpoint scope, sequence or cumulative usage mismatch");
      this.addArtifacts(db, run, node, attempt, checkpoint.artifacts);
      node.artifactIds = checkpoint.artifacts.map((a) => a.id);
      this.addQuestion(db, { scope: "node", ...ref }, checkpoint.question);
    } else if (result.status === "failed") node.error = result.error;
    else if (result.status === "interrupted") node.error = result.reason;
    this.nodeUsage(db, run, node, attempt, attempt.stopped && result.status !== "waiting_question");
    this.touchRun(db, run);
  }

  private addArtifacts(db: Database, run: Run, node: NodeState, attempt: Attempt, artifacts: ArtifactManifest[]): void {
    const allowed = new Set([...attempt.spec.inputs, ...(attempt.spec.checkpoint?.artifacts ?? [])].map((a) => a.digest));
    const required = attempt.spec.inputs.map((a) => a.digest);
    const paths = new Set<string>();
    let bytes = 0;
    let files = 0;
    for (const raw of artifacts) {
      const artifact = validateArtifact(raw, run.policy);
      if (artifact.roomId !== run.roomId || artifact.runId !== run.id || artifact.nodeId !== node.nodeId ||
          artifact.attemptId !== attempt.ref.attemptId || artifact.planDigest !== run.planDigest ||
          new Set(artifact.inputDigests).size !== artifact.inputDigests.length ||
          artifact.inputDigests.some((digest) => !allowed.has(digest)) || required.some((digest) => !artifact.inputDigests.includes(digest))) throw new Error("Artifact provenance mismatch");
      for (const file of artifact.files) {
        if (paths.has(file.path) || !attempt.spec.node.outputPaths.some((output) => file.path === output || file.path.startsWith(`${output}/`))) throw new Error("Artifact path is duplicated or outside declared outputs");
        paths.add(file.path);
        bytes += file.bytes; files++;
      }
      if ([...db.state.artifacts, ...db.state.rooms, ...db.state.plans, ...db.state.runs, ...db.state.authorings, ...db.state.questions].some((a) => a.id === artifact.id) ||
          db.attempts.some((a) => a.ref.attemptId === artifact.id)) throw new Error("Artifact IDs are immutable and cannot replace existing entities");
      db.state.artifacts.push(copy(artifact));
      this.event(db, "artifact.created", run.roomId, run.id, artifact.id, 1);
    }
    if (bytes > run.policy.sandbox.maxArtifactBytes || files > run.policy.sandbox.maxArtifactFiles) throw new Error("Aggregate artifact output exceeds policy");
  }

  private nodeUsage(db: Database, run: Run, node: NodeState, attempt: Attempt, release: boolean): void {
    node.usage = copy(attempt.usage);
    const maximum = this.plan(db, run.roomId, run.planId).nodes.find((n) => n.id === node.nodeId)!.limits.maxTokens;
    node.usage.reservedTokens = release && node.usage.accounting === "measured" ? 0 :
      Math.max(0, maximum - node.usage.inputTokens - node.usage.outputTokens);
  }

  private elapsed(attempt: Attempt): void {
    attempt.elapsedMs = Math.max(attempt.elapsedMs, Math.max(0, this.milliseconds() - attempt.startedMs));
  }

  private touchRun(db: Database, run: Run): void {
    const unresolved = db.attempts.filter((a) => a.ref.runId === run.id && active(a));
    const nodes = run.nodes;
    run.usage = nodes.reduce((sum, node) => addUsage(sum, node.usage), zeroUsage());
    if (db.cancelledRuns.includes(run.id)) {
      run.cancelConfirmed = unresolved.length === 0;
      run.status = run.cancelConfirmed ? "cancelled" : unresolved.some((a) => a.phase === "uncertain") ? "interrupted" : "cancel_requested";
    } else if (nodes.every((n) => n.status === "completed")) run.status = "completed";
    else if (nodes.every((n) => ["completed", "failed", "blocked", "cancelled"].includes(n.status))) run.status = "failed";
    else if (run.status !== "paused") {
      run.status = nodes.some((n) => n.status === "interrupted") ? "interrupted" :
        nodes.some((n) => n.status === "running" || n.status === "cancel_requested") ? "running" :
        nodes.some((n) => n.status === "queued") ? "queued" : "waiting_question";
    }
    run.revision++;
    run.updatedAt = this.timestamp();
    this.event(db, "run.updated", run.roomId, run.id, run.id, run.revision);
  }

  private readonly stopping = new Map<string, Promise<void>>();
  private stopAttempt(ref: AttemptRef, reason?: string, unknownUsage = false): Promise<void> {
    const previous = this.stopping.get(ref.attemptId);
    if (previous) return previous;
    const stop = this.stopAttemptOnce(ref, reason, unknownUsage).finally(() => this.stopping.delete(ref.attemptId));
    this.stopping.set(ref.attemptId, stop);
    return stop;
  }

  private async stopAttemptOnce(ref: AttemptRef, reason?: string, unknownUsage = false): Promise<void> {
    if (this.closed || this.failure) return;
    try {
      this.commit((db) => {
        const attempt = db.attempts.find((a) => equal(a.ref, ref)) ?? missing();
        if (attempt.stopped) return;
        const run = this.run(db, ref.roomId, ref.runId);
        const node = run.nodes.find((n) => n.nodeId === ref.nodeId)!;
        if (node.attemptId !== ref.attemptId) throw new Error("Cannot stop an obsolete attempt");
        attempt.stopReason ??= reason ?? "Cancellation requested";
        if (unknownUsage) attempt.usage.accounting = "unknown";
        node.status = "cancel_requested";
        node.operation = "Waiting for isolated resource stop confirmation";
        this.touchRun(db, run);
      });
      const current = this.db.attempts.find((a) => equal(a.ref, ref));
      if (current?.stopped) return;
      this.workers.get(ref.attemptId)?.controller.abort();
      let confirmed = false;
      try {
        const response = CancellationSchema.parse(await bounded(this.options.worker.cancel(copy(ref))));
        if (!equal(response.ref, ref)) throw new Error("Cancellation scope mismatch");
        confirmed = response.confirmed;
      } catch { /* Unknown cleanup is explicitly retained and reconciled on restart. */ }
      if (this.closed || this.failure) return;
      this.commit((db) => {
        const attempt = db.attempts.find((a) => equal(a.ref, ref))!;
        if (attempt.stopped) return;
        const run = this.run(db, ref.roomId, ref.runId);
        const node = run.nodes.find((n) => n.nodeId === ref.nodeId)!;
        this.elapsed(attempt);
        attempt.stopped = confirmed;
        attempt.phase = confirmed ? "settled" : "uncertain";
        // A control acknowledgement proves teardown, not unreported provider usage.
        attempt.usage.accounting = "unknown";
        node.status = db.cancelledRuns.includes(run.id) ? (confirmed ? "cancelled" : "interrupted") : "interrupted";
        node.finishedAt = confirmed ? this.timestamp() : null;
        node.operation = null;
        node.error = confirmed ? attempt.stopReason : "Resource stop is unconfirmed; no replay or retry is permitted";
        this.nodeUsage(db, run, node, attempt, false);
        this.touchRun(db, run);
      });
      clearTimeout(this.workers.get(ref.attemptId)?.timer);
      this.kick();
    } catch { /* commit() fences dispatch on storage failure. */ }
  }

  private async reconcile(ref: AttemptRef): Promise<void> {
    try {
      const reconciliation = await bounded(this.options.worker.reconcile(copy(ref)));
      if (!equal(reconciliation.ref, ref)) throw new Error("Reconciliation scope mismatch");
      if (reconciliation.state === "settled") {
        const attempt = this.db.attempts.find((a) => equal(a.ref, ref))!;
        if (!attempt.stopReason) {
          // A persisted terminal result's wall time is not the time since a later restart.
          this.commit((db) => {
            this.applyResult(db, ref, reconciliation.result, true);
          });
          if (this.db.attempts.find((a) => equal(a.ref, ref))!.stopped) return;
        }
      }
    } catch { /* No result is adopted without complete scope/schema validation. */ }
    await this.stopAttempt(ref, "Runtime restarted during an attempt; explicit retry is required", true);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    this.closing = true;
    if (this.initializing) await this.initializing.catch(() => undefined);
    if (!this.failure && this.initialized) {
      try {
        this.commit((db) => {
          db.state.ready = false;
          for (const author of db.state.authorings) if (author.status === "authoring") {
            this.unknownAuthorUsage(db, author);
            author.status = "interrupted"; author.error = "Runtime shut down during authoring"; this.touchAuthor(db, author);
          }
        });
      } catch { /* Still attempt actual cleanup if storage is unavailable. */ }
    }
    for (const entry of this.authors.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.authors.clear();
    const refs = this.db.attempts.filter(active).map((a) => copy(a.ref));
    if (this.failure) {
      await Promise.allSettled(refs.map((ref) => bounded(this.options.worker.cancel(ref))));
    } else await Promise.allSettled(refs.map((ref) => this.stopAttempt(ref, "Runtime shut down; explicit retry is required", true)));
    for (const entry of this.workers.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.workers.clear();
    this.closed = true;
    this.store.close();
  }

  private validateLoaded(): void {
    const db = this.db;
    const safeQuestion = (question: QuestionPrompt | undefined) => !question || isSafeClarification(question);
    const safeAnswer = (answer: Pick<AnswerQuestionRequest, "text" | "choiceId"> | null) => !answer || isSafeClarificationAnswer(answer);
    if (db.state.questions.some((q) => !safeQuestion(q.question) || !safeAnswer(q.answer)) ||
        db.attempts.some((a) => !safeQuestion(a.spec.checkpoint?.question) || !safeAnswer(a.spec.answer) ||
          (a.result?.status === "waiting_question" && !safeQuestion(a.result.checkpoint.question))) ||
        db.ledgers.some((l) => !safeQuestion(l.checkpoint?.question) || !safeAnswer(l.answer)) ||
        db.authorJobs.some((j) => !safeAnswer(j.answer))) {
      throw new Error("Unsafe persisted clarification; offline data review is required before startup");
    }
    const seen = new Set<string>();
    for (const item of [...db.state.rooms, ...db.state.plans, ...db.state.runs, ...db.state.authorings, ...db.state.questions, ...db.state.artifacts]) {
      if (seen.has(item.id)) throw new Error("Duplicate durable entity ID");
      seen.add(item.id);
    }
    for (const plan of db.state.plans) {
      this.room(db, plan.roomId);
      const policy = db.planPolicies.find((p) => p.planId === plan.id)?.policy;
      if (!policy) throw new Error("Missing persisted plan policy");
      this.checkedPlan(plan, policy);
    }
    for (const run of db.state.runs) {
      const plan = this.plan(db, run.roomId, run.planId);
      this.checkedPlan(plan, run.policy);
      if (plan.status !== "accepted" || plan.digest !== run.planDigest || plan.revision !== run.planRevision ||
          !equal(plan.nodes.map((n) => n.id), run.nodes.map((n) => n.nodeId))) throw new Error("Persisted run does not match its accepted plan");
      for (const node of run.nodes) {
        this.ledger(db, run.id, node.nodeId);
        if (node.attemptId && !db.attempts.some((a) => equal(a.ref, { roomId: run.roomId, runId: run.id, nodeId: node.nodeId, attemptId: node.attemptId }))) throw new Error("Missing current attempt intent");
        for (const id of node.artifactIds) if (!db.state.artifacts.some((a) => a.id === id && a.runId === run.id && a.nodeId === node.nodeId)) throw new Error("Missing node artifact");
      }
    }
    const attempts = new Set<string>();
    for (const attempt of db.attempts) {
      const run = this.run(db, attempt.ref.roomId, attempt.ref.runId);
      if (attempts.has(attempt.ref.attemptId) || seen.has(attempt.ref.attemptId) || !equal(attempt.spec.ref, attempt.ref) ||
          attempt.spec.planDigest !== run.planDigest || !equal(attempt.spec.policy, run.policy) ||
          !run.nodes.some((n) => n.nodeId === attempt.ref.nodeId)) throw new Error("Invalid persisted attempt scope");
      attempts.add(attempt.ref.attemptId);
      for (const input of attempt.spec.inputs) if (!db.state.artifacts.some((a) => equal(a, input))) throw new Error("Unknown persisted worker input");
      if (attempt.result && !equal(attempt.result.ref, attempt.ref)) throw new Error("Invalid persisted result scope");
    }
    for (const artifact of db.state.artifacts) {
      const run = this.run(db, artifact.roomId, artifact.runId);
      validateArtifact(artifact, run.policy);
      if (artifact.planDigest !== run.planDigest || !db.attempts.some((a) => a.ref.runId === run.id && a.ref.nodeId === artifact.nodeId && a.ref.attemptId === artifact.attemptId)) throw new Error("Invalid persisted artifact provenance");
    }
    for (const author of db.state.authorings) {
      this.room(db, author.roomId);
      const job = db.authorJobs.find((j) => j.authoringId === author.id);
      if (!job || job.room.id !== author.roomId || job.room.policy.revision !== author.policyRevision) throw new Error("Invalid persisted authoring scope");
    }
    for (const q of db.state.questions) {
      if (q.target.scope === "authoring") this.author(db, q.target.roomId, q.target.authoringId);
      else {
        const target = q.target;
        const run = this.run(db, target.roomId, target.runId);
        if (!db.attempts.some((a) => equal(a.ref, { roomId: target.roomId, runId: target.runId, nodeId: target.nodeId, attemptId: target.attemptId }))) throw new Error("Missing question attempt");
        if (q.status === "pending" && !run.nodes.some((n) => n.nodeId === target.nodeId && n.attemptId === target.attemptId && n.status === "waiting_question")) throw new Error("Pending question references a stale attempt");
      }
    }
    for (let i = 0; i < db.events.length; i++) if (db.events[i].sequence !== db.state.sequence - db.events.length + i + 1) throw new Error("Invalid persisted event sequence");
  }
}
