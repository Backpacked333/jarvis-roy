import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ensurePrivateDirectory } from "../agent/lib/persistence.ts";
import { CLOUD_MODEL_BUDGET_VERSION, CLOUD_MODEL_MAX_CALL_MS, CLOUD_MODEL_MAX_OUTPUT_TOKENS,
  ModelReservationInput, ModelSettlementInput, cloudInputTokenBound } from "../agent/lib/cloud-budget-contracts.ts";
import { gatewayPrices, matchesPricedModel, type GatewayPrices } from "./gateway-pricing.ts";
import { readBoundedJson } from "./harness-interactions/gateway.ts";
import { BridgeError } from "./errors.ts";
import type { JarvisService } from "./service.ts";
import type { ObjectiveService } from "./objectives/index.ts";

const RecordSchema = z.strictObject({
  callId: z.string(), sessionId: z.string(), taskId: z.string(), projectId: z.string(), model: z.string(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
  rates: z.strictObject({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative() }),
  reservedUsd: z.number().finite().nonnegative(), chargedUsd: z.number().finite().nonnegative(),
  reservationId: z.string().nullable(), status: z.enum(["intent", "reserved", "measured", "unknown"]),
  settlement: ModelSettlementInput.optional(),
});
type ModelCallRecord = z.infer<typeof RecordSchema>;
const SnapshotSchema = z.strictObject({ version: z.literal(1), calls: z.array(RecordSchema).max(10_000) });
type Snapshot = z.infer<typeof SnapshotSchema>;
export interface ModelBudgetPersistence {
  open(directory: string): Promise<Snapshot>; save(snapshot: Snapshot): void; close(): void;
}
/** No prompt, generated text, credentials or tool arguments are stored here. */
export class ModelBudgetStore implements ModelBudgetPersistence {
  private db?: DatabaseSync;
  async open(directory: string): Promise<Snapshot> {
    const parent = join(directory, "model-budget"); await ensurePrivateDirectory(parent);
    const file = join(parent, "model-budget.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe model budget database"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = this.db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported model budget schema; a backed-up migration is required");
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned model budget database is not empty");
        db.exec("CREATE TABLE snapshot(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL); PRAGMA user_version=1;");
        db.prepare("INSERT INTO snapshot VALUES(1,?)").run(JSON.stringify({ version: 1, calls: [] }));
      }
      const body = db.prepare("SELECT body FROM snapshot WHERE id=1").get()?.body;
      if (typeof body !== "string" || Buffer.byteLength(body) > 16_777_216) throw new Error("Invalid model budget state");
      const snapshot = SnapshotSchema.parse(JSON.parse(body));
      if (new Set(snapshot.calls.map(call => call.callId)).size !== snapshot.calls.length) throw new Error("Duplicate model budget call");
      db.exec("COMMIT"); return snapshot;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} this.close(); throw error; }
  }
  save(snapshot: Snapshot): void {
    if (!this.db) throw new Error("Model budget database closed");
    const body = JSON.stringify(SnapshotSchema.parse(snapshot));
    if (Buffer.byteLength(body) > 16_777_216) throw new Error("Model budget history is full");
    this.db.prepare("UPDATE snapshot SET body=? WHERE id=1").run(body);
  }
  close(): void { this.db?.close(); this.db = undefined; }
}
export interface ModelBudgetOptions {
  dataDirectory: string; model: string; enabled?: boolean;
  service: Pick<JarvisService, "contextForEveSession">;
  objectives: Pick<ObjectiveService, "readiness" | "reserve" | "settle">;
  fetch?: typeof fetch; now?: () => Date; store?: ModelBudgetPersistence;
  /** Bridge-owned liveness test. Model JSON cannot choose project/task scope. */
  canAdmit?: (taskId: string) => boolean;
}
const rounded = (value: number) => Math.ceil(value * 1_000_000) / 1_000_000;
const cost = (rates: GatewayPrices, input: number, output: number) => rounded(rates.input * input + rates.output * output);

export class ModelBudgetRuntime {
  readonly enabled: boolean;
  private readonly options: ModelBudgetOptions;
  private readonly store: ModelBudgetPersistence;
  private state: Snapshot = { version: 1, calls: [] };
  private queue = Promise.resolve();
  private failed = false;
  private stopped = false;
  private closed = false;
  private pricing?: { rates: GatewayPrices; at: number };
  private constructor(options: ModelBudgetOptions) { this.options = options; this.enabled = options.enabled ?? process.env.JARVIS_RUNTIME_PROFILE === "cloud"; this.store = options.store ?? new ModelBudgetStore(); }
  static async open(options: ModelBudgetOptions): Promise<ModelBudgetRuntime> {
    const runtime = new ModelBudgetRuntime(options);
    if (!runtime.enabled) return runtime;
    try {
      runtime.state = await runtime.store.open(options.dataDirectory);
      // Even an intent may have reserved shared funds before this process died.
      // No call or accounting transition is replayed across restart.
      if (runtime.state.calls.some(call => call.status === "intent" || call.status === "reserved")) {
        const next = structuredClone(runtime.state);
        for (const call of next.calls) if (call.status === "intent" || call.status === "reserved") call.status = "unknown";
        runtime.save(next);
      }
      return runtime;
    } catch (error) { runtime.store.close(); throw error; }
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private save(next: Snapshot): void {
    if (this.failed || this.closed) throw new BridgeError("Model accounting requires recovery.", 503);
    SnapshotSchema.parse(next);
    try { this.store.save(next); } catch { this.failed = true; throw new BridgeError("Model accounting persistence failed; further admission is fenced.", 503); }
    this.state = structuredClone(next);
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.then(() => {}, () => {}); return result;
  }
  readiness() {
    const ledger = this.options.objectives.readiness();
    const unresolved = this.state.calls.some(call => call.status === "unknown" || (call.status === "reserved" || call.status === "intent") && Date.parse(call.expiresAt) <= this.now().getTime());
    return { version: CLOUD_MODEL_BUDGET_VERSION, ready: this.enabled && !this.failed && !this.closed && !this.stopped && !unresolved && ledger.ready && !ledger.stopped,
      enabled: this.enabled, model: this.options.model, estimatedTurnLimitUsd: 5, maxCallsPerTurn: 32, maxTurnWallTimeMs: 30 * 60_000,
      maxOutputTokens: CLOUD_MODEL_MAX_OUTPUT_TOKENS, unknownAccounting: unresolved, bufferedUntilAccounting: true,
      reason: !this.enabled ? "disabled" : this.failed ? "persistence_failed" : this.closed ? "closed" : this.stopped || ledger.stopped ? "stopped" : unresolved ? "unknown_accounting" : !ledger.ready ? "ledger_unavailable" : null };
  }
  private async rates(): Promise<GatewayPrices> {
    const now = this.now().getTime();
    if (this.pricing && now - this.pricing.at >= 0 && now - this.pricing.at < 300_000) return this.pricing.rates;
    const signal = AbortSignal.timeout(10_000);
    const response = await (this.options.fetch ?? fetch)("https://ai-gateway.vercel.sh/v1/models", { redirect: "error", signal });
    if (!response.ok) { await response.body?.cancel(); throw new BridgeError("Known Gateway pricing is required before a model call.", 503); }
    const rates = gatewayPrices(await readBoundedJson(response, signal, 8_000_000), this.options.model);
    this.pricing = { rates, at: now }; return rates;
  }
  async reserve(raw: unknown, sessionId: string) {
    const input = ModelReservationInput.parse(raw);
    return this.serialized(async () => {
      if (!this.readiness().ready) throw new BridgeError("Cloud model budget is not ready.", 403);
      const scope = this.options.service.contextForEveSession(sessionId);
      if (!scope) throw new BridgeError("Agent task binding is not committed yet.", 425);
      if (this.options.canAdmit && !this.options.canAdmit(scope.taskId)) throw new BridgeError("Agent task is no longer active.", 403);
      if (input.model !== this.options.model) throw new BridgeError("Unpriced model selection is forbidden.", 403);
      if (this.state.calls.some(call => call.callId === input.callId)) throw new BridgeError("Model call IDs cannot be replayed.", 409);
      const taskCalls = this.state.calls.filter(call => call.taskId === scope.taskId);
      const now = this.now(), first = taskCalls[0];
      if (taskCalls.length >= 32 || first && now.getTime() - Date.parse(first.createdAt) >= 30 * 60_000 ||
          this.state.calls.filter(call => call.status === "reserved" || call.status === "intent").length >= 2) throw new BridgeError("Cloud model call count, time or concurrency limit reached.", 403);
      const rates = await this.rates();
      if (!this.readiness().ready || this.options.canAdmit && !this.options.canAdmit(scope.taskId)) throw new BridgeError("Cloud model admission stopped.", 403);
      const maxInputTokens = cloudInputTokenBound(input.promptBytes), reservedUsd = cost(rates, maxInputTokens, input.maxOutputTokens);
      const committed = taskCalls.reduce((sum, call) => sum + (call.status === "measured" ? call.chargedUsd : call.reservedUsd), 0);
      if (rounded(committed + reservedUsd) > 5) throw new BridgeError("Cumulative cloud turn estimate exceeds five dollars.", 403);
      const record: ModelCallRecord = { callId: input.callId, sessionId, taskId: scope.taskId, projectId: scope.projectId,
        model: input.model, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + CLOUD_MODEL_MAX_CALL_MS).toISOString(),
        maxInputTokens, maxOutputTokens: input.maxOutputTokens, rates, reservedUsd, chargedUsd: 0, reservationId: null, status: "intent" };
      const next = structuredClone(this.state); next.calls.push(record); this.save(next);
      try {
        const reservation = await this.options.objectives.reserve({ requestId: `model-${input.callId}`, objectiveId: null,
          projectId: scope.projectId, authority: "eve_model", estimatedUsd: reservedUsd });
        record.reservationId = reservation.id; record.status = "reserved"; this.save(next);
        if (!this.readiness().ready || this.options.canAdmit && !this.options.canAdmit(scope.taskId)) throw new BridgeError("Cloud model admission stopped.", 403);
        return { version: 1 as const, callId: record.callId, maxInputTokens, maxOutputTokens: record.maxOutputTokens, expiresAt: record.expiresAt };
      } catch (error) {
        // Reservation rejection may be definitive, but a lost durable receipt
        // cannot be distinguished here. Hold the intent and deny further calls.
        if (!this.failed) { record.status = "unknown"; this.save(next); }
        throw error;
      }
    });
  }
  async settle(raw: unknown, sessionId: string) {
    const input = ModelSettlementInput.parse(raw);
    return this.serialized(async () => {
      if (!this.enabled || this.failed || this.closed) throw new BridgeError("Cloud model accounting unavailable.", 503);
      const next = structuredClone(this.state), record = next.calls.find(call => call.callId === input.callId && call.sessionId === sessionId);
      if (!record) throw new BridgeError("Model reservation not found in this agent session.", 403);
      if (record.status === "measured") {
        if (input.accounting === "measured" && JSON.stringify(record.settlement) !== JSON.stringify(input)) throw new BridgeError("Model accounting cannot be rewritten.", 409);
        return { version: 1 as const, callId: input.callId, accounted: true as const };
      }
      if (record.status !== "reserved" || !record.reservationId) throw new BridgeError("Model accounting is uncertain and cannot be replayed.", 403);
      // AI SDK metadata may carry the provider's short model ID. Only the exact
      // requested publisher/name (or its documented fast+priority alias) counts.
      const modelId = input.accounting === "measured" && !input.modelId.includes("/") ? `${record.model.split("/")[0]}/${input.modelId}` : input.accounting === "measured" ? input.modelId : "";
      const known = input.accounting === "measured" && matchesPricedModel(record.model, { model: modelId, service_tier: input.serviceTier });
      try {
        if (!known || input.accounting !== "measured") {
          await this.options.objectives.settle(record.reservationId, { accounting: "unknown", estimatedUsd: null });
          record.status = "unknown"; record.settlement = input; this.save(next);
          throw new BridgeError("Unknown model identity or usage; further calls are fenced.", 403);
        }
        record.chargedUsd = cost(record.rates, input.inputTokens, input.outputTokens);
        await this.options.objectives.settle(record.reservationId, { accounting: "measured", estimatedUsd: record.chargedUsd });
        const exceeded = input.inputTokens > record.maxInputTokens || input.outputTokens > record.maxOutputTokens || record.chargedUsd > record.reservedUsd;
        record.status = exceeded ? "unknown" : "measured"; record.settlement = input; this.save(next);
        if (exceeded) throw new BridgeError("Observed usage exceeded its admission bound; further calls are fenced.", 403);
        return { version: 1 as const, callId: input.callId, accounted: true as const };
      } catch (error) {
        if (!this.failed && record.status === "reserved") { record.status = "unknown"; this.save(next); }
        throw error;
      }
    });
  }
  async route(method: string, url: URL, body: unknown, context: { sessionId?: string }) {
    if (!url.pathname.startsWith("/v1/model-budget/")) return null;
    if (method === "GET" && url.pathname === "/v1/model-budget/readiness") return { status: 200, body: this.readiness() };
    if (!context.sessionId) throw new BridgeError("A bound Eve session is required for model accounting.", 403);
    if (method === "POST" && url.pathname === "/v1/model-budget/reserve") return { status: 200, body: await this.reserve(body, context.sessionId) };
    if (method === "POST" && url.pathname === "/v1/model-budget/settle") return { status: 200, body: await this.settle(body, context.sessionId) };
    throw new BridgeError("Model budget route not found.", 404);
  }
  stop(): void { this.stopped = true; }
  resume(): void { this.stopped = false; }
  async close(): Promise<void> { this.stopped = true; await this.queue; this.closed = true; this.store.close(); }
}
