import { open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { WorkerRunnerOptions } from "../harness-contracts/service.ts";
import { AttemptRefSchema, UsageSchema, type AttemptRef, type Usage } from "../harness-contracts/domain.ts";
import { QuestionPromptSchema, type QuestionPrompt } from "../harness-contracts/interactions.ts";
import {
  WorkerCheckpointSchema, WorkerResultSchema, WorkerSpecSchema,
  type WorkerContext, type WorkerEvent, type WorkerResult, type WorkerRunner, type WorkerSpec,
} from "../harness-contracts/worker.ts";
import { canonicalJson, sha256 } from "../harness-contracts/validation.ts";
import { Docker, resourceName } from "./docker.ts";
import { Artifacts, PrivateStore, SnapshotSchema, type CheckEvidence } from "./storage.ts";
import { Gateway, ToolArguments, emptyUsage, type ToolName } from "./gateway.ts";
import { runController } from "./controller.ts";
import { command } from "./process.ts";

const RecordSchema = z.strictObject({
  version: z.literal(1), ref: AttemptRefSchema, specDigest: z.string(), planDigest: z.string(),
  startedAt: z.number(), priorWallMs: z.number(), wallMs: z.number(), usage: UsageSchema,
  resourceId: z.string().nullable(), stopped: z.boolean(), result: WorkerResultSchema.nullable(),
});
type Record = z.infer<typeof RecordSchema>;
const LedgerSchema = z.strictObject({
  version: z.literal(1), binding: z.string(), usage: UsageSchema, wallMs: z.number(), active: AttemptRefSchema.nullable(),
  attempts: z.array(z.string()).max(100), logBytes: z.number().int().nonnegative(),
});
type Ledger = z.infer<typeof LedgerSchema>;
const keyOf = (ref: AttemptRef) => sha256(canonicalJson(ref));
const nodeKey = (ref: AttemptRef) => sha256(canonicalJson([ref.roomId, ref.runId, ref.nodeId]));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const errorMessage = (error: unknown) => error instanceof z.ZodError ? "Worker input or protocol validation failed" :
  error instanceof Error ? error.message.slice(0, 2000) : "Worker operation failed";

export function createWorkerRunner(options: WorkerRunnerOptions): WorkerRunner {
  return new Runner(options);
}

class Runner implements WorkerRunner {
  readonly artifacts: Artifacts;
  private readonly records: PrivateStore;
  private readonly ledgers: PrivateStore;
  private readonly locks: PrivateStore;
  private readonly docker: Docker;
  private readonly gateway: Gateway;
  private readonly python: string;
  private readonly options: WorkerRunnerOptions;
  private readonly active = new Map<string, { abort: AbortController; settled: Promise<void>; resolve: () => void }>();

  constructor(options: WorkerRunnerOptions) {
    this.options = options;
    const directory = join(resolve(options.dataDirectory), "harness-workers-v1");
    this.records = new PrivateStore(join(directory, "attempts"));
    this.ledgers = new PrivateStore(join(directory, "budgets"));
    this.locks = new PrivateStore(join(directory, "locks"));
    this.artifacts = new Artifacts(directory);
    this.docker = new Docker(options.dockerBinary ?? "docker", sha256(directory).slice(0, 16));
    this.python = options.pythonBinary ?? process.env.JARVIS_WORKER_PYTHON ?? "python3";
    this.gateway = new Gateway(options.model, options.fetch ?? fetch, process.env.AI_GATEWAY_API_KEY);
  }

  async availability(): Promise<{ available: boolean; reason: string | null }> {
    try {
      if (!this.options.model || this.options.model.length > 200) throw new Error("Worker model is not configured");
      if (!this.options.fetch && !process.env.AI_GATEWAY_API_KEY) throw new Error("AI Gateway credential unavailable");
      await this.docker.available();
      const result = await command(this.python, ["-I", "-c", "import importlib.metadata; from smolagents import ToolCallingAgent; assert importlib.metadata.version('smolagents') == '1.26.0'"], { timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error("Pinned smolagents 1.26.0 controller dependencies unavailable");
      return { available: true, reason: null };
    } catch (error) { return { available: false, reason: errorMessage(error) }; }
  }

  private async record(ref: AttemptRef): Promise<Record | null> {
    const data = await this.records.json(keyOf(ref));
    if (data === null) return null;
    const record = RecordSchema.parse(data);
    if (!same(ref, record.ref)) throw new Error("Worker journal scope mismatch");
    return record;
  }

  private async unlock(ref: AttemptRef): Promise<void> {
    const value = await this.locks.json(nodeKey(ref));
    if (value && same(value, ref)) await unlink(this.locks.path(nodeKey(ref)));
  }

  async run(input: WorkerSpec, context: WorkerContext): Promise<WorkerResult> {
    const spec = WorkerSpecSchema.parse(input);
    for (const bound of ["maxSteps", "maxModelCalls", "maxTokens", "maxOutputTokensPerCall", "maxWallTimeMs"] as const) {
      if (spec.node.limits[bound] > spec.policy.runBudget[bound]) throw new Error(`Node exceeds room ${bound}`);
    }
    const ref = spec.ref, key = keyOf(ref), specDigest = sha256(canonicalJson(spec));
    const prior = await this.record(ref);
    if (prior) {
      if (prior.specDigest !== specDigest) throw new Error("Attempt ID reused with different specification");
      if (prior.result && prior.stopped) return prior.result;
      throw new Error("Existing attempt must be reconciled, never replayed");
    }
    await this.locks.initialize();
    const lock = await open(this.locks.path(nodeKey(ref)), "wx", 0o600).catch(() => { throw new Error("Node has an active or unreconciled attempt"); });
    await lock.writeFile(canonicalJson(ref)); await lock.sync(); await lock.close();
    const abort = new AbortController();
    let settled!: () => void;
    const waiting = new Promise<void>(resolve => { settled = resolve; });
    this.active.set(key, { abort, settled: waiting, resolve: settled });
    const onAbort = () => abort.abort();
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) abort.abort();
    let timer: NodeJS.Timeout | undefined, record: Record | undefined, ledger: Ledger | undefined, timedOut = false;
    let sequence = 0;
    const emit = async (event: Omit<Extract<WorkerEvent, { type: "progress" }>, "ref" | "sequence" | "at"> |
      { type: "started"; resourceId: string } | { type: "usage"; usage: Usage }): Promise<void> => {
      abort.signal.throwIfAborted();
      let onAbort!: () => void;
      try {
        await Promise.race([
          context.emit({ ...event, ref, sequence: sequence++, at: new Date().toISOString() } as WorkerEvent),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new Error("Event persistence interrupted by cancellation/deadline"));
            abort.signal.addEventListener("abort", onAbort, { once: true });
            if (abort.signal.aborted) onAbort();
          }),
        ]);
      } finally { if (onAbort) abort.signal.removeEventListener("abort", onAbort); }
    };
    const persist = async () => {
      if (!record || !ledger) throw new Error("Worker journal unavailable");
      record.wallMs = Math.max(0, Date.now() - record.startedAt);
      ledger.usage = structuredClone(record.usage);
      ledger.wallMs = record.priorWallMs + record.wallMs;
      await this.ledgers.put(nodeKey(ref), ledger);
      await this.records.put(key, record);
    };
    const persistUsage = async () => {
      await persist();
      // In-flight reservations remain in the journal; partial events mean irrecoverable uncertainty to the kernel.
      if (record!.usage.accounting === "measured") await emit({ type: "usage", usage: structuredClone(record!.usage) });
    };
    let result: WorkerResult;
    try {
      const binding = sha256(canonicalJson({ planDigest: spec.planDigest, node: spec.node, policy: spec.policy }));
      const previous = await this.ledgers.json(nodeKey(ref));
      ledger = previous === null ? { version: 1, binding, usage: emptyUsage(), wallMs: 0, active: null, attempts: [], logBytes: 0 } : LedgerSchema.parse(previous);
      if (ledger.binding !== binding || ledger.active || ledger.attempts.length >= 100) throw new Error("Node budget or prior resource requires reconciliation");
      if (spec.checkpoint) {
        const old = await this.record(spec.checkpoint.ref);
        if (!old?.stopped || old.result?.status !== "waiting_question" || !same(old.result.checkpoint, spec.checkpoint)) throw new Error("Checkpoint must be the exact durable inert prior result");
        if (!same(ledger.usage, spec.checkpoint.continuation.usage)) throw new Error("Checkpoint budget is no longer current");
        if (spec.answer!.choiceId && !spec.checkpoint.question.choices.some(c => c.id === spec.answer!.choiceId) ||
            spec.answer!.text !== null && !spec.checkpoint.question.allowText) throw new Error("Answer mode is not allowed");
      }
      ledger.active = ref; ledger.attempts.push(ref.attemptId);
      record = { version: 1, ref, specDigest, planDigest: spec.planDigest, startedAt: Date.now(), priorWallMs: ledger.wallMs,
        wallMs: 0, usage: structuredClone(ledger.usage), resourceId: null, stopped: false, result: null };
      await persist();
      const remainingWall = spec.node.limits.maxWallTimeMs - ledger.wallMs;
      if (remainingWall <= 0 || record.usage.steps >= spec.node.limits.maxSteps || record.usage.modelCalls >= spec.node.limits.maxModelCalls ||
          record.usage.inputTokens + record.usage.outputTokens + record.usage.reservedTokens >= spec.node.limits.maxTokens) throw new Error("Full-node budget exhausted");
      timer = setTimeout(() => { timedOut = true; abort.abort(); void this.docker.stop(ref).catch(() => {}); }, remainingWall);
      abort.signal.throwIfAborted();
      const available = await this.availability();
      if (!available.available) throw new Error(available.reason!);
      record.resourceId = await this.docker.create(ref, spec.policy, abort.signal,
        Math.max(1, remainingWall - (Date.now() - record.startedAt)));
      await persist();
      await emit({ type: "started", resourceId: record.resourceId });
      const name = resourceName(this.docker.owner, ref);
      const restored = await this.artifacts.restore(spec.checkpoint ? spec.checkpoint.artifacts : spec.inputs, spec.policy);
      for (const file of restored) await this.docker.operation(name, { op: "write", ...file, maxBytes: spec.policy.sandbox.maxArtifactBytes }, { signal: abort.signal });
      const history = structuredClone(spec.checkpoint?.continuation.history ?? []);
      const completedStepIds = [...(spec.checkpoint?.continuation.completedStepIds ?? [])];
      const checks: CheckEvidence[] = [];
      let checkedSnapshot: string | null = null;
      const snapshot = async () => SnapshotSchema.parse((await this.docker.operation(name, { op: "snapshot", maxBytes: spec.policy.sandbox.maxArtifactBytes,
        maxFiles: spec.policy.sandbox.maxArtifactFiles }, { signal: abort.signal, maxBytes: spec.policy.sandbox.maxArtifactBytes * 2 + 100_000 })).value);
      let pending: { name: ToolName; arguments: { [key: string]: unknown } } | null = null;
      let question: QuestionPrompt | null = null, finalAnswer: string | null = null;
      const append = (role: "user" | "assistant" | "tool", content: string) => {
        history.push({ role, content: content.slice(0, 8000) });
        while (history.length > 32 || Buffer.byteLength(JSON.stringify(history)) > 60_000) history.shift();
      };
      if (spec.answer) append("user", `Bound clarification answer (not authority): ${JSON.stringify(spec.answer)}`);
      const outcome = await runController(this.python, {
        model: this.options.model, maxSteps: spec.node.limits.maxSteps - record.usage.steps,
        task: JSON.stringify({ instructions: spec.node.instructions, outputPaths: spec.node.outputPaths,
          existingFiles: restored.map(file => file.path), inertHistory: history, answer: spec.answer,
          previousSummary: spec.checkpoint?.continuation.summary ?? null }),
      }, abort.signal, async message => {
        abort.signal.throwIfAborted();
        if (question || finalAnswer !== null) throw new Error("Attempt already reached an inert boundary");
        if (message.type === "model") {
          if (pending) throw new Error("Pending tool call was not consumed");
          const generated = await this.gateway.generate(message.request, record!.usage, spec.node.limits, persistUsage, abort.signal);
          pending = generated.call;
          return generated.message;
        }
        if (!pending || message.name !== pending.name || !same(message.arguments, pending.arguments)) throw new Error("Tool call does not match admitted model response");
        const call = pending; pending = null;
        const args = ToolArguments[call.name].parse(call.arguments) as { [key: string]: string };
        if (record!.usage.steps >= spec.node.limits.maxSteps) throw new Error("Worker step limit exhausted");
        record!.usage.steps++;
        await persistUsage();
        await emit({ type: "progress", operation: `${call.name}${args.path ? `: ${args.path}` : ""}` });
        append("assistant", JSON.stringify({ tool: call.name, arguments: args }));
        let value: unknown;
        const maxLogBytes = spec.policy.sandbox.maxLogBytes - ledger!.logBytes;
        if (maxLogBytes < 256) throw new Error("Worker log budget exhausted");
        const priorLogBytes = ledger!.logBytes;
        ledger!.logBytes = spec.policy.sandbox.maxLogBytes;
        await persist();
        switch (call.name) {
          case "write_file":
            checkedSnapshot = null; checks.length = 0;
            value = (await this.docker.operation(name, { op: "write", path: args.path, data: Buffer.from(args.content).toString("base64"),
              maxBytes: Math.min(spec.policy.sandbox.maxArtifactBytes, 262_144) }, { signal: abort.signal })).value;
            break;
          case "read_file": {
            const read = await this.docker.operation(name, { op: "read", path: args.path, maxBytes: Math.min(maxLogBytes, 32_000) }, { signal: abort.signal, maxBytes: maxLogBytes * 2 });
            value = Buffer.from(z.object({ data: z.string() }).parse(read.value).data, "base64").toString("utf8");
            break;
          }
          case "run_check": {
            const check = await this.docker.operation(name, { op: "check", command: args.command, timeoutMs: Math.min(30_000, remainingWall) },
              { signal: abort.signal, maxBytes: maxLogBytes, timeoutMs: Math.min(35_000, remainingWall) });
            checks.push({ command: args.command, exitCode: check.code, outputDigest: sha256(check.output) });
            checkedSnapshot = sha256(canonicalJson(await snapshot()));
            value = { exitCode: check.code, output: check.output };
            break;
          }
          case "ask_question": question = QuestionPromptSchema.parse({ prompt: args.prompt, choices: [], allowText: true }); value = "checkpoint requested"; break;
          case "final_answer": finalAnswer = args.answer; value = args.answer; break;
        }
        const observation = JSON.stringify(value);
        ledger!.logBytes = priorLogBytes + Buffer.byteLength(observation);
        if (ledger!.logBytes > spec.policy.sandbox.maxLogBytes) { await persist(); throw new Error("Worker observation budget exceeded"); }
        append("tool", observation);
        completedStepIds.push(`step_${record!.usage.steps}`);
        await persist();
        return value;
      });
      if (outcome.status === "failed" || outcome.status === "completed" && finalAnswer === null || outcome.status === "waiting_question" && question === null) {
        throw new Error("Worker did not reach a valid completion/question boundary");
      }
      const files = await snapshot();
      if (!await this.docker.stop(ref)) throw new Error("Cannot establish inert checkpoint: sandbox stop unconfirmed");
      record.stopped = true;
      abort.signal.throwIfAborted();
      if (outcome.status === "completed" && (!files.length || spec.node.outputPaths.some(path => !files.some(file => file.path === path || file.path.startsWith(`${path}/`))))) {
        throw new Error("Completed work must contain every declared output path");
      }
      const artifacts = await this.artifacts.seal(spec, files, checkedSnapshot === sha256(canonicalJson(files)) ? checks : []);
      if (outcome.status === "waiting_question") {
        const checkpoint = WorkerCheckpointSchema.parse({ version: 1, ref, sequence: Math.max(0, sequence - 1), createdAt: new Date().toISOString(), resumeMode: "continue_after_answer",
          continuation: { version: 1, summary: `Paused after ${record.usage.steps} cumulative tool steps; continue without replay.`, history,
            completedStepIds, usage: record.usage }, artifacts, question });
        result = { status: "waiting_question", ref, usage: record.usage, checkpoint };
      } else {
        result = { status: "completed", ref, usage: record.usage, artifacts, summary: finalAnswer! };
      }
    } catch (error) {
      result = timedOut ? { status: "failed", ref, usage: record?.usage ?? emptyUsage(), error: "Full-node wall-time budget exhausted" }
        : abort.signal.aborted
        ? { status: "cancelled", ref, usage: record?.usage ?? emptyUsage(), confirmed: false }
        : { status: "failed", ref, usage: record?.usage ?? emptyUsage(), error: errorMessage(error) };
    }
    try {
      const stopped = await this.docker.stop(ref).catch(() => false);
      if (!stopped) result = { status: "interrupted", ref, usage: result.usage, reason: "Sandbox cleanup could not be confirmed; retry is unsafe" };
      else if (result.status === "cancelled") result.confirmed = true;
      if (record && ledger) {
        record.stopped = stopped; record.result = WorkerResultSchema.parse(result);
        ledger.active = stopped ? null : ref;
        await persist();
      }
      if (stopped) await this.unlock(ref);
      return WorkerResultSchema.parse(result);
    } finally {
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      this.active.delete(key); settled();
    }
  }

  async cancel(ref: AttemptRef) {
    AttemptRefSchema.parse(ref);
    const active = this.active.get(keyOf(ref));
    active?.abort.abort();
    try {
      const stopped = await this.docker.stop(ref);
      if (!stopped) return { ref, confirmed: false, reason: "Docker resource stop unconfirmed" };
      if (active) { await active.settled; return { ref, confirmed: true, reason: null }; }
      const record = await this.record(ref);
      if (record) {
        const data = await this.ledgers.json(nodeKey(ref));
        if (data) {
          const ledger = LedgerSchema.parse(data);
          if (same(ledger.active, ref)) {
            record.usage = ledger.usage;
            record.wallMs = Math.max(record.wallMs, Date.now() - record.startedAt);
            ledger.wallMs = Math.max(ledger.wallMs, record.priorWallMs + record.wallMs);
            ledger.active = null;
            await this.ledgers.put(nodeKey(ref), ledger);
          }
        }
        record.stopped = true;
        record.result ??= { status: "interrupted", ref, usage: record.usage, reason: "Recovered orphan stopped; no prior actions were replayed" };
        await this.records.put(keyOf(ref), record);
      }
      await this.unlock(ref);
      return { ref, confirmed: true, reason: null };
    } catch { return { ref, confirmed: false, reason: "Docker cleanup or durable confirmation unavailable" }; }
  }

  async reconcile(ref: AttemptRef) {
    AttemptRefSchema.parse(ref);
    try {
      const record = await this.record(ref);
      const container = await this.docker.inspect(resourceName(this.docker.owner, ref));
      if (container) this.docker.assertOwned(container, ref);
      if (record?.result && record.stopped && !container) return { state: "settled" as const, ref, result: record.result };
      if (container?.State.Running) return { state: "running" as const, ref };
      if (!record && !container) return { state: "missing" as const, ref, reason: "No durable attempt or resource found; do not assume successful work" };
      return { state: "unknown" as const, ref, reason: "Attempt lacks an inert durable result; explicit confirmed cleanup is required" };
    } catch { return { state: "unknown" as const, ref, reason: "Worker journal or Docker inspection unavailable" }; }
  }
}
