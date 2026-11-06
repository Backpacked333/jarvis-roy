import { randomUUID } from "node:crypto";
import { containsCredentialLikeData, deleteMemory, listMemories } from "../agent/lib/memory.ts";
import { BridgeError, errorMessage } from "./errors.ts";
import { redactText, safeJson } from "./redaction.ts";
import { CONVERSATION_ID, TaskStore } from "./store.ts";
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
    approvals: record.approvals.map((approval) => ({
      ...approval,
      options: approval.options.map((option) => ({ ...option })),
    })),
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

  private constructor(store: TaskStore, client: EveClient, model: string) {
    this.store = store;
    this.client = client;
    this.model = model;
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
      options.model ?? process.env.JARVIS_MODEL ?? "openai/gpt-4.1-mini",
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
      createdAt: now, updatedAt: now, messages: [],
    };
    await this.store.addConversation(conversation);
    this.pruneCaches();
    return publicConversation(conversation);
  }

  async createTask(message: string, conversationId?: string): Promise<Task> {
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
    if (conversationId && this.store.values().some((task) =>
      task.conversationId === conversationId && (ACTIVE_STATUSES.has(task.status) ||
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
    // add() reserves the turn synchronously, before the first await yields to another submit.
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
    void ready.then(async ({ session, delivery }) => {
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
    return publicTask(task);
  }

  async respond(
    taskId: string,
    interactionId: string,
    optionId: string,
  ): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) throw new BridgeError("Task not found.", 404);
    if (this.cancelOperations.has(taskId)) {
      throw new BridgeError("The task is being cancelled.", 409);
    }
    const options = this.pendingOptions.get(taskId) ?? pendingOptionsFromTask(task);
    const allowed = options.get(interactionId);
    const submissionKey = `${taskId}:${interactionId}`;
    if (!allowed || !allowed.has(optionId) || this.submittingInteractions.has(submissionKey)) {
      throw new BridgeError("That response is not currently pending.", 409);
    }
    const session = this.sessions.get(taskId);
    if (!session || task.status !== "waiting") {
      throw new BridgeError("The task is not waiting for a response.", 409);
    }

    this.submittingInteractions.add(submissionKey);
    try {
      const delivery = await session.respond([{ interactionId, optionId }]);
      void this.observeDelivery(taskId, delivery);
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
    const active = this.store.values()
      .filter((task) => ACTIVE_STATUSES.has(task.status))
      .map((task) => task.id);
    await Promise.all(active.map((id) => this.cancel(id)));
    return active.map((id) => this.store.get(id)).filter(
      (task): task is TaskRecord => task !== undefined,
    ).map(publicTask);
  }

  async removeMemory(id: string): Promise<boolean> {
    return deleteMemory(id, this.store.dataDirectory);
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

  private async handleEvent(taskId: string, event: EveEvent): Promise<void> {
    if (!event || typeof event.type !== "string") return;
    if (!this.eventBelongsToTask(taskId, event)) return;
    const seen = this.seenEvents.get(taskId) ?? new Set<string>();
    const signature = eventSignature(event);
    if (seen.has(signature)) return;
    seen.add(signature);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    this.seenEvents.set(taskId, seen);

    const data = asRecord(event.data);
    const callInputs = this.callInputs.get(taskId) ?? new Map();
    this.callInputs.set(taskId, callInputs);
    const pending = this.pendingOptions.get(taskId) ?? new Map();
    this.pendingOptions.set(taskId, pending);
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
          append(`${call?.name ?? "Action"} ${outcome}.`);
          if (callId) callInputs.delete(callId);
          break;
        }
        case "interaction.opened": {
          if (task.cancelConfirmed) break;
          const interactionId = stringValue(data.interactionId);
          const request = asRecord(data.request);
          if (!interactionId) break;
          const title = redactText(stringValue(request.title) ?? stringValue(request.kind) ?? "Response required");
          const options = Array.isArray(request.options)
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
          const prompt = redactText(stringValue(request.prompt) ?? "A response is required.");
          const argumentDetail = callName
            ? `\nTool: ${callName}\nArguments: ${safeJson(input)}`
            : "";
          const approval: Approval = {
            id: interactionId,
            title,
            detail: `${prompt}${argumentDetail}`.slice(0, 22_000),
            options,
          };
          if (!task.approvals.some((item) => item.id === interactionId)) {
            task.approvals = [...task.approvals, approval];
          }
          pending.set(interactionId, new Set(options.map((option) => option.id)));
          this.submittingInteractions.delete(`${taskId}:${interactionId}`);
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
            this.submittingInteractions.delete(`${taskId}:${interactionId}`);
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
    for (const cache of [this.sessions, this.pendingOptions, this.callInputs, this.seenEvents]) {
      for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id);
    }
    for (const key of this.submittingInteractions) {
      if (!retained.has(key.split(":", 1)[0]!)) this.submittingInteractions.delete(key);
    }
  }
}
