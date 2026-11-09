import { createHash, randomInt, randomUUID } from "node:crypto";
import { BridgeError } from "../errors.ts";
import type { Task } from "../types.ts";
import { canonicalJson } from "../harness-contracts/validation.ts";
import { AssistantStore } from "./store.ts";
import {
  ActionRefSchema, AssistantEventSchema, AssistantFocusSchema, AssistantPresentationSchema,
  CreateAssistantSessionSchema, NativeConfirmationEventSchema, ReviewableActionSchema,
  SubmitAssistantTurnSchema, UpdateAssistantFocusSchema,
  type ActionRef, type AssistantEvent, type AssistantFocus, type AssistantIntent, type AssistantPresentation,
  type AssistantSession, type AssistantSnapshot, type AssistantState, type AssistantTurn,
  type NativeConfirmationEvent, type PresentationContent, type ReviewableAction, type VoiceProposal,
} from "./contracts.ts";

export interface AssistantOperation {
  sessionId: string; turnId: string; text: string; intent: AssistantIntent; capturedFocus: AssistantFocus;
  capturedPresentation: AssistantPresentation | null;
}
export interface AssistantAdapters {
  /** Dispatch through JarvisService or the existing harness; do not create another executor. */
  dispatchTurn(input: AssistantOperation): Promise<{ taskId: string; conversationId?: string }>;
  stopWork(input: AssistantOperation): Promise<void>;
  /** Must read a currently waiting, fully reviewable exact approval from JarvisService. */
  readAction?(ref: ActionRef): Promise<ReviewableAction | null>;
  /** Must call the existing approval response API with the same card revision. */
  executeAction?(action: ReviewableAction): Promise<void>;
}
export interface AssistantOptions {
  dataDirectory: string;
  adapters: AssistantAdapters;
  enabled?: boolean;
  voiceApprovalEnabled?: boolean;
  now?: () => Date;
}
/** Produced only by server authentication of the UI+bridge-only native token.
 * Native activity/lock observations are sent by that authenticated client. The
 * Eve runtime and workers must never receive the native token. */
export interface NativeRequestContext { nativeAuthenticated: boolean }

const pending = new Set<VoiceProposal["status"]>(["proposed", "reviewed", "reading", "awaiting_confirmation"]);
const activeTurn = new Set<AssistantTurn["status"]>(["dispatching", "running"]);
// Keep serialized UTF-8 below the native 512 KiB SSE frame limit, including
// framing. A captured card also needs room for a turn's text and metadata.
export const MAX_ASSISTANT_EVENT_BYTES = 511 * 1024;
export const MAX_ASSISTANT_PRESENTATION_BYTES = 384 * 1024;
export const MAX_ASSISTANT_EVENT_HISTORY_BYTES = 4 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const actionDigest = (action: ReviewableAction): string => hash(canonicalJson(ReviewableActionSchema.parse(action)));
export const reviewDigest = (action: ReviewableAction): string => hash(action.reviewText);
const clone = <T>(value: T): T => structuredClone(value);
const matchesVoiceChallenge = (transcript: string, challenge: string | null): boolean => {
  // Allow only ASR orthography around the exact issued phrase: one final period
  // and an optional thousands comma in its four-digit number. Never extract a
  // challenge from a longer sentence or erase other punctuation.
  const match = transcript.trim().toLowerCase().replace(/\s+/g, " ").match(/^confirm ([a-z]+) ([1-9],?\d{3})\.?$/);
  return match !== null && `confirm ${match[1]} ${match[2].replace(",", "")}` === challenge;
};

export class AssistantCoordinator {
  private readonly store: AssistantStore;
  private snapshot?: AssistantSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(event: AssistantEvent) => void>();
  private readonly nativeEvents = new Set<string>();
  private readonly challengeIssuedAt = new Map<string, number>();
  readonly enabled: boolean;
  readonly voiceApprovalEnabled: boolean;
  private readonly options: AssistantOptions;
  constructor(options: AssistantOptions) {
    this.options = options;
    this.enabled = options.enabled ?? process.env.JARVIS_ENABLE_ASSISTANT === "1";
    this.voiceApprovalEnabled = options.voiceApprovalEnabled ?? process.env.JARVIS_ENABLE_VOICE_APPROVAL === "1";
    this.store = new AssistantStore(options.dataDirectory);
  }
  static async open(options: AssistantOptions): Promise<AssistantCoordinator> {
    const coordinator = new AssistantCoordinator(options); await coordinator.initialize(); return coordinator;
  }
  async initialize(): Promise<void> {
    if (this.snapshot) return;
    this.snapshot = await this.store.open();
    try {
      this.validateReferences(this.snapshot);
      await this.mutate((state, emit) => {
        for (const turn of state.turns) {
          if (!activeTurn.has(turn.status)) continue;
          turn.status = "interrupted"; turn.error = "Assistant restarted; inspect the underlying task before continuing.";
          turn.revision++; turn.updatedAt = this.time(); emit("turn.updated", turn);
        }
        for (const proposal of state.proposals) {
          if (!pending.has(proposal.status) && proposal.status !== "executing") continue;
          proposal.status = proposal.status === "executing" ? "uncertain" : "invalidated";
          proposal.challenge = null; proposal.expiresAt = null; proposal.revision++; proposal.updatedAt = this.time();
          emit("confirmation.updated", proposal);
        }
      });
    } catch (error) { this.store.close(); this.snapshot = undefined; throw error; }
  }
  private time(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private milliseconds(): number { return Date.parse(this.time()); }
  private requireEnabled(): void { if (!this.enabled) throw new BridgeError("Assistant experience is disabled.", 503); }
  private requireVoice(context: NativeRequestContext): void {
    this.requireEnabled();
    if (!this.voiceApprovalEnabled) throw new BridgeError("Voice action confirmation is disabled; use the exact approval card.", 409);
    if (!context.nativeAuthenticated) throw new BridgeError("An authenticated native confirmation channel is required.", 403);
    if (!this.options.adapters.readAction || !this.options.adapters.executeAction) throw new BridgeError("Voice action adapter is unavailable; use the exact approval card.", 503);
  }
  private current(): AssistantSnapshot {
    if (!this.snapshot) throw new BridgeError("Assistant coordinator is not initialized.", 503);
    return this.snapshot;
  }
  private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(() => {}, () => {}); return next;
  }
  private async mutate<T>(operation: (state: AssistantSnapshot, emit: Emit) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const state = clone(this.current()), emitted: AssistantEvent[] = [];
      const emit: Emit = (type, data) => {
        const sessionId = type === "session.updated" ? (data as AssistantSession).id : (data as AssistantTurn).sessionId;
        const turnId = type === "session.updated" ? null : type === "turn.updated" ? (data as AssistantTurn).id : (data as AssistantPresentation).turnId;
        const event = AssistantEventSchema.parse({ version: 1, sequence: ++state.sequence, timestamp: this.time(), sessionId, turnId, type, data: clone(data) });
        if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_ASSISTANT_EVENT_BYTES) {
          throw new BridgeError("Assistant update exceeds the native stream limit. Use a smaller presentation or the existing exact action card.", 413);
        }
        emitted.push(event); state.events.push(event); state.events = state.events.slice(-512);
      };
      const result = await operation(state, emit);
      if (emitted.length) {
        // A replay log must also be bounded by bytes: a few large valid cards
        // otherwise exhaust the store long before the 512-event count limit.
        let retainedBytes = 0, first = state.events.length;
        while (first > 0) {
          const bytes = Buffer.byteLength(JSON.stringify(state.events[first - 1]), "utf8");
          if (retainedBytes + bytes > MAX_ASSISTANT_EVENT_HISTORY_BYTES) break;
          retainedBytes += bytes; first--;
        }
        if (first > 0) state.events = state.events.slice(first);
        this.store.save(state); this.snapshot = state;
      }
      for (const event of emitted) for (const listener of this.listeners) {
        try { listener(clone(event)); } catch { /* A disconnected UI cannot roll back persisted state. */ }
      }
      return clone(result);
    });
  }
  private session(state: AssistantSnapshot, id: string): AssistantSession {
    const result = state.sessions.find(session => session.id === id);
    if (!result) throw new BridgeError("Assistant session not found.", 404); return result;
  }
  private invalidate(state: AssistantSnapshot, emit: Emit, sessionId: string): void {
    for (const proposal of state.proposals) {
      if (proposal.sessionId !== sessionId || !pending.has(proposal.status)) continue;
      proposal.status = "invalidated"; proposal.revision++; proposal.challenge = null; proposal.expiresAt = null; proposal.updatedAt = this.time();
      this.challengeIssuedAt.delete(proposal.id); emit("confirmation.updated", proposal);
    }
  }
  state(): AssistantState {
    this.requireEnabled(); const { events: _events, ...state } = this.current(); return clone(state);
  }
  eventsAfter(sequence: number): { version: 1; sequence: number; events: AssistantEvent[] } {
    this.requireEnabled(); const state = this.current();
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > state.sequence) throw new BridgeError("Invalid assistant event cursor; reload state.", 409);
    const first = state.events[0]?.sequence ?? state.sequence + 1;
    if (sequence < first - 1) throw new BridgeError("Assistant event history expired; reload state and resume from its sequence.", 409);
    return { version: 1, sequence: state.sequence, events: clone(state.events.filter(event => event.sequence > sequence)) };
  }
  subscribe(listener: (event: AssistantEvent) => void): () => void {
    this.requireEnabled(); this.current(); this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async createSession(raw: unknown): Promise<AssistantSession> {
    this.requireEnabled(); const input = CreateAssistantSessionSchema.parse(raw);
    return this.mutate((state, emit) => {
      if (state.sessions.length >= 100) throw new BridgeError("Assistant session limit reached.", 409);
      const session: AssistantSession = { version: 1, id: randomUUID(), title: input.title, revision: 1,
        focus: input.focus, createdAt: this.time(), updatedAt: this.time() };
      state.sessions.push(session); emit("session.updated", session); return session;
    });
  }
  async updateFocus(sessionId: string, raw: unknown): Promise<AssistantSession> {
    this.requireEnabled(); const input = UpdateAssistantFocusSchema.parse(raw);
    return this.mutate((state, emit) => {
      const session = this.session(state, sessionId);
      if (session.revision !== input.expectedRevision) throw new BridgeError("Assistant focus changed; refresh before continuing.", 409);
      session.focus = input.focus; session.revision++; session.updatedAt = this.time();
      this.invalidate(state, emit, sessionId); emit("session.updated", session); return session;
    });
  }
  async submitTurn(sessionId: string, raw: unknown): Promise<AssistantTurn> {
    this.requireEnabled(); const input = SubmitAssistantTurnSchema.parse(raw);
    const admitted = await this.mutate((state, emit) => {
      const session = this.session(state, sessionId);
      if (session.revision !== input.expectedRevision) throw new BridgeError("Assistant focus changed; refresh before sending.", 409);
      if (state.turns.some(turn => turn.sessionId === sessionId && turn.status === "dispatching")) throw new BridgeError("A turn is still being dispatched.", 409);
      const presentation = input.presentationRef ? state.presentations.find(item => item.id === input.presentationRef!.presentationId &&
        item.revision === input.presentationRef!.revision && item.sessionId === sessionId) : null;
      if (input.presentationRef && !presentation) throw new BridgeError("The selected presentation changed; refresh before referring to it.", 409);
      this.pruneTurns(state);
      this.invalidate(state, emit, sessionId);
      const turn: AssistantTurn = { version: 1, id: randomUUID(), sessionId, revision: 1,
        text: input.text, intent: input.intent, capturedFocus: clone(session.focus), sessionRevision: session.revision, presentationRef: input.presentationRef ?? null,
        capturedPresentation: presentation ? clone(presentation) : null,
        status: "dispatching", taskId: null, conversationId: null, error: null, createdAt: this.time(), updatedAt: this.time() };
      state.turns.push(turn); emit("turn.updated", turn); return { turn, presentation: presentation ?? null };
    });
    const { turn } = admitted;
    const operation: AssistantOperation = { sessionId, turnId: turn.id, text: turn.text, intent: turn.intent,
      capturedFocus: clone(turn.capturedFocus), capturedPresentation: admitted.presentation };
    try {
      if (turn.intent === "stop_work") {
        await this.options.adapters.stopWork(operation);
        return this.updateTurn(turn.id, { status: "completed" });
      }
      const result = await this.options.adapters.dispatchTurn(operation);
      return this.updateTurn(turn.id, { status: "running", taskId: result.taskId, conversationId: result.conversationId ?? null });
    } catch {
      return this.updateTurn(turn.id, { status: "failed", error: "The existing task service could not confirm dispatch. Inspect task status before retrying." });
    }
  }
  async updateTurn(turnId: string, patch: { status: AssistantTurn["status"]; taskId?: string | null; conversationId?: string | null; error?: string | null }): Promise<AssistantTurn> {
    this.requireEnabled();
    return this.mutate((state, emit) => {
      const turn = state.turns.find(turn => turn.id === turnId);
      if (!turn) throw new BridgeError("Assistant turn not found.", 404);
      if (!activeTurn.has(turn.status) && patch.status !== turn.status) throw new BridgeError("Assistant turn has already settled.", 409);
      Object.assign(turn, patch); turn.revision++; turn.updatedAt = this.time(); emit("turn.updated", turn); return turn;
    });
  }
  async present(input: { id?: string; expectedRevision?: number; sessionId: string; turnId: string; title: string; content: PresentationContent }): Promise<AssistantPresentation> {
    this.requireEnabled();
    return this.mutate((state, emit) => {
      const turn = state.turns.find(turn => turn.id === input.turnId && turn.sessionId === input.sessionId);
      if (!turn) throw new BridgeError("Presentation must belong to an exact assistant turn.", 404);
      const existing = input.id ? state.presentations.find(presentation => presentation.id === input.id) : undefined;
      if (input.id && (!existing || existing.sessionId !== input.sessionId || existing.turnId !== input.turnId || existing.revision !== input.expectedRevision)) throw new BridgeError("Presentation changed or belongs to a different turn.", 409);
      const presentation = AssistantPresentationSchema.parse({ version: 1, id: existing?.id ?? randomUUID(), sessionId: input.sessionId,
        turnId: input.turnId, revision: (existing?.revision ?? 0) + 1, title: input.title, capturedFocus: clone(turn.capturedFocus),
        content: input.content, createdAt: existing?.createdAt ?? this.time(), updatedAt: this.time() });
      if (Buffer.byteLength(JSON.stringify(presentation), "utf8") > MAX_ASSISTANT_PRESENTATION_BYTES) {
        throw new BridgeError("Presentation exceeds 384 KiB. Show fewer source passages, rows or chart points.", 413);
      }
      if (existing) state.presentations[state.presentations.indexOf(existing)] = presentation;
      else { if (state.presentations.length >= 300) state.presentations.shift(); state.presentations.push(presentation); }
      emit("presentation.updated", presentation); return presentation;
    });
  }
  /** Called from existing service snapshots/events; updates display state only. */
  async updateTask(task: Task): Promise<void> {
    this.requireEnabled();
    await this.mutate((state, emit) => {
      for (const turn of state.turns.filter(turn => turn.taskId === task.id)) {
        const status: AssistantTurn["status"] = task.status === "completed" ? "completed" : task.status === "failed" ? "failed" :
          ["cancelled", "interrupted"].includes(task.status) ? "interrupted" : "running";
        const error = task.error?.slice(0, 500) ?? null;
        let turnChanged = false;
        if (activeTurn.has(turn.status) && (turn.status !== status || turn.error !== error)) {
          turn.status = status; turn.error = error; turn.revision++; turn.updatedAt = this.time(); turnChanged = true;
        }
        const spokenText = task.speechPreview ?? task.reply;
        if (!spokenText) { if (turnChanged) emit("turn.updated", turn); continue; }
        const id = `reply-${task.id}`;
        const existing = state.presentations.find(presentation => presentation.id === id);
        const content: PresentationContent = { kind: "text", markdown: spokenText.slice(0, 32_000) };
        if (existing && canonicalJson(existing.content) === canonicalJson(content)) { if (turnChanged) emit("turn.updated", turn); continue; }
        const presentation = AssistantPresentationSchema.parse({ version: 1, id, sessionId: turn.sessionId, turnId: turn.id,
          revision: (existing?.revision ?? 0) + 1, title: task.title.slice(0, 300), capturedFocus: turn.capturedFocus, content,
          createdAt: existing?.createdAt ?? this.time(), updatedAt: this.time() });
        if (existing) state.presentations[state.presentations.indexOf(existing)] = presentation;
        else { if (state.presentations.length >= 300) state.presentations.shift(); state.presentations.push(presentation); }
        emit("presentation.updated", presentation);
        if (turnChanged) emit("turn.updated", turn);
      }
    });
  }
  async presentForTask(taskId: string, content: PresentationContent, title: string): Promise<AssistantPresentation> {
    this.requireEnabled();
    const turn = this.current().turns.find(turn => turn.taskId === taskId);
    if (!turn) throw new BridgeError("Task is not attached to an assistant turn.", 404);
    // A model-authored display is not a runtime verification result. Trusted
    // worker/artifact projections can call present() after checking evidence.
    const displayed = ["code", "code_diff", "math", "artifact"].includes(content.kind) ? { ...content, verification: "unverified" as const } : content;
    return this.present({ sessionId: turn.sessionId, turnId: turn.id, content: displayed, title });
  }
  capturedPresentationForTask(taskId: string): AssistantPresentation | null {
    this.requireEnabled();
    return clone(this.current().turns.find(turn => turn.taskId === taskId)?.capturedPresentation ?? null);
  }
  async proposeAction(sessionId: string, turnId: string, raw: unknown, context: NativeRequestContext): Promise<VoiceProposal> {
    this.requireVoice(context); const ref = ActionRefSchema.parse(raw);
    return this.mutate(async (state, emit) => {
      this.session(state, sessionId);
      const turn = state.turns.find(turn => turn.id === turnId && turn.sessionId === sessionId);
      if (!turn) throw new BridgeError("Approval does not belong to this exact assistant turn.", 409);
      const current = await this.options.adapters.readAction!(ref);
      if (!current) throw new BridgeError("The exact approval is no longer available.", 409);
      const action = ReviewableActionSchema.parse(current);
      if (canonicalJson(ActionRefSchema.parse({ taskId: action.taskId, interactionId: action.interactionId, revision: action.revision, optionId: action.optionId })) !== canonicalJson(ref) || !action.voiceAllowed) throw new BridgeError("This action requires its exact on-screen approval card.", 409);
      const roomId = turn.capturedFocus.kind === "room" ? turn.capturedFocus.roomId : turn.capturedFocus.kind === "conversation" ? turn.capturedFocus.roomId : null;
      if (action.scope === "room" ? roomId !== ref.taskId || !["accept_plan", "start_plan"].includes(ref.optionId) : turn.taskId !== ref.taskId) {
        throw new BridgeError("Approval does not belong to this turn's captured task or room.", 409);
      }
      if (state.proposals.some(proposal => proposal.digest === actionDigest(action) && ["executing", "completed", "uncertain"].includes(proposal.status))) {
        throw new BridgeError("This exact action has already been submitted; inspect its result before taking another action.", 409);
      }
      // Parsing proves the readback corresponds to complete JSON arguments.
      try { const args = JSON.parse(action.exactArguments); if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(); }
      catch { throw new BridgeError("Complete exact action arguments are unavailable.", 409); }
      if (!action.reviewText.includes(action.exactArguments) || !action.reviewText.includes(action.toolName)) throw new BridgeError("The full readback must contain the exact tool and arguments.", 409);
      this.invalidate(state, emit, sessionId);
      if (state.proposals.length >= 100) {
        const old = state.proposals.findIndex(proposal => !pending.has(proposal.status) && proposal.status !== "executing");
        if (old < 0) throw new BridgeError("Voice proposal limit reached.", 409); state.proposals.splice(old, 1);
      }
      const proposal: VoiceProposal = { version: 1, id: randomUUID(), sessionId, turnId, revision: 1,
        digest: actionDigest(action), action, status: "proposed", challenge: null, expiresAt: null,
        nativeSessionId: null, readbackId: null, createdAt: this.time(), updatedAt: this.time() };
      state.proposals.push(proposal); emit("confirmation.updated", proposal); return proposal;
    });
  }
  async nativeEvent(raw: unknown, observations: { appActive: boolean; sessionUnlocked: boolean }, context: NativeRequestContext): Promise<VoiceProposal> {
    this.requireVoice(context); const event = NativeConfirmationEventSchema.parse(raw);
    const result = await this.mutate(async (state, emit) => {
      const proposal = state.proposals.find(proposal => proposal.id === event.proposalId);
      if (!proposal) throw new BridgeError("Voice proposal not found.", 404);
      if (!pending.has(proposal.status)) throw new BridgeError("Voice proposal is no longer pending.", 409);
      const invalidate = () => {
        proposal.status = "invalidated"; proposal.challenge = null; proposal.expiresAt = null;
        proposal.revision++; proposal.updatedAt = this.time(); this.challengeIssuedAt.delete(proposal.id);
        emit("confirmation.updated", proposal); return { proposal, execute: false, refused: true };
      };
      // Any stale, replayed, inactive or retargeted event consumes this proposal.
      const eventTime = Date.parse(event.timestamp), now = this.milliseconds();
      if (!observations.appActive || !observations.sessionUnlocked || this.nativeEvents.has(event.eventId) ||
          event.proposalRevision !== proposal.revision || event.digest !== proposal.digest || Math.abs(now - eventTime) > 5000 ||
          (proposal.nativeSessionId !== null && proposal.nativeSessionId !== event.nativeSessionId) ||
          now - Date.parse(proposal.createdAt) > 120_000) return invalidate();
      const current = await this.options.adapters.readAction!(proposal.action);
      if (!current || actionDigest(current) !== proposal.digest) return invalidate();
      this.nativeEvents.add(event.eventId);
      if (this.nativeEvents.size > 2000) this.nativeEvents.delete(this.nativeEvents.values().next().value!);
      if (event.type === "interrupted") return invalidate();
      if (event.type === "review_displayed") {
        if (proposal.status !== "proposed" || event.reviewDigest !== reviewDigest(proposal.action)) return invalidate();
        proposal.status = "reviewed"; proposal.nativeSessionId = event.nativeSessionId;
      } else if (event.type === "readback_started") {
        if (proposal.status !== "reviewed" || event.reviewDigest !== reviewDigest(proposal.action)) return invalidate();
        proposal.status = "reading"; proposal.readbackId = event.readbackId;
      } else if (event.type === "readback_drained") {
        if (proposal.status !== "reading" || event.readbackId !== proposal.readbackId) return invalidate();
        proposal.status = "awaiting_confirmation";
        proposal.challenge = `confirm ${["amber", "cedar", "maple", "violet", "silver", "coral"][randomInt(6)]} ${randomInt(1000, 10000)}`;
        proposal.expiresAt = new Date(now + 15_000).toISOString(); this.challengeIssuedAt.set(proposal.id, now);
      } else {
        const issued = this.challengeIssuedAt.get(proposal.id), capture = Date.parse(event.captureStartedAt);
        if (proposal.status !== "awaiting_confirmation" || proposal.expiresAt === null || now > Date.parse(proposal.expiresAt) ||
            issued === undefined || capture < issued || capture > eventTime || event.readbackId !== proposal.readbackId ||
            !matchesVoiceChallenge(event.transcript, proposal.challenge)) return invalidate();
        proposal.status = "executing"; proposal.challenge = null; proposal.expiresAt = null;
        this.challengeIssuedAt.delete(proposal.id);
      }
      proposal.revision++; proposal.updatedAt = this.time(); emit("confirmation.updated", proposal);
      return { proposal, execute: proposal.status === "executing", refused: false };
    });
    if (result.refused) throw new BridgeError("Voice confirmation was invalidated. Review the exact action again.", 409);
    if (!result.execute) return result.proposal;
    // Single-use state is durably committed before calling the sole action authority.
    let status: "completed" | "uncertain" = "completed";
    try { await this.options.adapters.executeAction!(clone(result.proposal.action)); }
    catch { status = "uncertain"; }
    return this.mutate((state, emit) => {
      const proposal = state.proposals.find(proposal => proposal.id === result.proposal.id)!;
      proposal.status = status; proposal.revision++; proposal.updatedAt = this.time(); emit("confirmation.updated", proposal); return proposal;
    });
  }
  async invalidateConfirmations(sessionId: string): Promise<void> {
    this.requireEnabled(); await this.mutate((state, emit) => { this.session(state, sessionId); this.invalidate(state, emit, sessionId); });
  }
  async close(): Promise<void> {
    await this.queue; this.listeners.clear(); this.nativeEvents.clear(); this.challengeIssuedAt.clear(); this.store.close(); this.snapshot = undefined;
  }
  private pruneTurns(state: AssistantSnapshot): void {
    if (state.turns.length < 500) return;
    const removable = state.turns.findIndex(turn => !activeTurn.has(turn.status) && !state.proposals.some(proposal => proposal.turnId === turn.id && (pending.has(proposal.status) || proposal.status === "executing")));
    if (removable < 0) throw new BridgeError("Assistant active history limit reached.", 409);
    const [turn] = state.turns.splice(removable, 1);
    state.presentations = state.presentations.filter(presentation => presentation.turnId !== turn.id);
    state.proposals = state.proposals.filter(proposal => proposal.turnId !== turn.id);
  }
  private validateReferences(state: AssistantSnapshot): void {
    for (const collection of [state.sessions, state.turns, state.presentations, state.proposals]) {
      if (new Set(collection.map(record => record.id)).size !== collection.length) throw new Error("Duplicate assistant record identifiers");
    }
    for (const turn of state.turns) {
      this.session(state, turn.sessionId); AssistantFocusSchema.parse(turn.capturedFocus);
    }
    for (const child of [...state.presentations, ...state.proposals]) {
      if (!state.turns.some(turn => turn.id === child.turnId && turn.sessionId === child.sessionId)) throw new Error("Invalid assistant record scope");
    }
    for (const proposal of state.proposals) if (actionDigest(proposal.action) !== proposal.digest) throw new Error("Assistant action digest mismatch");
    for (let index = 0; index < state.events.length; index++) {
      if (state.events[index].sequence > state.sequence || (index > 0 && state.events[index].sequence !== state.events[index - 1].sequence + 1)) throw new Error("Invalid assistant event sequence");
    }
    if (state.events.length && state.events.at(-1)!.sequence !== state.sequence) throw new Error("Assistant event tail mismatch");
  }
}

type Emit = (type: AssistantEvent["type"], data: AssistantSession | AssistantTurn | AssistantPresentation | VoiceProposal) => void;

/** Ready for ServerResponse.write; data is JSON, never interpolated raw text. */
export function assistantSseFrame(event: AssistantEvent): string {
  const checked = AssistantEventSchema.parse(event);
  return `id: ${checked.sequence}\nevent: ${checked.type}\ndata: ${JSON.stringify(checked)}\n\n`;
}
