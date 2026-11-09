import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "../errors.ts";
import { canonicalJson } from "../harness-contracts/validation.ts";
import { containsCredentialLikeData } from "../../agent/lib/memory.ts";
import { ObjectiveStore, type ObjectivePersistence } from "./store.ts";
import { AnswerObjectiveSchema, ChildObservationSchema, CreateObjectiveSchema, ObjectiveQuestionSchema,
  ObjectiveRevisionSchema, ObjectiveSnapshotSchema, ReserveBudgetSchema, ReviseObjectiveSchema, WorkCheckpointSchema,
  type BudgetReservation, type ChildObservation, type Objective, type ObjectiveAdapter, type ObjectiveAttempt,
  type ObjectiveAuthority, type ObjectiveEvent, type ObjectiveSnapshot, type ObjectiveStep, type WorkCheckpoint } from "./contracts.ts";
export * from "./contracts.ts";

const HORIZON = 7 * 86_400_000;
const terminal = new Set(["completed", "failed", "cancelled"]);
const activeAttempt = (attempt: ObjectiveAttempt) => !terminal.has(attempt.status) || attempt.accounting !== "measured" || attempt.status === "cancelled" && !attempt.cancelConfirmed;
const micros = (value: number) => Math.ceil(value * 1_000_000 - 1e-7);
const dollars = (value: number) => value / 1_000_000;
const charge = (entry: BudgetReservation) => micros(entry.chargedUsd) + (entry.accounting === "measured" ? 0 : micros(entry.reservedUsd));
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export interface ObjectiveOptions {
  dataDirectory: string; enabled?: boolean; adapters?: Partial<Record<ObjectiveAuthority, ObjectiveAdapter>>;
  now?: () => Date; store?: ObjectivePersistence;
}
/** Only trusted adapters may use this when no child/provider side effect began. */
export class ObjectiveDispatchRejected extends Error {}

/** Coordinates bounded child authorities, never executes tools or approves effects. */
export class ObjectiveService {
  readonly enabled: boolean;
  private snapshot: ObjectiveSnapshot = { version: 1, sequence: 0, objectives: [], reservations: [], events: [], requests: [], inbox: [] };
  private readonly store: ObjectivePersistence;
  private queue = Promise.resolve();
  private failed = false;
  private closed = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly listeners = new Set<(event: ObjectiveEvent) => void>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly reconciling = new Set<string>();
  private readonly options: ObjectiveOptions;
  private constructor(options: ObjectiveOptions) { this.options = options; this.enabled = options.enabled ?? false; this.store = options.store ?? new ObjectiveStore(); }
  static async open(options: ObjectiveOptions): Promise<ObjectiveService> {
    const service = new ObjectiveService(options);
    if (!service.enabled) return service;
    try {
      service.snapshot = await service.store.open(options.dataDirectory);
      service.validate(service.snapshot);
      // No provider operation is replayed on startup. Exact retained child refs
      // may later be inspected; missing dispatch receipts remain unknown.
      if (service.snapshot.objectives.some(objective => objective.attempts.some(activeAttempt)) || service.snapshot.reservations.some(item => item.accounting === "reserved")) {
        await service.mutate(draft => {
          for (const reservation of draft.reservations) if (reservation.accounting === "reserved") reservation.accounting = "unknown";
          for (const objective of draft.objectives) if (objective.attempts.some(activeAttempt)) {
            for (const attempt of objective.attempts.filter(activeAttempt)) {
              attempt.status = "unknown"; attempt.accounting = "unknown";
              const reservation = draft.reservations.find(item => item.id === attempt.id)!;
              if (reservation.accounting !== "measured") reservation.accounting = "unknown";
            }
            objective.status = "interrupted"; objective.lastError = "Restart requires observation of existing child work; no operation was replayed.";
            service.event(draft, objective, "observed");
          }
        });
      }
      return service;
    } catch (error) { service.store.close(); throw error; }
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private requireReady(): void {
    if (!this.enabled || this.closed || this.failed) throw new BridgeError("Objective service is disabled, closed or requires recovery after a persistence fault.", 503);
  }
  private requireReadable(): void { if (!this.enabled || this.closed) throw new BridgeError("Objective service is unavailable.", 503); }
  private object(snapshot: ObjectiveSnapshot, id: string, projectId: string): Objective {
    const value = snapshot.objectives.find(item => item.id === id && item.projectId === projectId);
    if (!value) throw new BridgeError("Objective not found in this project.", 404); return value;
  }
  private cas(objective: Objective, revision: number): void { if (objective.revision !== revision) throw new BridgeError("Objective revision changed; reload before continuing.", 409); }
  private dates(deadline: string, wake?: string | null): void {
    const now = Date.parse(this.now());
    if (Date.parse(deadline) <= now || Date.parse(deadline) > now + HORIZON || wake && Date.parse(wake) > Date.parse(deadline)) throw new BridgeError("Objective deadline must be within seven days, with wake time no later than its deadline.", 400);
  }
  private steps(steps: ObjectiveStep[]): void {
    const ids = new Set(steps.map(step => step.id)); if (ids.size !== steps.length) throw new BridgeError("Duplicate objective step.", 400);
    const done = new Set<string>();
    for (let count = 0; count < steps.length; count++) for (const step of steps) {
      if (step.dependsOn.some(id => !ids.has(id)) || new Set(step.dependsOn).size !== step.dependsOn.length) throw new BridgeError("Invalid objective dependencies.", 400);
      if (step.dependsOn.every(id => done.has(id))) done.add(step.id);
    }
    if (done.size !== steps.length) throw new BridgeError("Objective dependencies contain a cycle.", 400);
    if (Buffer.byteLength(JSON.stringify(steps)) > 128_000) throw new BridgeError("Objective work specification is too large.", 413);
  }
  private sensitive(value: unknown): void { if (containsCredentialLikeData(JSON.stringify(value))) throw new BridgeError("Objective content cannot contain credentials.", 400); }
  private validate(snapshot: ObjectiveSnapshot): void {
    ObjectiveSnapshotSchema.parse(snapshot);
    if (new Set(snapshot.objectives.map(value => value.id)).size !== snapshot.objectives.length || new Set(snapshot.reservations.map(value => value.id)).size !== snapshot.reservations.length) throw new Error("Duplicate objective state identities");
    const attempts = snapshot.objectives.flatMap(value => value.attempts);
    if (new Set(attempts.map(value => value.id)).size !== attempts.length || new Set(snapshot.requests.map(value => value.key)).size !== snapshot.requests.length ||
        snapshot.events.some((event, index) => event.sequence > snapshot.sequence || index > 0 && event.sequence !== snapshot.events[index - 1].sequence + 1)) throw new Error("Inconsistent objective event or request identities");
    for (const objective of snapshot.objectives) {
      this.steps(objective.steps);
      for (const attempt of objective.attempts) {
        const step = objective.steps.find(step => step.id === attempt.stepId), reservation = snapshot.reservations.find(value => value.id === attempt.id);
        if (!step || step.authority !== attempt.authority || !reservation || reservation.objectiveId !== objective.id || reservation.projectId !== objective.projectId ||
            attempt.child && (attempt.child.projectId !== objective.projectId || attempt.child.authority !== attempt.authority)) throw new Error("Inconsistent objective child or budget binding");
      }
    }
  }
  private event(snapshot: ObjectiveSnapshot, objective: Objective, kind: ObjectiveEvent["kind"]): void {
    objective.revision++; objective.updatedAt = this.now();
    const reservations = snapshot.reservations.filter(item => item.objectiveId === objective.id);
    objective.budget.spentUsd = dollars(reservations.reduce((sum, item) => sum + micros(item.chargedUsd), 0));
    objective.budget.reservedUsd = dollars(reservations.reduce((sum, item) => sum + (item.accounting === "measured" ? 0 : micros(item.reservedUsd)), 0));
    snapshot.events.push({ version: 1, sequence: ++snapshot.sequence, at: this.now(), objectiveId: objective.id, projectId: objective.projectId, revision: objective.revision, status: objective.status, kind });
    snapshot.events = snapshot.events.slice(-1_000);
  }
  private mutate<T>(operation: (draft: ObjectiveSnapshot) => T): Promise<T> {
    const promise = this.queue.then(() => {
      this.requireReady(); const draft = structuredClone(this.snapshot), previous = draft.sequence;
      const result = operation(draft); this.validate(draft);
      if (canonicalJson(draft) === canonicalJson(this.snapshot)) return structuredClone(result);
      try { this.store.save(draft); }
      catch { this.failed = true; for (const controller of this.controllers.values()) controller.abort(); throw new BridgeError("Objective persistence failed; dispatch is fenced until recovery.", 503); }
      this.snapshot = draft;
      for (const event of draft.events.filter(event => event.sequence > previous)) for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch {} }
      return structuredClone(result);
    });
    this.queue = promise.then(() => {}, () => {}); return promise;
  }
  subscribe(listener: (event: ObjectiveEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list(projectId?: string): Objective[] { this.requireReadable(); return structuredClone(this.snapshot.objectives.filter(item => projectId === undefined || item.projectId === projectId)); }
  get(id: string, projectId: string): Objective { this.requireReadable(); return structuredClone(this.object(this.snapshot, id, projectId)); }
  events(after = 0, projectId?: string) {
    this.requireReadable(); if (!Number.isSafeInteger(after) || after < 0 || after > this.snapshot.sequence || after < (this.snapshot.events[0]?.sequence ?? 1) - 1) throw new BridgeError("Objective event cursor expired; reload state.", 409);
    return { version: 1 as const, sequence: this.snapshot.sequence, events: structuredClone(this.snapshot.events.filter(event => event.sequence > after && (!projectId || event.projectId === projectId))) };
  }
  async create(raw: unknown): Promise<Objective> {
    const input = CreateObjectiveSchema.parse(raw); this.steps(input.steps); this.sensitive(input);
    const hash = digest(input), key = `${input.projectId}:${input.requestId}`;
    return this.mutate(draft => {
      const prior = draft.requests.find(item => item.key === key);
      if (prior) { if (prior.digest !== hash) throw new BridgeError("Objective request ID was reused for different input.", 409); return this.object(draft, prior.objectiveId, input.projectId); }
      const now = this.now(), deadlineAt = input.deadlineAt ?? new Date(Date.parse(now) + HORIZON).toISOString(); this.dates(deadlineAt, input.wakeAt);
      const objective: Objective = { version: 1, id: randomUUID(), requestId: input.requestId, projectId: input.projectId, title: input.title, goal: input.goal,
        revision: 0, status: input.steps.length ? "scheduled" : "needs_plan", cancelRequested: false, createdAt: now, updatedAt: now, deadlineAt, wakeAt: input.wakeAt ?? null,
        steps: input.steps, attempts: [], checkpoint: null, question: null, budget: { limitUsd: input.estimatedUsdLimit, spentUsd: 0, reservedUsd: 0 }, lastError: null };
      draft.objectives.push(objective); draft.requests.push({ key, digest: hash, objectiveId: objective.id }); this.event(draft, objective, "created"); return objective;
    });
  }
  async revise(id: string, raw: unknown, projectId: string): Promise<Objective> {
    const input = ReviseObjectiveSchema.parse(raw); this.sensitive(input); if (input.steps) this.steps(input.steps);
    return this.mutate(draft => {
      const objective = this.object(draft, id, projectId); this.cas(objective, input.expectedRevision);
      this.dates(input.deadlineAt ?? objective.deadlineAt, input.wakeAt === undefined ? objective.wakeAt : input.wakeAt);
      if (input.steps) for (const attempt of objective.attempts) {
        const prior = objective.steps.find(step => step.id === attempt.stepId), next = input.steps.find(step => step.id === attempt.stepId);
        if (!next || canonicalJson(next) !== canonicalJson(prior)) throw new BridgeError("Dispatched steps are immutable; append new work instead.", 409);
      }
      const { expectedRevision: _revision, ...changes } = input; Object.assign(objective, changes);
      if (objective.status === "needs_plan" && objective.steps.length) objective.status = "scheduled";
      this.event(draft, objective, "revised"); return objective;
    });
  }
  private async control(id: string, raw: unknown, projectId: string, resume: boolean): Promise<Objective> {
    const input = ObjectiveRevisionSchema.parse(raw);
    return this.mutate(draft => {
      const objective = this.object(draft, id, projectId); this.cas(objective, input.expectedRevision);
      if (resume && (objective.cancelRequested || objective.attempts.some(attempt => attempt.status === "unknown") || objective.question || Date.parse(objective.deadlineAt) <= Date.parse(this.now()))) throw new BridgeError("Resolve unknown work, cancellation, questions or the expired horizon before resuming.", 409);
      if (["completed", "cancelled"].includes(objective.status)) throw new BridgeError("This objective is terminal.", 409);
      objective.status = resume ? (objective.steps.length ? "scheduled" : "needs_plan") : "paused";
      this.event(draft, objective, resume ? "resumed" : "paused"); return objective;
    });
  }
  pause(id: string, raw: unknown, projectId: string) { return this.control(id, raw, projectId, false); }
  resume(id: string, raw: unknown, projectId: string) { return this.control(id, raw, projectId, true); }
  async checkpoint(id: string, raw: unknown, projectId: string, expectedRevision?: number): Promise<Objective> {
    const checkpoint = WorkCheckpointSchema.parse(raw); this.sensitive(checkpoint);
    return this.mutate(draft => {
      const objective = this.object(draft, id, projectId); if (expectedRevision !== undefined) this.cas(objective, expectedRevision);
      this.checkpointBinding(objective, checkpoint); objective.checkpoint = checkpoint; this.event(draft, objective, "checkpoint"); return objective;
    });
  }
  private checkpointBinding(objective: Objective, checkpoint: WorkCheckpoint): void {
    if (checkpoint.objectiveId !== objective.id || checkpoint.projectId !== objective.projectId || checkpoint.childRefs.some(ref => !objective.attempts.some(attempt => canonicalJson(attempt.child) === canonicalJson(ref)))) throw new BridgeError("Checkpoint references must belong to this objective's observed children.", 409);
  }
  async ask(id: string, raw: unknown, projectId: string, expectedRevision: number): Promise<Objective> {
    const question = ObjectiveQuestionSchema.parse(raw); this.sensitive(question);
    return this.mutate(draft => {
      const objective = this.object(draft, id, projectId); this.cas(objective, expectedRevision);
      if (objective.question || draft.inbox.some(item => item.objectiveId === id && item.questionId === question.id) || Date.parse(question.expiresAt) <= Date.parse(this.now()) || Date.parse(question.expiresAt) > Date.parse(objective.deadlineAt)) throw new BridgeError("Question is already used, pending or outside the objective horizon.", 409);
      objective.question = question; objective.status = "waiting_for_user"; this.event(draft, objective, "question"); return objective;
    });
  }
  async answer(id: string, raw: unknown, projectId: string): Promise<Objective> {
    const input = AnswerObjectiveSchema.parse(raw); this.sensitive(input.answer);
    return this.mutate(draft => {
      const objective = this.object(draft, id, projectId); this.cas(objective, input.expectedRevision); const question = objective.question;
      if (!question || question.id !== input.questionId || question.revision !== input.questionRevision || Date.parse(question.expiresAt) <= Date.parse(this.now())) throw new BridgeError("Question binding is stale or expired.", 409);
      draft.inbox.push({ id: randomUUID(), objectiveId: id, questionId: question.id, questionRevision: question.revision, answer: input.answer, at: this.now() });
      objective.question = null; objective.status = objective.steps.length ? "scheduled" : "needs_plan"; this.event(draft, objective, "answered"); return objective;
    });
  }
  private reserveInto(snapshot: ObjectiveSnapshot, input: z.infer<typeof ReserveBudgetSchema>, id = randomUUID()): BudgetReservation {
    const prior = snapshot.reservations.find(item => item.requestId === input.requestId);
    if (prior) {
      if (prior.objectiveId !== input.objectiveId || prior.projectId !== input.projectId || prior.authority !== input.authority || micros(prior.reservedUsd) !== micros(input.estimatedUsd)) throw new BridgeError("Budget request ID was reused.", 409);
      return prior;
    }
    const now = this.now(), reserved = micros(input.estimatedUsd), sum = (filter: (entry: BudgetReservation) => boolean) => snapshot.reservations.filter(filter).reduce((value, entry) => value + charge(entry), 0);
    if (reserved > 0 && (reserved + sum(entry => entry.createdAt.slice(0, 10) === now.slice(0, 10)) > 10_000_000 || reserved + sum(entry => entry.createdAt.slice(0, 7) === now.slice(0, 7)) > 300_000_000)) throw new BridgeError("Daily or monthly estimated-cost admission limit reached.", 409);
    if (input.objectiveId) {
      const objective = this.object(snapshot, input.objectiveId, input.projectId);
      if (reserved > 0 && reserved + sum(entry => entry.objectiveId === objective.id) > micros(objective.budget.limitUsd)) throw new BridgeError("Cumulative objective estimate budget exhausted.", 409);
    }
    const reservation: BudgetReservation = { id, requestId: input.requestId, objectiveId: input.objectiveId, projectId: input.projectId,
      authority: input.authority, createdAt: now, reservedUsd: dollars(reserved), chargedUsd: 0, accounting: "reserved" };
    snapshot.reservations.push(reservation); return reservation;
  }
  reserve(raw: unknown): Promise<BudgetReservation> { const input = ReserveBudgetSchema.parse(raw); return this.mutate(draft => { const result = this.reserveInto(draft, input); if (input.objectiveId) this.event(draft, this.object(draft, input.objectiveId, input.projectId), "observed"); return result; }); }
  private settleInto(reservation: BudgetReservation, accounting: "measured" | "unknown", estimatedUsd: number | null): void {
    if (accounting === "unknown" || estimatedUsd === null) { if (reservation.accounting !== "measured") reservation.accounting = "unknown"; return; }
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0 || estimatedUsd > 10_000) throw new BridgeError("Invalid measured cost.", 400);
    if (reservation.accounting === "measured" && micros(reservation.chargedUsd) !== micros(estimatedUsd)) throw new BridgeError("Settled accounting cannot be rewritten.", 409);
    reservation.chargedUsd = dollars(micros(estimatedUsd)); reservation.accounting = "measured";
  }
  settle(id: string, input: { accounting: "measured" | "unknown"; estimatedUsd: number | null }): Promise<BudgetReservation> {
    return this.mutate(draft => { const entry = draft.reservations.find(value => value.id === id); if (!entry) throw new BridgeError("Reservation not found.", 404);
      this.settleInto(entry, input.accounting, input.estimatedUsd); if (entry.objectiveId) this.event(draft, this.object(draft, entry.objectiveId, entry.projectId), "observed"); return entry; });
  }
  readiness() {
    const now = this.now(), sum = (length: number) => dollars(this.snapshot.reservations.filter(entry => entry.createdAt.slice(0, length) === now.slice(0, length)).reduce((value, entry) => value + charge(entry), 0));
    return { version: 1 as const, enabled: this.enabled, ready: this.enabled && !this.closed && !this.failed, stopped: this.stopping,
      activeWorkers: this.snapshot.objectives.flatMap(value => value.attempts).filter(activeAttempt).length, maxWorkers: 2,
      dailyLimitUsd: 10, monthlyLimitUsd: 300, dailyCommittedUsd: sum(10), monthlyCommittedUsd: sum(7),
      unknownReservations: this.snapshot.reservations.filter(entry => entry.accounting === "unknown").length,
      nextWakeAt: this.snapshot.objectives.filter(value => value.status === "scheduled" && value.wakeAt).map(value => value.wakeAt!).sort()[0] ?? null,
      reason: this.failed ? "persistence_failed" : this.closed ? "closed" : !this.enabled ? "disabled" : this.stopping ? "stopped" : null };
  }
  async dispatch(): Promise<number> {
    this.requireReady(); if (this.stopping) return 0;
    const work = await this.mutate(draft => {
      const selected: { objectiveId: string; attemptId: string }[] = []; let slots = 2 - draft.objectives.flatMap(value => value.attempts).filter(activeAttempt).length;
      for (const objective of draft.objectives) {
        if (!["scheduled", "running", "waiting_for_device"].includes(objective.status) || objective.question || objective.cancelRequested) continue;
        if (Date.parse(objective.deadlineAt) - Date.parse(this.now()) < 1_000) { objective.status = "expired"; this.event(draft, objective, "observed"); continue; }
        if (objective.wakeAt && Date.parse(objective.wakeAt) > Date.parse(this.now())) continue;
        for (const step of objective.steps) {
          if (slots < 1 || objective.attempts.some(attempt => attempt.stepId === step.id) || !step.dependsOn.every(id => objective.attempts.some(attempt => attempt.stepId === id && attempt.status === "completed" && attempt.accounting === "measured"))) continue;
          if (!this.options.adapters?.[step.authority]) { const error = `No budget-enforcing ${step.authority} adapter is configured.`;
            if (objective.lastError !== error || objective.status !== "waiting_for_device") { objective.lastError = error; objective.status = "waiting_for_device"; this.event(draft, objective, "observed"); } continue; }
          const id = randomUUID(), startedAt = this.now();
          try { this.reserveInto(draft, { requestId: id, objectiveId: objective.id, projectId: objective.projectId, authority: step.authority, estimatedUsd: step.estimatedUsd }, id); }
          catch (error) { if (!(error instanceof BridgeError && error.status === 409)) throw error;
            if (objective.lastError !== error.message) { objective.lastError = error.message; this.event(draft, objective, "observed"); } continue; }
          objective.attempts.push({ id, stepId: step.id, authority: step.authority, status: "dispatching", child: null, startedAt,
            deadlineAt: new Date(Math.min(Date.parse(startedAt) + step.maxWallTimeMs, Date.parse(objective.deadlineAt))).toISOString(), updatedAt: startedAt,
            reservedUsd: step.estimatedUsd, chargedUsd: 0, accounting: "reserved", cancelConfirmed: false, detail: null });
          slots--; objective.status = "running"; objective.wakeAt = null; objective.lastError = null;
          this.event(draft, objective, "observed"); selected.push({ objectiveId: objective.id, attemptId: id });
        }
      }
      return selected;
    });
    for (const item of work) this.launch(item.objectiveId, item.attemptId);
    return work.length;
  }
  private launch(objectiveId: string, attemptId: string): void {
    const objective = this.snapshot.objectives.find(item => item.id === objectiveId)!, attempt = objective.attempts.find(item => item.id === attemptId)!, step = objective.steps.find(item => item.id === attempt.stepId)!;
    const controller = new AbortController(); this.controllers.set(attemptId, controller);
    const timer = setTimeout(() => controller.abort(new Error("Bounded child dispatch deadline exceeded")), Math.max(1, Date.parse(attempt.deadlineAt) - Date.parse(this.now()))); timer.unref();
    const promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted(); if (this.stopping || this.failed) throw new Error("Dispatch stopped before receipt");
      const boundedStep = { ...structuredClone(step), maxWallTimeMs: Math.max(1_000, Math.min(step.maxWallTimeMs, Date.parse(attempt.deadlineAt) - Date.parse(this.now()))) };
      const operation = this.options.adapters![step.authority]!.dispatch({ objectiveId, projectId: objective.projectId, attemptId, step: boundedStep,
        checkpoint: structuredClone(objective.checkpoint), answers: structuredClone(this.snapshot.inbox.filter(item => item.objectiveId === objectiveId)) }, controller.signal);
      // An adapter that ignores abort must not hold the scheduler forever. A late
      // exact receipt is still adopted and reconciled, never dispatched again.
      void operation.then(async result => { if (controller.signal.aborted && !this.closed && !this.failed) { await this.observe(objectiveId, attemptId, result); await this.reconcile(); } }).catch(() => {});
      const result = await bounded(operation, controller.signal);
      await this.observe(objectiveId, attemptId, result);
    }).catch(async error => {
      if (this.failed || this.closed) return;
      if (error instanceof ObjectiveDispatchRejected) await this.mutate(draft => {
        const objective = draft.objectives.find(item => item.id === objectiveId)!, attempt = objective.attempts.find(item => item.id === attemptId)!;
        if (attempt.child) return;
        this.settleInto(draft.reservations.find(item => item.id === attemptId)!, "measured", 0);
        attempt.status = "failed"; attempt.accounting = "measured"; attempt.detail = "Child admission was rejected before execution.";
        objective.status = objective.cancelRequested ? "cancelled" : "failed"; objective.lastError = attempt.detail; this.event(draft, objective, "observed");
      });
      else await this.unknown(objectiveId, attemptId, "Child dispatch did not yield a verified durable receipt; no automatic retry.");
    })
      .finally(() => { clearTimeout(timer); this.operations.delete(attemptId); this.controllers.delete(attemptId); });
    this.operations.set(attemptId, promise); void promise.catch(() => {});
  }
  private unknown(objectiveId: string, attemptId: string, detail: string) {
    return this.mutate(draft => { const objective = draft.objectives.find(item => item.id === objectiveId)!, attempt = objective.attempts.find(item => item.id === attemptId)!;
      if (terminal.has(attempt.status) && attempt.accounting === "measured") return;
      attempt.status = "unknown"; attempt.accounting = "unknown"; attempt.detail = detail; attempt.updatedAt = this.now();
      this.settleInto(draft.reservations.find(item => item.id === attemptId)!, "unknown", null);
      objective.status = "interrupted"; objective.lastError = detail; this.event(draft, objective, "observed"); });
  }
  private async observe(objectiveId: string, attemptId: string, raw: unknown): Promise<void> {
    const result = ChildObservationSchema.parse(raw); this.sensitive(result);
    await this.mutate(draft => {
      const objective = draft.objectives.find(item => item.id === objectiveId)!, attempt = objective.attempts.find(item => item.id === attemptId)!;
      if (result.ref.authority !== attempt.authority || result.ref.projectId !== objective.projectId || attempt.child && canonicalJson(attempt.child) !== canonicalJson(result.ref)) throw new BridgeError("Child observation scope or identity mismatch.", 409);
      attempt.child = result.ref; attempt.status = result.status; attempt.cancelConfirmed = result.cancelConfirmed; attempt.detail = result.detail; attempt.updatedAt = this.now();
      const settled = terminal.has(result.status) && (result.status !== "cancelled" || result.cancelConfirmed);
      if (settled) this.settleInto(draft.reservations.find(item => item.id === attemptId)!, result.accounting, result.estimatedUsd);
      const reservation = draft.reservations.find(item => item.id === attemptId)!;
      attempt.accounting = reservation.accounting; attempt.chargedUsd = reservation.chargedUsd;
      if (result.checkpoint) { this.checkpointBinding(objective, result.checkpoint); objective.checkpoint = result.checkpoint; }
      if (objective.cancelRequested) objective.status = objective.attempts.some(activeAttempt) ? "interrupted" : "cancelled";
      else if (result.status === "unknown" || settled && reservation.accounting !== "measured") objective.status = "interrupted";
      else if (!["paused", "cancelled", "expired"].includes(objective.status)) {
        if (objective.attempts.some(item => item.status === "failed" || item.status === "cancelled")) objective.status = "failed";
        else if (objective.steps.every(step => objective.attempts.some(item => item.stepId === step.id && item.status === "completed" && item.accounting === "measured"))) objective.status = "completed";
        else if (objective.question || objective.attempts.some(item => item.status === "waiting")) objective.status = "waiting_for_user";
        else objective.status = "scheduled";
      }
      this.event(draft, objective, "observed");
    });
  }
  async reconcile(): Promise<void> {
    this.requireReady();
    await this.mutate(draft => {
      for (const objective of draft.objectives) {
        if (!["completed", "failed", "cancelled", "expired"].includes(objective.status) && Date.parse(objective.deadlineAt) <= Date.parse(this.now())) {
          objective.status = "expired"; objective.question = null; objective.lastError = "Objective horizon expired; no new work was admitted."; this.event(draft, objective, "observed");
        } else if (objective.question && Date.parse(objective.question.expiresAt) <= Date.parse(this.now())) {
          objective.question = null; objective.status = "paused"; objective.lastError = "Clarification expired. Review before explicitly continuing."; this.event(draft, objective, "observed");
        }
      }
    });
    const targets = this.snapshot.objectives.flatMap(objective => objective.attempts.filter(attempt => activeAttempt(attempt) && attempt.child && !this.operations.has(attempt.id) && !this.reconciling.has(attempt.id)).map(attempt => ({ objective, attempt })));
    await Promise.all(targets.map(async ({ objective, attempt }) => {
      const adapter = this.options.adapters?.[attempt.authority]; if (!adapter) return;
      this.reconciling.add(attempt.id);
      const signal = AbortSignal.timeout(5_000);
      try {
        const expired = this.stopping || objective.cancelRequested || ["cancelled", "expired"].includes(objective.status) || Date.parse(attempt.deadlineAt) <= Date.parse(this.now());
        await this.observe(objective.id, attempt.id, await bounded(expired ? adapter.cancel(attempt.child!, signal) : adapter.inspect(attempt.child!, signal), signal));
      } catch { if (!this.failed && !this.closed) await this.unknown(objective.id, attempt.id, "Child observation or cancellation is unconfirmed."); }
      finally { this.reconciling.delete(attempt.id); }
    }));
  }
  async stop(id?: string, raw?: unknown, projectId?: string): Promise<Objective | void> {
    if (!this.enabled) return;
    const revision = id ? ObjectiveRevisionSchema.parse(raw).expectedRevision : undefined;
    if (!id) { this.stopping = true; clearTimeout(this.timer); this.timer = undefined; }
    await this.mutate(draft => {
      const targets = id ? [this.object(draft, id, projectId!)] : draft.objectives.filter(item => !["completed", "failed", "cancelled"].includes(item.status));
      for (const objective of targets) { if (revision !== undefined) this.cas(objective, revision); objective.cancelRequested = true; objective.status = "cancelled"; objective.question = null; this.event(draft, objective, "stopped"); }
    });
    for (const [attemptId, controller] of this.controllers) if (!id || this.snapshot.objectives.find(item => item.id === id)?.attempts.some(item => item.id === attemptId)) controller.abort();
    await this.reconcile();
    const targets = this.snapshot.objectives.filter(item => !id || item.id === id);
    if (targets.some(objective => objective.attempts.some(activeAttempt))) throw new BridgeError("Objective cancellation is unconfirmed; retained reservations and child receipts require reconciliation.", 503);
    if (id) return this.get(id, projectId!);
  }
  startLoop(intervalMs = 1_000): void {
    this.requireReady(); if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error("Invalid objective scheduler interval");
    this.stopping = false; if (this.timer) return;
    const tick = async () => {
      if (this.closed || this.failed || this.stopping) return;
      if (!this.ticking) { this.ticking = true; try { await this.reconcile(); await this.dispatch(); } catch {} finally { this.ticking = false; } }
      if (!this.closed && !this.failed && !this.stopping) { this.timer = setTimeout(() => void tick(), intervalMs); this.timer.unref(); }
    };
    this.timer = setTimeout(() => void tick(), 0); this.timer.unref();
  }
  async drain(): Promise<void> { await Promise.all([...this.operations.values()]); await this.queue; }
  async close(): Promise<void> {
    clearTimeout(this.timer); this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    if (this.enabled && !this.failed) { try { await this.reconcile(); } catch {} }
    await this.queue; this.closed = true; this.listeners.clear(); this.store.close();
  }
}
