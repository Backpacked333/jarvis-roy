import { createHash, randomUUID } from "node:crypto";
import { configuredModel } from "../agent/lib/model.ts";
import { containsCredentialLikeData, deleteMemory, listMemories } from "../agent/lib/memory.ts";
import { BridgeError, errorMessage } from "./errors.ts";
import { redactText } from "./redaction.ts";
import { reviewArguments } from "./approval.ts";
import { CONVERSATION_ID, TaskStore } from "./store.ts";
import { HarnessApprovalSchema, type HarnessApproval } from "./harness-contracts/interactions.ts";
import { inspectEveInteraction } from "./harness-interactions/eve-safety.ts";
import { isSafeClarificationAnswer, isSafeClarificationText } from "./harness-interactions/clarification-safety.ts";
import type {
  Approval,
  BridgeState,
  Conversation,
  ConversationRecord,
  EveClient,
  EveDelivery,
  EveEvent,
  EveSession,
  Memory,
  Task,
  TaskRecord,
  TaskStatus,
} from "./types.ts";

const ACTIVE_STATUSES = new Set<TaskStatus>(["starting", "running", "waiting", "interrupted"]);
const MAX_ACTIVE_TASKS = 4;
const MAX_EVENTS_PER_TASK = 100;
const MAX_MESSAGE_LENGTH = 20_000;
const CANCEL_TIMEOUT_MS = 15_000;
const BLOCKED_QUESTION_TITLE = "Question blocked";
const BLOCKED_QUESTION_DETAIL = "This question cannot be answered here. Stop the task and request a non-sensitive clarification.";
const BLOCKED_QUESTION_REASON = "This question was blocked by the clarification safety policy.";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function titleFromMessage(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] ?? "Jarvis task";
  const firstSentence = firstLine.split(/(?<=[.!?])\s/, 1)[0] ?? firstLine;
  return redactText(firstSentence).slice(0, 120) || "Jarvis task";
}

function isSafeRootQuestion(card: { title: unknown; detail: unknown; options: unknown }): boolean {
  const safeText = (value: unknown): value is string => typeof value === "string" &&
    isSafeClarificationText(value) && !value.includes("[REDACTED]");
  return safeText(card.title) && safeText(card.detail) && Array.isArray(card.options) &&
    card.options.every((option) => safeText(asRecord(option).id) && safeText(asRecord(option).label));
}

function projectQuestion(card: Approval): Approval {
  if (card.kind === "question" && (card.reviewable === false || !isSafeRootQuestion(card))) {
    return { id: card.id, kind: "question", revision: card.revision, expiresAt: card.expiresAt,
      title: BLOCKED_QUESTION_TITLE, detail: BLOCKED_QUESTION_DETAIL, blockedReason: BLOCKED_QUESTION_REASON,
      reviewable: false, allowText: false, options: [] };
  }
  return { ...card, options: card.options.map((option) => ({ ...option })) };
}

function publicTask(record: TaskRecord): Task {
  return {
    id: record.id,
    conversationId: record.conversationId!,
    userMessage: record.userMessage ?? null,
    title: record.title,
    status: record.status,
    reply: record.reply,
    ...(record.lateReply ? { lateReply: record.lateReply } : {}),
    ...(record.error ? { error: record.error } : {}),
    createdAt: record.createdAt,
    events: [...record.events],
    approvals: record.approvals.filter((a) => a.kind === "approval").map((approval) => ({
      ...approval,
      options: approval.options.map((option) => ({ ...option })),
    })),
    questions: record.approvals.filter((a) => a.kind !== "approval").map(projectQuestion),
  };
}

function publicConversation(record: ConversationRecord): Conversation {
  return {
    id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
    messages: record.messages.map((message) => ({ ...message })),
  };
}

function pendingOptionsFromTask(task: TaskRecord): Map<string, Set<string>> {
  return new Map(
    task.approvals.map((approval) => [
      approval.id,
      new Set(approval.options.map((option) => option.id)),
    ]),
  );
}

function eventSignature(event: EveEvent): string {
  const position = event.meta?.position;
  if (position) return `${position.line}:${position.index}`;
  return `${event.type}:${JSON.stringify(event.data)}`;
}

export class JarvisService {
  readonly model: string;
  private readonly store: TaskStore;
  private readonly client: EveClient;
  private readonly sessions = new Map<string, EveSession>();
  private readonly deliveryObservers = new Map<string, Promise<void>>();
  private readonly pendingSessions = new Map<
    string,
    Promise<{ session: EveSession; delivery: EveDelivery }>
  >();
  private readonly cancelOperations = new Map<string, Promise<void>>();
  private readonly sessionCancelOperations = new Map<string, Promise<void>>();
  private readonly pendingOptions = new Map<string, Map<string, Set<string>>>();
  private readonly submittingInteractions = new Set<string>();
  private readonly callInputs = new Map<string, Map<string, { name: string; input?: unknown }>>();
  private readonly seenEvents = new Map<string, Set<string>>();
  private stopping = false;
  private admissionGeneration = 0;
  private admissions: Promise<unknown> = Promise.resolve();
  private readonly taskListeners = new Set<(tasks: Task[]) => void>();
  private readonly speechParts = new Map<string, Map<string, { kind: string; text: string }>>();
  private previewTimer?: NodeJS.Timeout;
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly backgroundOperations = new Set<Promise<void>>();

  private constructor(store: TaskStore, client: EveClient, model: string) {
    this.store = store;
    this.client = client;
    this.model = model;
    store.subscribe(() => this.emitTaskUpdates());
  }

  static async create(options: {
    dataDirectory?: string;
    client: EveClient;
    model?: string;
  }): Promise<JarvisService> {
    const store = new TaskStore(options.dataDirectory);
    await store.initialize();
    return new JarvisService(
      store,
      options.client,
      options.model ?? configuredModel(),
    );
  }

  async state(): Promise<BridgeState> {
    let ready = false;
    let error: string | undefined;
    try {
      const health = asRecord(await this.client.health());
      ready = health.status === "ready" || health.ok === true;
      if (!ready) error = "The eve runtime is not ready.";
    } catch (cause) {
      error = redactText(errorMessage(cause));
    }

    let memories: Memory[];
    try {
      memories = await listMemories(this.store.dataDirectory);
    } catch (cause) {
      error ??= redactText(errorMessage(cause));
      memories = [];
    }

    return {
      ready,
      model: this.model,
      tasks: this.store.values()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(publicTask),
      conversations: this.store.conversations()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(publicConversation),
      memories,
      ...(error ? { error } : {}),
    };
  }

  async createConversation(title?: string): Promise<Conversation> {
    if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 120)) {
      throw new BridgeError("Conversation title must contain 1–120 characters.", 400);
    }
    if (title && containsCredentialLikeData(title)) {
      throw new BridgeError("Conversation titles containing credential-like data cannot be persisted.", 400);
    }
    const now = new Date().toISOString();
    const conversation: ConversationRecord = {
      id: randomUUID(), title: title?.trim() ?? "New conversation",
      autoTitle: title === undefined,
      createdAt: now, updatedAt: now, messages: [],
    };
    await this.store.addConversation(conversation);
    this.pruneCaches();
    return publicConversation(conversation);
  }

  createTask(message: string, conversationId?: string, projectId?: string): Promise<Task> {
    const generation = this.admissionGeneration;
    const operation = this.admissions.then(() => {
      if (generation !== this.admissionGeneration || this.stopping) throw new BridgeError("Task admission was cancelled by Stop all. Submit a fresh request.", 409);
      return this.createTaskAdmitted(message, conversationId, projectId);
    });
    this.admissions = operation.then(() => {}, () => {});
    return operation;
  }

  private async createTaskAdmitted(message: string, conversationId?: string, projectId?: string): Promise<Task> {
    if (this.stopping) throw new BridgeError("Tasks are stopping. Wait for cancellation confirmation.", 409);
    if (conversationId !== undefined &&
      (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId) ||
        !this.store.conversation(conversationId))) {
      throw new BridgeError("Conversation not found. Create a conversation before sending to it.", 404);
    }
    if (message.trim().length === 0 || message.length > MAX_MESSAGE_LENGTH) {
      throw new BridgeError("Message must contain 1–20000 characters.", 400);
    }
    if (containsCredentialLikeData(message)) {
      throw new BridgeError("Messages containing credential-like data cannot be persisted.", 400);
    }
    if (projectId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(projectId)) throw new BridgeError("Invalid project scope.", 400);
    const priorScope = conversationId ? this.store.conversation(conversationId)?.projectId : undefined;
    if (priorScope && projectId && priorScope !== projectId) throw new BridgeError("A conversation cannot change its private project scope.", 409);
    projectId ??= priorScope;
    if (conversationId && this.store.values().some((task) =>
      task.conversationId === conversationId && (task.approvals.length > 0 || ACTIVE_STATUSES.has(task.status) ||
        (task.observingDeliveries ?? 0) > 0 ||
        this.cancelOperations.has(task.id) || this.sessionCancelOperations.has(task.id) ||
        this.pendingSessions.has(task.id)))) {
      throw new BridgeError("This conversation has an active or unconfirmed turn. Wait for it to finish, or Stop its task and confirm cancellation before sending again.", 409);
    }
    const activeCount = this.store.values()
      .filter((task) => ACTIVE_STATUSES.has(task.status)).length;
    if (activeCount >= MAX_ACTIVE_TASKS) {
      throw new BridgeError("Jarvis already has four active or unconfirmed tasks.", 409);
    }

    const task: TaskRecord = {
      id: randomUUID(),
      conversationId: conversationId ?? randomUUID(),
      ...(projectId ? { projectId } : {}),
      userMessage: message,
      title: titleFromMessage(message),
      status: "starting",
      reply: "",
      createdAt: new Date().toISOString(),
      events: [],
      approvals: [],
      childTasks: {},
      ...(conversationId && this.store.conversation(conversationId)?.sessionId
        ? { sessionId: this.store.conversation(conversationId)!.sessionId } : {}),
    };
    // Admissions are serialized; failed persistence never publishes or dispatches a turn.
    await this.store.add(task);
    this.pruneCaches();
    this.pendingOptions.set(task.id, new Map());
    this.callInputs.set(task.id, new Map());
    this.seenEvents.set(task.id, new Set());
    const ready = Promise.resolve().then(async () => {
      if (!task.sessionId) return this.client.sessions.create({ message });
      const session = this.client.sessions.attach(task.sessionId);
      if (session.id !== task.sessionId) throw new Error("Eve attached the wrong session. Stop the runtime and restore its session store before continuing.");
      this.sessions.set(task.id, session);
      if (!session.send) throw new Error("The Eve client does not support conversation follow-ups. Install the pinned runtime and restart Jarvis.");
      return { session, delivery: await session.send(message) };
    });
    this.pendingSessions.set(task.id, ready);
    const observation = ready.then(async ({ session, delivery }) => {
      this.pendingSessions.delete(task.id);
      await this.store.bindSession(task.id, session.id);
      this.sessions.set(task.id, session);
      const observation = this.observeDelivery(task.id, delivery);
      if (this.store.get(task.id)?.cancelRequested) await this.requestCancellation(task.id, session);
      await observation;
    }).catch(async (cause) => {
      this.pendingSessions.delete(task.id);
      await this.store.update(task.id, (record) => {
        const status = asRecord(cause).status;
        const rejected = typeof status === "number" && status >= 400 && status < 500 && status !== 408;
        record.status = rejected ? "failed" : "interrupted";
        record.error = rejected
          ? `Eve rejected this message. Check runtime access; if the saved session has ended, create a new conversation. ${redactText(errorMessage(cause))}`
          : `Message submission or observation is unconfirmed. Stop this task before sending again. ${redactText(errorMessage(cause))}`;
      });
    });
    this.trackBackground(observation);
    return publicTask(task);
  }

  async respond(
    taskId: string,
    interactionId: string,
    optionId: string,
    expectedRevision?: number,
    text?: string,
  ): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) throw new BridgeError("Task not found.", 404);
    if (this.stopping || this.cancelOperations.has(taskId)) {
      throw new BridgeError("The task is being cancelled.", 409);
    }
    const card = task.approvals.find((item) => item.id === interactionId);
    if (!card || (expectedRevision !== undefined && expectedRevision !== card.revision) ||
      (card.expiresAt !== undefined && Date.parse(card.expiresAt) <= Date.now())) {
      throw new BridgeError("This exact card has expired or changed. Refresh before responding.", 409);
    }
    if (card.kind !== "approval" && card.kind !== "question") throw new BridgeError("Unsupported interaction kind. Stop the task rather than guessing a response.", 409);
    if (card.kind === "question") {
      if (card.reviewable === false || !isSafeRootQuestion(card)) throw new BridgeError(BLOCKED_QUESTION_DETAIL, 409);
      if (!isSafeClarificationAnswer({ text: text ?? null, choiceId: text === undefined ? optionId : null })) {
        throw new BridgeError("This question cannot accept that answer. Use only non-sensitive clarification details.", 400);
      }
    }
    if (text !== undefined && (card.kind !== "question" || !card.allowText || !text.trim() || text.length > 16_000 || containsCredentialLikeData(text))) {
      throw new BridgeError("This card does not allow that text answer. Never enter secrets.", 400);
    }
    if (card.reviewable === false && optionId !== "deny") {
      throw new BridgeError("This request cannot be fully reviewed. Only denial is allowed.", 409);
    }
    const options = this.pendingOptions.get(taskId) ?? pendingOptionsFromTask(task);
    const allowed = options.get(interactionId);
    const submissionKey = `${taskId}:${interactionId}`;
    if (!allowed || (text === undefined && !allowed.has(optionId)) || this.submittingInteractions.has(submissionKey)) {
      throw new BridgeError("That response is not currently pending.", 409);
    }
    const session = this.sessions.get(taskId);
    if (!session || task.status !== "waiting") {
      throw new BridgeError("The task is not waiting for a response.", 409);
    }

    this.submittingInteractions.add(submissionKey);
    try {
      const delivery = await session.respond([{ interactionId, ...(text === undefined ? { optionId } : { text }) }]);
      this.trackBackground(this.observeDelivery(taskId, delivery));
      return publicTask(task);
    } catch (cause) {
      this.submittingInteractions.delete(submissionKey);
      throw new BridgeError(redactText(errorMessage(cause)), 502);
    }
  }

  async cancel(taskId: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) throw new BridgeError("Task not found.", 404);
    if (!ACTIVE_STATUSES.has(task.status)) return publicTask(task);

    const existing = this.cancelOperations.get(taskId);
    if (existing) {
      await existing;
      return publicTask(task);
    }

    const cancellation = this.cancelActiveTask(taskId);
    this.cancelOperations.set(taskId, cancellation);
    try {
      await cancellation;
    } finally {
      this.cancelOperations.delete(taskId);
      await this.store.update(taskId, (record) => { record.cancellationPending = false; });
    }
    return publicTask(task);
  }

  async stop(): Promise<Task[]> {
    if (this.stopping) throw new BridgeError("Stop is already in progress.", 409);
    this.stopping = true;
    this.admissionGeneration++;
    try {
    await this.admissions;
    const active = this.store.values()
      .filter((task) => ACTIVE_STATUSES.has(task.status))
      .map((task) => task.id);
    const outcomes = await Promise.allSettled(active.map((id) => this.cancel(id)));
    if (outcomes.some((outcome) => outcome.status === "rejected")) throw new BridgeError("Some task cancellation operations failed; check status before retrying.", 503);
    return active.map((id) => this.store.get(id)).filter(
      (task): task is TaskRecord => task !== undefined,
    ).map(publicTask);
    } finally { this.stopping = false; }
  }

  harnessApprovals(): HarnessApproval[] {
    return this.store.values().filter((task) => task.status === "waiting").flatMap((task) =>
      task.approvals.filter((card) => card.kind === "approval").map((card) => {
        const result = HarnessApprovalSchema.safeParse({ kind: "approval", id: `root-${createHash("sha256").update(`${task.id}:${card.id}`).digest("hex")}`,
          roomId: null, runId: null, nodeId: null, taskId: task.id, interactionId: card.id, revision: card.revision ?? 1,
          title: card.title.slice(0, 200), detail: card.detail, status: card.expiresAt && Date.parse(card.expiresAt) <= Date.now() ? "expired" : "pending",
          reviewable: card.reviewable === true, blockedReason: card.blockedReason ?? null, options: card.options });
        return result.success ? result.data : null;
      }).filter((card): card is HarnessApproval => card !== null));
  }

  async removeMemory(id: string): Promise<boolean> {
    return deleteMemory(id, this.store.dataDirectory);
  }

  async waitForObservedDelivery(taskId: string): Promise<void> {
    while (this.deliveryObservers.has(taskId)) await this.deliveryObservers.get(taskId);
  }

  /** After admission closes, wait for trailing observations and durable writes, including
   * completed tasks and deliveries superseded in the per-task cancellation lookup. */
  async drain(): Promise<void> {
    await this.admissions;
    let failed = false;
    while (true) {
      const pending = [...this.backgroundOperations, ...this.eventQueues.values(),
        ...this.cancelOperations.values(), ...this.sessionCancelOperations.values()];
      if (!pending.length) break;
      if ((await Promise.allSettled(pending)).some(result => result.status === "rejected")) failed = true;
    }
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    if (failed) throw new BridgeError("Some task observations did not finish durably. Restart reconciliation is required.", 503);
  }

  private trackBackground(operation: Promise<void>): void {
    this.backgroundOperations.add(operation);
    void operation.then(() => this.backgroundOperations.delete(operation), () => this.backgroundOperations.delete(operation));
  }

  taskSnapshot(): Task[] { return this.store.values().map(record => {
    const task = publicTask(record);
    const preview = [...(this.speechParts.get(record.id)?.values() ?? [])].filter(part => part.kind === "text").map(part => part.text).join("\n");
    return preview && !record.cancelRequested && ["starting", "running"].includes(record.status) ? { ...task, speechPreview: preview.slice(0, 24_000) } : task;
  }); }

  contextForEveSession(sessionId: string): { taskId: string; conversationId: string; projectId: string } | undefined {
    const task = this.store.values().filter(task => task.sessionId === sessionId)
      .at(-1); // Persisted insertion order follows admission, even if the wall clock repeats or moves backward.
    if (!task?.conversationId) return undefined;
    return { taskId: task.id, conversationId: task.conversationId, projectId: task.projectId ?? task.conversationId };
  }

  /** Explicit user messages are independently submitted context. Never recycle
   * assistant prose here: it can contain excerpts whose grants were revoked. */
  contextSnapshot(projectId: string, conversationId?: string, taskId?: string) {
    const conversation = conversationId ? this.store.conversation(conversationId) : undefined;
    if (conversationId && (!conversation || (conversation.projectId ?? conversation.id) !== projectId)) {
      throw new BridgeError("Conversation context is outside this project.", 403);
    }
    const task = taskId ? this.store.get(taskId) : undefined;
    if (taskId && (!task || task.conversationId !== conversationId || (task.projectId ?? task.conversationId) !== projectId)) {
      throw new BridgeError("Task context is outside this conversation.", 403);
    }
    return {
      currentTurn: task?.userMessage ?? "",
      messages: structuredClone((conversation?.messages ?? []).filter(message => message.role === "user" && message.taskId !== taskId).slice(-60)),
      actions: this.store.values().filter(record => (record.projectId ?? record.conversationId) === projectId &&
        (ACTIVE_STATUSES.has(record.status) || record.approvals.length > 0 || record.cancellationPending))
        .map(record => ({ id: record.id, conversationId: record.conversationId!, status: record.status,
          title: record.title, pendingApprovals: record.approvals.length, createdAt: record.createdAt })),
    };
  }

  hasUnsettledProjectWork(projectId: string): boolean {
    return this.store.values().some(task => (task.projectId ?? task.conversationId) === projectId && (
      ACTIVE_STATUSES.has(task.status) || task.approvals.length > 0 ||
      task.status === "cancelled" && !task.cancelConfirmed || task.cancellationPending ||
      (task.observingDeliveries ?? 0) > 0 || this.pendingSessions.has(task.id) ||
      this.cancelOperations.has(task.id) || this.sessionCancelOperations.has(task.id) ||
      [...this.submittingInteractions].some(key => key.startsWith(`${task.id}:`))
    ));
  }

  async cancelProjectWork(projectId: string): Promise<void> {
    const targets = this.store.values().filter(task => (task.projectId ?? task.conversationId) === projectId &&
      ACTIVE_STATUSES.has(task.status)).map(task => task.id);
    const outcomes = await Promise.allSettled(targets.map(id => this.cancel(id)));
    if (outcomes.some(result => result.status === "rejected") || this.hasUnsettledProjectWork(projectId)) {
      throw new BridgeError("Project task cancellation is unconfirmed. Inspect task status before continuing.", 503);
    }
  }

  subscribeTasks(listener: (tasks: Task[]) => void): () => void {
    this.taskListeners.add(listener);
    return () => this.taskListeners.delete(listener);
  }

  private emitTaskUpdates(): void {
    const tasks = this.taskSnapshot();
    for (const listener of this.taskListeners) { try { listener(structuredClone(tasks)); } catch { /* UI observers cannot invalidate a commit. */ } }
  }

  private async cancelActiveTask(taskId: string): Promise<void> {
    await this.store.update(taskId, (task) => {
      task.cancelRequested = true;
      task.cancellationPending = true;
      task.error = undefined;
    });

    let session = this.sessions.get(taskId);
    const pending = this.pendingSessions.get(taskId);
    if (pending) {
      try {
        let timer: NodeJS.Timeout | undefined;
        const created = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Timed out waiting for the eve session.")), CANCEL_TIMEOUT_MS);
            timer.unref();
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        session = created.session;
      } catch (cause) {
        await this.store.update(taskId, (task) => {
          if (ACTIVE_STATUSES.has(task.status)) {
            task.error = `Cancellation is unconfirmed: ${redactText(errorMessage(cause))}`;
          }
        });
        if (!session) return;
      }
    }

    if (!session) {
      const sessionId = this.store.get(taskId)?.sessionId;
      if (sessionId) {
        try {
          session = this.client.sessions.attach(sessionId);
          this.sessions.set(taskId, session);
        } catch (cause) {
          await this.store.update(taskId, (task) => {
            if (ACTIVE_STATUSES.has(task.status)) {
              task.error = `Cancellation is unconfirmed: ${redactText(errorMessage(cause))}`;
            }
          });
          return;
        }
      }
    }

    if (!session) {
      await this.store.update(taskId, (task) => {
        if (ACTIVE_STATUSES.has(task.status)) {
          task.error = task.status === "interrupted"
            ? "Cancellation is unconfirmed because this interrupted task has no saved eve session ID."
            : "Cancellation is unconfirmed because the eve session is not available.";
        }
      });
      return;
    }
    await this.requestCancellation(taskId, session);
  }

  private async requestCancellation(taskId: string, session: EveSession): Promise<void> {
    const existing = this.sessionCancelOperations.get(taskId);
    if (existing) return existing;

    const cancellation = this.performCancellation(taskId, session);
    this.sessionCancelOperations.set(taskId, cancellation);
    try {
      await cancellation;
    } finally {
      this.sessionCancelOperations.delete(taskId);
    }
  }

  private async performCancellation(taskId: string, session: EveSession): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || !ACTIVE_STATUSES.has(task.status)) return;
    const signal = AbortSignal.timeout(CANCEL_TIMEOUT_MS);
    try {
      const receipt = await session.cancel({
        ...(task.turnId ? { turnId: task.turnId } : {}),
        signal,
      });
      let sawTurnCancellation = false;
      const observed = (async () => {
        for await (const rawEvent of receipt.stream({ signal })) {
          const event = rawEvent as EveEvent;
          if (event.type === "turn.settled" && event.data.outcome === "cancelled" &&
            this.eventBelongsToTask(taskId, event)) {
            sawTurnCancellation = true;
          }
          await this.handleEvent(taskId, event);
        }
      })();
      const result = await receipt.result({ signal });
      await observed;
      const current = this.store.get(taskId);
      if (current?.status === "cancelled" || sawTurnCancellation) {
        await this.store.update(taskId, (record) => {
          const unfinishedChildren = Object.values(record.childTasks)
            .some((child) => child.outcome === undefined);
          record.cancelConfirmed = true;
          record.status = unfinishedChildren ? "interrupted" : "cancelled";
          record.error = unfinishedChildren
            ? "The parent turn cancellation was confirmed, but one or more child-task endings were not confirmed."
            : undefined;
        });
        const deliveryObserver = this.deliveryObservers.get(taskId);
        if (deliveryObserver) {
          let onAbort: (() => void) | undefined;
          const abortWait = new Promise<void>((resolve) => {
            onAbort = () => resolve();
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            await Promise.race([deliveryObserver, abortWait]);
          } finally {
            if (onAbort) signal.removeEventListener("abort", onAbort);
          }
          if (this.deliveryObservers.has(taskId)) {
            await this.store.update(taskId, (record) => {
              record.status = "interrupted";
              record.error = "Turn cancellation was confirmed, but the original delivery is still unobserved. Retry Stop after the runtime is reachable before continuing this conversation.";
            });
          }
        }
        return;
      }
      if (!ACTIVE_STATUSES.has(current?.status ?? "interrupted")) return;
      const outcome = asRecord(result).outcome;
      await this.store.update(taskId, (record) => {
        record.error = outcome === "applied"
          ? "Eve applied the cancellation request but did not confirm that the task turn stopped."
          : "Eve did not confirm that the task turn stopped.";
      });
    } catch (cause) {
      const current = this.store.get(taskId);
      if (current && ACTIVE_STATUSES.has(current.status)) {
        await this.store.update(taskId, (record) => {
          record.error = `Cancellation is unconfirmed: ${redactText(errorMessage(cause))}`;
        });
      }
    }
  }

  private async consumeDelivery(taskId: string, delivery: EveDelivery): Promise<void> {
    try {
      for await (const rawEvent of delivery.stream()) {
        await this.handleEvent(taskId, rawEvent as EveEvent);
      }
      const result = asRecord(await delivery.result());
      await this.store.update(taskId, (task) => {
        const reply = stringValue(result.reply);
        if (task.cancelConfirmed) {
          if (reply) task.lateReply = redactText(reply);
          return;
        }
        if (reply !== undefined) task.reply = redactText(reply);
        if (result.status === "completed") {
          task.status = "completed";
          task.error = undefined;
          task.approvals = [];
        } else if (result.status === "awaiting-input") {
          task.status = "waiting";
        } else if (result.status === "failed") {
          task.status = "failed";
          task.error = redactText(errorMessage(asRecord(result.error).message));
          task.approvals = [];
        } else if (result.status === "cancelled") {
          task.cancelConfirmed = true;
          task.status = Object.values(task.childTasks).some((child) => child.outcome === undefined)
            ? "interrupted" : "cancelled";
          task.error = task.status === "interrupted"
            ? "The parent turn cancellation was confirmed, but one or more child-task endings were not confirmed."
            : undefined;
          task.approvals = [];
        }
      });
    } catch (cause) {
      await this.store.update(taskId, (task) => {
        if (task.cancelConfirmed) return;
        if (ACTIVE_STATUSES.has(task.status)) {
          task.status = "interrupted";
          task.error = `Session observation was interrupted; the outcome is unknown. ${redactText(errorMessage(cause))}`;
          task.approvals = [];
        }
      });
    }
  }

  private async observeDelivery(taskId: string, delivery: EveDelivery): Promise<void> {
    const observation = (async () => {
      await this.store.update(taskId, (task) => {
        task.observingDeliveries = (task.observingDeliveries ?? 0) + 1;
      });
      try {
        await this.consumeDelivery(taskId, delivery);
      } finally {
        await this.store.update(taskId, (task) => {
          task.observingDeliveries = Math.max(0, (task.observingDeliveries ?? 1) - 1);
        });
      }
    })();
    this.trackBackground(observation);
    this.deliveryObservers.set(taskId, observation);
    try {
      await observation;
    } finally {
      if (this.deliveryObservers.get(taskId) === observation) {
        this.deliveryObservers.delete(taskId);
      }
      this.pruneCaches();
    }
  }

  private handleEvent(taskId: string, event: EveEvent): Promise<void> {
    const operation = (this.eventQueues.get(taskId) ?? Promise.resolve()).then(() => this.handleAdmittedEvent(taskId, event));
    const settled = operation.then(() => {}, () => {});
    this.eventQueues.set(taskId, settled);
    void settled.then(() => { if (this.eventQueues.get(taskId) === settled) this.eventQueues.delete(taskId); });
    return operation;
  }

  private async handleAdmittedEvent(taskId: string, event: EveEvent): Promise<void> {
    if (!event || typeof event.type !== "string") return;
    if (!this.eventBelongsToTask(taskId, event)) return;
    if (event.type === "content.delta") {
      const data = asRecord(event.data), partId = stringValue(data.partId);
      if (!partId || typeof data.delta !== "string" || this.store.get(taskId)?.cancelRequested) return;
      const parts = this.speechParts.get(taskId) ?? new Map<string, { kind: string; text: string }>();
      const existing = parts.get(partId), kind = stringValue(data.kind) ?? existing?.kind;
      // Reasoning/internal/tool parts are never presented or spoken.
      if (kind !== "text" || (!existing && parts.size >= 20)) return;
      parts.set(partId, { kind, text: redactText((existing?.text ?? "") + data.delta).slice(0, 24_000) });
      this.speechParts.set(taskId, parts);
      this.previewTimer ??= setTimeout(() => { this.previewTimer = undefined; this.emitTaskUpdates(); }, 100);
      this.previewTimer.unref();
      return;
    }
    const seen = new Set(this.seenEvents.get(taskId) ?? []);
    const signature = eventSignature(event);
    if (seen.has(signature)) return;
    seen.add(signature);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);

    const data = asRecord(event.data);
    const callInputs = new Map(this.callInputs.get(taskId) ?? []);
    const pending = new Map(this.pendingOptions.get(taskId) ?? []);
    const releasedInteractions: string[] = [];
    let clearInteractions = false;
    const settledInteractions: string[] = [];

    await this.store.update(taskId, (task) => {
      const append = (message: string) => {
        const clean = redactText(message).slice(0, 2_000);
        task.events = [...task.events, clean].slice(-MAX_EVENTS_PER_TASK);
      };
      const markUnconfirmedChild = () => {
        if (task.cancelConfirmed) {
          task.status = "interrupted";
          task.error = "The parent turn cancellation was confirmed, but one or more child-task endings were not confirmed.";
        }
      };

      switch (event.type) {
        case "delivery.consumed": {
          task.turnId ??= stringValue(data.turnId);
          break;
        }
        case "turn.started": {
          task.turnId ??= stringValue(data.turnId);
          if (ACTIVE_STATUSES.has(task.status) && !task.cancelConfirmed) task.status = "running";
          append("Turn started.");
          break;
        }
        case "turn.paused": {
          if (ACTIVE_STATUSES.has(task.status) && !task.cancelConfirmed) task.status = "waiting";
          append("Waiting for a response.");
          break;
        }
        case "turn.settled": {
          const outcome = stringValue(data.outcome);
          if (outcome === "completed") {
            append("Turn completed.");
          } else if (outcome === "cancelled") {
            task.turnId ??= stringValue(data.turnId);
            task.cancelConfirmed = true;
            task.status = Object.values(task.childTasks).some((child) => child.outcome === undefined)
              ? "interrupted" : "cancelled";
            task.error = task.status === "interrupted"
              ? "The parent turn cancellation was confirmed, but one or more child-task endings were not confirmed."
              : undefined;
            append("Turn cancelled.");
          } else if (outcome === "failed") {
            if (!task.cancelConfirmed) {
              task.error = redactText(errorMessage(asRecord(data.error).message));
            }
            append("Turn failed.");
          }
          settledInteractions.push(...task.approvals.map((approval) => approval.id));
          task.approvals = [];
          clearInteractions = true;
          break;
        }
        case "call.requested": {
          const callId = stringValue(data.callId);
          const capability = asRecord(data.capability);
          const name = stringValue(capability.name);
          if (callId && name) {
            callInputs.set(callId, { name, input: data.input });
            append(`Requested ${name}.`);
          }
          break;
        }
        case "call.started": {
          const callId = stringValue(data.callId);
          const call = callId ? callInputs.get(callId) : undefined;
          append(call ? `${call.name} started.` : "An action started.");
          break;
        }
        case "call.settled": {
          const callId = stringValue(data.callId);
          const call = callId ? callInputs.get(callId) : undefined;
          const outcome = stringValue(data.outcome) ?? "settled";
          const failure = outcome === "failed"
            ? stringValue(asRecord(data.error).message) ?? stringValue(data.error)
            : undefined;
          append(`${call?.name ?? "Action"} ${outcome}.${failure ? ` ${failure}` : ""}`);
          if (callId) callInputs.delete(callId);
          break;
        }
        case "interaction.opened": {
          if (task.cancelConfirmed) break;
          const interactionId = stringValue(data.interactionId);
          const request = asRecord(data.request);
          if (!interactionId) break;
          const kind = inspectEveInteraction({ interactionId, request: { kind: stringValue(request.kind) ?? "unknown" } }).kind;
          const blocked = kind === "question" && !isSafeRootQuestion({
            title: request.title ?? "question", detail: request.prompt ?? "A response is required.", options: request.options ?? [],
          });
          const title = blocked ? BLOCKED_QUESTION_TITLE : redactText(stringValue(request.title) ?? stringValue(request.kind) ?? "Response required");
          const options = !blocked && Array.isArray(request.options)
            ? request.options.flatMap((option) => {
                const item = asRecord(option);
                const id = stringValue(item.id);
                const label = stringValue(item.label);
                return id && label ? [{ id, label: redactText(label) }] : [];
              })
            : [];
          const origin = asRecord(data.origin);
          const originCall = asRecord(origin.call);
          const subject = asRecord(data.subject);
          const callId = stringValue(originCall.callId) ?? stringValue(subject.callId);
          const call = callId ? callInputs.get(callId) : undefined;
          const callName = stringValue(originCall.name) ?? call?.name;
          const input = originCall.input ?? call?.input;
          const prompt = blocked ? BLOCKED_QUESTION_DETAIL : redactText(stringValue(request.prompt) ?? "A response is required.");
          const review = request.kind === "approval" ? reviewArguments(callName, input) : undefined;
          const visibleOptions = kind === "other" ? [] : review?.reviewable === false ? options.filter((option) => option.id === "deny") : options;
          const approval: Approval = {
            id: interactionId,
            kind, revision: 1, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            allowText: kind === "question" && !blocked && (request.allowFreeform === true || options.length === 0),
            title: title.slice(0, 500),
            ...(review ?? {}),
            ...(blocked ? { reviewable: false, blockedReason: BLOCKED_QUESTION_REASON } : {}),
            detail: review ? review.detail : prompt.slice(0, 8_000),
            options: visibleOptions,
          };
          const existing = task.approvals.find((item) => item.id === interactionId);
          if (existing) {
            const comparable = (card: Approval) => JSON.stringify([card.kind, card.title, card.detail, card.options, card.allowText, card.reviewable]);
            if (comparable(existing) === comparable(approval)) break;
            approval.revision = (existing.revision ?? 1) + 1;
            task.approvals = task.approvals.filter((item) => item.id !== interactionId);
          }
          task.approvals = [...task.approvals, approval];
          pending.set(interactionId, new Set(visibleOptions.map((option) => option.id)));
          releasedInteractions.push(`${taskId}:${interactionId}`);
          if (ACTIVE_STATUSES.has(task.status) && !task.cancelConfirmed) task.status = "waiting";
          append(`Waiting for input: ${title}.`);
          break;
        }
        case "interaction.settled": {
          const interactionId = stringValue(data.interactionId);
          const outcome = stringValue(data.outcome) ?? "settled";
          const approval = task.approvals.find((item) => item.id === interactionId);
          if (interactionId) {
            task.approvals = task.approvals.filter((item) => item.id !== interactionId);
            pending.delete(interactionId);
            releasedInteractions.push(`${taskId}:${interactionId}`);
          }
          if (approval) append(`Response ${outcome}: ${approval.title}.`);
          break;
        }
        case "task.started": {
          const childId = stringValue(data.taskId);
          const name = stringValue(data.name);
          const kind = stringValue(data.kind);
          if (childId && name) {
            task.childTasks[childId] = { name, ...(kind ? { kind } : {}) };
            markUnconfirmedChild();
            append(kind === "agent" ? `Started ${name} child task.` : `Started ${name} tool task.`);
          }
          break;
        }
        case "task.ended": {
          const childId = stringValue(data.taskId);
          const child = childId ? task.childTasks[childId] : undefined;
          const outcome = stringValue(data.outcome);
          if (child && outcome) {
            child.outcome = outcome;
            append(`${child.name} ${outcome}.`);
            if (task.cancelConfirmed && Object.values(task.childTasks)
              .every((item) => item.outcome !== undefined)) {
              task.status = "cancelled";
              task.error = undefined;
            }
          }
          break;
        }
        case "child.opened": {
          const name = stringValue(data.name);
          const sessionId = stringValue(data.sessionId);
          const owner = asRecord(data.owner);
          const taskId = stringValue(owner.taskId);
          if (name && taskId) {
            task.childTasks[taskId] = {
              ...task.childTasks[taskId],
              name,
              ...(sessionId ? { sessionId } : {}),
            };
            markUnconfirmedChild();
          }
          if (name) append(`Opened child session: ${name}.`);
          break;
        }
        case "content.completed": {
          if (data.kind === "text" && data.phase === "reply" && typeof data.value === "string") {
            const partId = stringValue(data.partId) ?? "reply";
            task.replyParts = { ...task.replyParts, [partId]: redactText(data.value) };
            const reply = Object.values(task.replyParts).join("\n");
            if (task.cancelConfirmed) task.lateReply = reply;
            else task.reply = reply;
          }
          break;
        }
        case "session.ended": {
          if (data.outcome === "failed") {
            if (!task.cancelConfirmed) {
              task.error = redactText(errorMessage(asRecord(data.error).message));
            }
            settledInteractions.push(...task.approvals.map((approval) => approval.id));
            task.approvals = [];
            clearInteractions = true;
            append("Session failed.");
          }
          break;
        }
        case "delivery.settled": {
          if (data.outcome === "awaiting-input" && ACTIVE_STATUSES.has(task.status) &&
            !task.cancelConfirmed) {
            task.status = "waiting";
          } else if (data.outcome === "failed" && ACTIVE_STATUSES.has(task.status) &&
            !task.cancelConfirmed) {
            task.status = "failed";
            append("Delivery failed.");
          }
          break;
        }
      }
    });

    this.seenEvents.set(taskId, seen);
    this.callInputs.set(taskId, callInputs);
    this.pendingOptions.set(taskId, pending);
    for (const key of releasedInteractions) this.submittingInteractions.delete(key);
    if (clearInteractions) {
      pending.clear();
      for (const interactionId of settledInteractions) {
        this.submittingInteractions.delete(`${taskId}:${interactionId}`);
      }
    }
  }

  private eventBelongsToTask(taskId: string, event: EveEvent): boolean {
    const task = this.store.get(taskId);
    if (!task) return false;
    const turnId = event.scope?.turnId ?? stringValue(asRecord(event.data).turnId);
    if (!turnId) return true;
    if (task.turnId) return turnId === task.turnId;
    return !this.store.values().some((other) => other.id !== taskId &&
      other.conversationId === task.conversationId && other.turnId === turnId);
  }

  private pruneCaches(): void {
    const retained = new Set(this.store.values().map((task) => task.id));
    for (const cache of [this.sessions, this.pendingOptions, this.callInputs, this.seenEvents, this.speechParts]) {
      for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id);
    }
    for (const key of this.submittingInteractions) {
      if (!retained.has(key.split(":", 1)[0]!)) this.submittingInteractions.delete(key);
    }
  }
}
