import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, getDataDirectory, readPrivateJson, writeJsonAtomically } from "../agent/lib/persistence.ts";
import type { ConversationRecord, TaskRecord, TaskStatus } from "./types.ts";

const STATUSES = new Set<TaskStatus>([
  "starting", "running", "waiting", "completed", "failed", "cancelled", "interrupted",
]);
const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const MAX_TASKS = 100;
const MAX_CONVERSATIONS = 100;
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (!object(value)) return false;
  return typeof value.id === "string" && typeof value.title === "string" &&
    typeof value.createdAt === "string" && typeof value.reply === "string" &&
    Array.isArray(value.events) && value.events.every((item) => typeof item === "string") &&
    Array.isArray(value.approvals) && object(value.childTasks) &&
    STATUSES.has(value.status as TaskStatus) &&
    (value.conversationId === undefined ||
      (typeof value.conversationId === "string" && CONVERSATION_ID.test(value.conversationId))) &&
    (value.userMessage === undefined || value.userMessage === null || typeof value.userMessage === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.projectId === undefined || (typeof value.projectId === "string" && PROJECT_ID.test(value.projectId))) &&
    (value.lateReply === undefined || typeof value.lateReply === "string") &&
    (value.responseUnconfirmed === undefined || typeof value.responseUnconfirmed === "boolean") &&
    (value.replyParts === undefined || (object(value.replyParts) &&
      Object.values(value.replyParts).every((part) => typeof part === "string"))) &&
    (value.observingDeliveries === undefined || (Number.isSafeInteger(value.observingDeliveries) &&
      Number(value.observingDeliveries) >= 0));
}

function isConversation(value: unknown): value is ConversationRecord {
  return object(value) && typeof value.id === "string" && CONVERSATION_ID.test(value.id) &&
    typeof value.title === "string" && typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.autoTitle === undefined || typeof value.autoTitle === "boolean") &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.projectId === undefined || (typeof value.projectId === "string" && PROJECT_ID.test(value.projectId))) &&
    Array.isArray(value.messages) && value.messages.every((message: unknown) =>
      object(message) && typeof message.id === "string" &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.text === "string" && typeof message.createdAt === "string" &&
      typeof message.taskId === "string");
}

export interface TaskStoreOptions {
  /** Persistence seam for deterministic failure/commit-barrier tests. */
  write?: typeof writeJsonAtomically;
}

export class TaskStore {
  readonly dataDirectory: string;
  private readonly statePath: string;
  private readonly records = new Map<string, TaskRecord>();
  private readonly threads = new Map<string, ConversationRecord>();
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly write: typeof writeJsonAtomically;
  private readonly listeners = new Set<() => void>();

  constructor(dataDirectory = getDataDirectory(), options: TaskStoreOptions = {}) {
    this.dataDirectory = dataDirectory;
    this.write = options.write ?? writeJsonAtomically;
    this.statePath = path.join(dataDirectory, "tasks.json");
  }

  async initialize(): Promise<void> {
    await this.mutate((draft) => draft.load());
  }

  private async load(): Promise<void> {
    this.records.clear();
    this.threads.clear();
    await ensurePrivateDirectory(this.dataDirectory);
    const saved = await readPrivateJson<unknown>(this.statePath);
    let tasks: unknown = [];
    if (Array.isArray(saved)) tasks = saved;
    else if (saved !== undefined) {
      if (!object(saved) || saved.version !== 2 || !Array.isArray(saved.conversations) ||
        !saved.conversations.every(isConversation)) {
        throw new Error("Jarvis conversation history is invalid; restore a valid backup before restarting.");
      }
      tasks = saved.tasks;
      for (const conversation of saved.conversations) {
        if (this.threads.has(conversation.id)) throw new Error("Duplicate Jarvis conversation ID.");
        this.threads.set(conversation.id, conversation);
      }
    }
    if (!Array.isArray(tasks) || !tasks.every(isTaskRecord)) {
      throw new Error("Jarvis task history is invalid.");
    }
    for (const task of tasks) {
      if (this.records.has(task.id)) throw new Error("Duplicate Jarvis task ID.");
      if (!Array.isArray(saved) && task.conversationId && !this.threads.has(task.conversationId)) {
        throw new Error("Jarvis task history references a missing conversation.");
      }
      this.attachConversation(task, false);
      this.records.set(task.id, task);
      if (!TERMINAL_STATUSES.has(task.status) || task.observingDeliveries || task.cancellationPending || task.responseUnconfirmed) {
        task.status = "interrupted";
        task.approvals = [];
        task.cancelRequested = false;
        task.error = "Runtime restarted before this task's outcome was confirmed; it was not reported as cancelled. Stop this task before sending another message in its conversation.";
      }
      task.observingDeliveries = 0;
      task.cancellationPending = false;
      this.syncMessages(task);
    }
    for (const conversation of this.threads.values()) {
      const related = this.values().filter(task => task.conversationId === conversation.id);
      const scopes = new Set([conversation.projectId, ...related.map(task => task.projectId)].filter((value): value is string => value !== undefined));
      if (scopes.size > 1) throw new Error("Jarvis conversation history has inconsistent private project scopes; restore a valid backup.");
      // Recover a recorded scope before retention runs. Legacy sessions without
      // an explicit project keep their historical conversation-local authority.
      conversation.projectId ??= [...scopes][0] ??
        (conversation.sessionId || related.length || conversation.messages.length ? conversation.id : undefined);
      for (const task of related) this.bindProjectScope(task);
      if (conversation.sessionId) this.validateSession(conversation.id, conversation.sessionId);
      if (conversation.messages.some((message) =>
        this.records.get(message.taskId)?.conversationId !== conversation.id)) {
        throw new Error("Jarvis conversation history references a missing task.");
      }
    }
    for (const task of this.records.values()) {
      if (task.sessionId && this.threads.get(task.conversationId!)?.sessionId !== task.sessionId) {
        throw new Error("Jarvis task history has an inconsistent Eve session; restore a valid backup.");
      }
    }
    this.prune();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  values(): TaskRecord[] {
    return [...this.records.values()];
  }

  conversations(): ConversationRecord[] {
    return [...this.threads.values()];
  }

  conversation(id: string): ConversationRecord | undefined {
    return this.threads.get(id);
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  async addConversation(conversation: ConversationRecord): Promise<void> {
    const input = structuredClone(conversation);
    await this.mutate((draft) => {
      if (draft.threads.has(input.id)) throw new Error("Duplicate Jarvis conversation ID.");
      if (input.projectId !== undefined && !PROJECT_ID.test(input.projectId)) throw new Error("Invalid private project scope.");
      if (input.sessionId || input.messages.length) input.projectId ??= input.id;
      draft.threads.set(input.id, input);
      draft.prune(input.id);
    }, undefined, conversation);
  }

  async add(task: TaskRecord): Promise<void> {
    const input = structuredClone(task);
    await this.mutate((draft) => {
      if (draft.records.has(input.id)) throw new Error("Duplicate Jarvis task ID.");
      draft.attachConversation(input);
      draft.records.set(input.id, input);
      draft.syncMessages(input);
      draft.prune();
    }, task);
  }

  async update(id: string, update: (task: TaskRecord) => void): Promise<TaskRecord | undefined> {
    await this.mutate((draft) => {
      const task = draft.records.get(id);
      if (!task) return false;
      update(task);
      draft.bindProjectScope(task);
      draft.syncMessages(task);
      draft.prune();
    });
    return this.records.get(id);
  }

  async bindSession(taskId: string, sessionId: string): Promise<void> {
    await this.mutate((draft) => {
      const task = draft.records.get(taskId);
      if (!task) throw new Error("Jarvis task is missing.");
      const conversation = draft.threads.get(task.conversationId!)!;
      draft.validateSession(conversation.id, sessionId);
      draft.bindProjectScope(task);
      task.sessionId = sessionId;
      conversation.sessionId = sessionId;
    });
  }

  private validateSession(conversationId: string, sessionId: string): void {
    const conversation = this.threads.get(conversationId);
    if (conversation?.sessionId && conversation.sessionId !== sessionId) {
      throw new Error("A Jarvis conversation cannot change its Eve session. Create a new conversation instead.");
    }
    if (this.conversations().some((other) => other.id !== conversationId && other.sessionId === sessionId)) {
      throw new Error("Eve returned a session already assigned to another conversation. Stop the runtime and restore a valid session store.");
    }
  }

  private attachConversation(task: TaskRecord, bindProject = true): void {
    task.conversationId ??= randomUUID();
    task.userMessage ??= null;
    if (!this.threads.has(task.conversationId)) {
      this.threads.set(task.conversationId, {
        id: task.conversationId, title: task.title, createdAt: task.createdAt,
        updatedAt: task.createdAt, messages: [],
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      });
    }
    if (bindProject) this.bindProjectScope(task);
  }

  private bindProjectScope(task: TaskRecord): void {
    const conversation = this.threads.get(task.conversationId!);
    if (!conversation) throw new Error("Jarvis conversation is missing.");
    if (task.projectId !== undefined && !PROJECT_ID.test(task.projectId)) throw new Error("Invalid private project scope.");
    if (conversation.projectId !== undefined && task.projectId !== undefined && conversation.projectId !== task.projectId) {
      throw new Error("A Jarvis conversation cannot change its private project scope.");
    }
    conversation.projectId ??= task.projectId ?? conversation.id;
    task.projectId = conversation.projectId;
  }

  private syncMessages(task: TaskRecord): void {
    const conversation = this.threads.get(task.conversationId!);
    if (!conversation) throw new Error("Jarvis conversation is missing.");
    let changed = false;
    for (const role of ["user", "assistant"] as const) {
      const text = role === "user" ? task.userMessage : task.lateReply ?? task.reply;
      if (!text) continue;
      const existing = conversation.messages.find((message) =>
        message.taskId === task.id && message.role === role);
      if (existing) {
        if (existing.text !== text) { existing.text = text; changed = true; }
      } else {
        conversation.messages.push({
          id: randomUUID(), role, text,
          createdAt: role === "user" ? task.createdAt : new Date().toISOString(), taskId: task.id,
        });
        changed = true;
      }
    }
    const firstUserMessage = conversation.messages.find((message) => message.role === "user");
    const firstTask = firstUserMessage && this.records.get(firstUserMessage.taskId);
    if (conversation.autoTitle !== false && conversation.title === "New conversation" && firstTask?.userMessage) {
      conversation.title = firstTask.title;
      conversation.autoTitle = false;
      changed = true;
    }
    if (changed) {
      const order = new Map(this.values().map((record, index) => [record.id, index]));
      conversation.messages.sort((left, right) =>
        (order.get(left.taskId) ?? Infinity) - (order.get(right.taskId) ?? Infinity) ||
        Number(left.role === "assistant") - Number(right.role === "assistant"));
      conversation.updatedAt = new Date().toISOString();
    }
  }

  private prune(keepConversationId?: string): void {
    while (this.records.size > MAX_TASKS) {
      const removable = this.values().filter((task) => TERMINAL_STATUSES.has(task.status) &&
        !task.observingDeliveries && !task.cancellationPending)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!removable) break;
      this.records.delete(removable.id);
      const conversation = this.threads.get(removable.conversationId!);
      if (conversation) {
        conversation.messages = conversation.messages.filter((message) => message.taskId !== removable.id);
      }
    }
    const protectedIds = new Set(this.values().filter((task) =>
      !TERMINAL_STATUSES.has(task.status) || task.observingDeliveries || task.cancellationPending)
      .map((task) => task.conversationId));
    const referenced = new Set(this.values().map((task) => task.conversationId));
    const candidates = this.conversations().filter((conversation) =>
      conversation.id !== keepConversationId && !protectedIds.has(conversation.id))
      .sort((left, right) => Number(referenced.has(left.id)) - Number(referenced.has(right.id)) ||
        left.updatedAt.localeCompare(right.updatedAt));
    while (this.threads.size > MAX_CONVERSATIONS && candidates.length) {
      const id = candidates.shift()!.id;
      for (const task of this.values()) {
        if (task.conversationId === id) this.records.delete(task.id);
      }
      this.threads.delete(id);
    }
  }

  /** Mutations run in submission order against only the last committed snapshot.
   * Callbacks must mutate the draft record only; external effects belong after await.
   * Admission reservations belong to the service, not these published records.
   */
  private mutate(operation: (draft: TaskStore) => boolean | void | Promise<boolean | void>,
    addedTask?: TaskRecord, addedConversation?: ConversationRecord): Promise<void> {
    const mutation = this.mutationChain.then(async () => {
      const draft = new TaskStore(this.dataDirectory, { write: this.write });
      for (const [id, record] of this.records) draft.records.set(id, structuredClone(record));
      for (const [id, thread] of this.threads) draft.threads.set(id, structuredClone(thread));
      if (await operation(draft) === false) return;
      await draft.persist();
      this.publish(this.records, draft.records, addedTask);
      this.publish(this.threads, draft.threads, addedConversation);
      for (const listener of [...this.listeners]) {
        try { listener(); } catch { /* An observer cannot invalidate an already committed write. */ }
      }
    });
    // A rejected candidate never enters memory or a later successful snapshot.
    this.mutationChain = mutation.catch(() => undefined);
    return mutation;
  }

  private publish<T extends { id: string }>(current: Map<string, T>, next: Map<string, T>, added?: T): void {
    for (const id of current.keys()) if (!next.has(id)) current.delete(id);
    for (const [id, value] of next) {
      const record = current.get(id) ?? (added?.id === id ? added : undefined);
      if (record) {
        // Keep live record identities used by cancellation and delivery observers.
        for (const key of Object.keys(record)) if (!(key in value)) delete (record as Record<string, unknown>)[key];
        Object.assign(record, value);
        current.set(id, record);
      } else current.set(id, value);
    }
  }

  private async persist(): Promise<void> {
    try {
      const info = await lstat(this.statePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Jarvis data files must be regular files.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.write(this.statePath, {
      version: 2, tasks: this.values(), conversations: this.conversations(),
    });
  }
}
