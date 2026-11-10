export type TaskStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ApprovalOption {
  id: string;
  label: string;
}

export interface Approval {
  id: string;
  kind?: "approval" | "question" | "other";
  revision?: number;
  expiresAt?: string;
  allowText?: boolean;
  title: string;
  detail: string;
  reviewable?: boolean;
  blockedReason?: string;
  options: ApprovalOption[];
}

export interface Task {
  id: string;
  conversationId: string;
  userMessage: string | null;
  title: string;
  status: TaskStatus;
  reply: string;
  /** Transient text-only model preview; never a durable transcript or action authority. */
  speechPreview?: string;
  lateReply?: string;
  error?: string;
  createdAt: string;
  events: string[];
  approvals: Approval[];
  questions?: Approval[];
}

export interface TaskRecord extends Omit<Task, "conversationId" | "userMessage"> {
  projectId?: string;
  conversationId?: string;
  userMessage?: string | null;
  sessionId?: string;
  turnId?: string;
  cancelRequested?: boolean;
  cancelConfirmed?: boolean;
  observingDeliveries?: number;
  cancellationPending?: boolean;
  responseUnconfirmed?: boolean;
  replyParts?: Record<string, string>;
  childTasks: Record<string, { name: string; kind?: string; sessionId?: string; outcome?: string }>;
  googleEffects?: import("./google-effect-contracts.ts").GoogleEffectReceipt[];
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  taskId: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

export interface ConversationRecord extends Conversation {
  sessionId?: string;
  /** Immutable private-context scope, retained even when every task is pruned. */
  projectId?: string;
  autoTitle?: boolean;
}

export interface Memory {
  id: string;
  text: string;
}

export interface BridgeState {
  ready: boolean;
  model: string;
  /** Presence of a reasoning credential in this process only; never proof that the provider accepts it. */
  providerConfigured: boolean;
  tasks: Task[];
  conversations: Conversation[];
  memories: Memory[];
  error?: string;
}

export interface EveEvent {
  type: string;
  data: Record<string, unknown>;
  scope?: { turnId?: string };
  meta?: { position?: { line: number; index: number } };
}

export interface EveDelivery {
  stream(options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
  result(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface EveSession {
  id: string;
  send?(message: string): Promise<EveDelivery>;
  respond(answers: readonly { interactionId: string; optionId?: string; text?: string }[]): Promise<EveDelivery>;
  cancel(options?: { signal?: AbortSignal; turnId?: string | null }): Promise<EveDelivery>;
}

export interface EveClient {
  health(): Promise<unknown>;
  sessions: {
    create(input: { message: string }): Promise<{ session: EveSession; delivery: EveDelivery }>;
    attach(sessionId: string): EveSession;
  };
}
