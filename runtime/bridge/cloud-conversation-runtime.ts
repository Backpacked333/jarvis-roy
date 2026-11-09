import { createHash } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "./errors.ts";
import type { CloudControlPlane } from "./cloud/control.ts";
import { IntegrationId, QuestionBindingSchema, type InboundTelegram, type IntegrationContext, type OutboxInput, type QuestionBinding } from "./integrations/index.ts";

const Status = z.enum(["starting", "running", "waiting", "completed", "failed", "cancelled", "interrupted"]);
const Card = z.object({ id: IntegrationId, kind: z.enum(["question", "approval", "other"]).optional(), revision: z.number().int().positive().optional(),
  expiresAt: z.iso.datetime().optional(), allowText: z.boolean().optional(), reviewable: z.boolean().optional(), title: z.string().max(4000), detail: z.string().max(16000),
  options: z.array(z.object({ id: z.string().max(100), label: z.string().max(1000) })).max(100) });
const Task = z.object({ id: IntegrationId, conversationId: IntegrationId, projectId: IntegrationId.optional(), status: Status,
  reply: z.string().max(256000).default(""), createdAt: z.iso.datetime(), approvals: z.array(Card).max(100).default([]), questions: z.array(Card).max(100).default([]) });
type TaskValue = z.infer<typeof Task>;
const Entry = z.strictObject({ id: IntegrationId, digest: z.string().length(64), channel: z.enum(["telegram", "phone"]),
  phase: z.enum(["submitting", "tracked", "unknown", "done"]), conversationId: IntegrationId.nullable(), taskId: IntegrationId.nullable(),
  createdAt: z.iso.datetime(), status: Status.nullable(), terminalNotified: z.boolean().default(false) });
type EntryValue = z.infer<typeof Entry>;
const Channel = z.strictObject({ conversationId: IntegrationId, question: QuestionBindingSchema.nullable().default(null), questionCallSid: z.string().max(100).nullable().default(null) });
const State = z.strictObject({ version: z.literal(1), telegram: Channel.nullable(), phone: Channel.nullable(), phoneSequence: z.number().int().nonnegative().safe().default(0), entries: z.array(Entry).max(100) });
type StateValue = z.infer<typeof State>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const terminal = (task: TaskValue) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status);
const genericConsent = /^(?:yes|yeah|yep|ok|okay|approve|approved|confirm|confirmed|send|send it|do it)[.!\s]*$/iu;

export interface CloudConversationOptions {
  rpc(operation: string, payload?: unknown): Promise<unknown>;
  integrations(): { readCursor<T = unknown>(name: string): T | undefined; writeCursor(name: string, value: unknown): void; status(): { stopped: boolean };
    verifiedCall(callSid: string): Promise<{ callSid: string; projectId: string; status: "ringing" | "in_progress" } | null>;
    telegram?: { enqueue(raw: unknown): unknown; outbox(): { id: string }[]; paired(): boolean } };
  control: Pick<CloudControlPlane, "authorizeDisclosure"> & { createActionProposal(raw: unknown): Promise<unknown> };
  origin: string; projectId: string; telegramDestination: string; phoneDestination: string;
  now?: () => Date; phoneWaitMs?: number;
}

/** Channel transport only. Eve admission owns model budgets; task responses and
 * remote approval proposals retain their existing sole execution authority. */
export function createCloudConversationRuntime(options: CloudConversationOptions) {
  IntegrationId.parse(options.projectId);
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("An exact HTTPS cloud origin is required");
  const reviewUrl = `${origin.origin}/v1/cloud/review`, cursor = `cloud-chat-${hash(options.projectId).slice(0, 40)}`;
  const time = () => (options.now?.() ?? new Date()).toISOString();
  const state = (): StateValue => State.parse(options.integrations().readCursor(cursor) ?? { version: 1, telegram: null, phone: null, entries: [] });
  // Every mutation rereads committed state synchronously. Never overwrite a
  // snapshot captured before awaiting a provider, another channel, or polling.
  const mutate = <T>(operation: (value: StateValue) => T): T => {
    const value = state(), result = operation(value); options.integrations().writeCursor(cursor, State.parse(value)); return result;
  };
  const entry = (id: string) => state().entries.find(value => value.id === id);
  const patch = (id: string, values: Partial<EntryValue>) => mutate(current => { const found = current.entries.find(value => value.id === id); if (found) Object.assign(found, values); });
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(channel: string, operation: () => Promise<T>): Promise<T> {
    const work = (queues.get(channel) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(channel, work); void work.finally(() => { if (queues.get(channel) === work) queues.delete(channel); }).catch(() => {}); return work;
  }
  function admit(id: string, channel: EntryValue["channel"], digest: string): EntryValue {
    return mutate(current => {
      const existing = current.entries.find(value => value.id === id);
      if (existing) { if (existing.digest !== digest || existing.channel !== channel) throw new BridgeError("Channel request identity changed.", 409); return existing; }
      while (current.entries.length >= 100) {
        const removable = current.entries.findIndex(value => value.phase === "done" && value.terminalNotified);
        if (removable < 0) throw new BridgeError("Too many unresolved channel requests. Inspect Jarvis before submitting more.", 409);
        current.entries.splice(removable, 1);
      }
      const value: EntryValue = { id, digest, channel, phase: "submitting", conversationId: null, taskId: null, createdAt: time(), status: null, terminalNotified: false };
      current.entries.push(value); return value;
    });
  }
  const permitted = (channel: "telegram" | "phone", proactive = false) => options.control.authorizeDisclosure({ projectId: options.projectId, channel,
    destinationId: channel === "telegram" ? options.telegramDestination : options.phoneDestination, proactive });
  function notify(id: string, text: string, input: Partial<Pick<OutboxInput, "question" | "kind" | "disclosure">> = {}, at = time()): boolean {
    const integration = options.integrations(), telegram = integration.telegram;
    if (!telegram?.paired() || integration.status().stopped) return false;
    const notificationId = `cloud-chat-${hash(id).slice(0, 48)}`;
    if (telegram.outbox().some(item => item.id === notificationId)) return true;
    const disclosure = input.disclosure ?? "minimal";
    if (disclosure === "project_details" && !permitted("telegram", (input.kind ?? "reply") !== "reply")) return false;
    telegram.enqueue({ id: notificationId, projectId: options.projectId, objectiveId: null, kind: input.kind ?? "reply", text: text.slice(0, 4000),
      question: input.question ?? null, disclosure, notBefore: at });
    return true;
  }
  async function readTask(id: string, conversationId?: string): Promise<TaskValue> {
    const task = Task.parse(await options.rpc("tasks", { method: "GET", id }));
    if (task.id !== id || task.projectId !== options.projectId || conversationId && task.conversationId !== conversationId) throw new BridgeError("Cloud task scope changed.", 403);
    return task;
  }
  async function conversation(channel: EntryValue["channel"], force: boolean, stillAuthorized?: () => Promise<boolean>): Promise<string> {
    const current = state()[channel];
    if (current && !force) {
      const outstanding = state().entries.filter(value => value.conversationId === current.conversationId && ["submitting", "unknown", "tracked"].includes(value.phase));
      let busy = outstanding.some(value => value.taskId === null || value.phase === "unknown");
      for (const item of outstanding.filter(value => value.taskId)) {
        const task = await readTask(item.taskId!, current.conversationId);
        patch(item.id, { status: task.status });
        if (!terminal(task) || ["cancelled", "interrupted"].includes(task.status) || task.approvals.length || task.questions.length) busy = true;
      }
      if (!busy) return current.conversationId;
    }
    if (stillAuthorized && !await stillAuthorized()) throw new BridgeError("Verified conversation channel expired.", 403);
    const result = z.object({ id: IntegrationId }).parse(await options.rpc("conversations", { method: "POST", projectId: options.projectId, title: channel === "telegram" ? "Telegram conversation" : "Verified phone conversation" }));
    mutate(value => { value[channel] = { conversationId: result.id, question: null, questionCallSid: null }; }); return result.id;
  }
  async function submit(id: string, channel: EntryValue["channel"], message: string, stillAuthorized?: () => Promise<boolean>): Promise<EntryValue> {
    const digest = hash(JSON.stringify([options.projectId, channel, message]));
    const existing = entry(id); if (existing) { if (existing.digest !== digest) throw new BridgeError("Channel request changed.", 409); return existing; }
    admit(id, channel, digest);
    try {
      if (options.integrations().status().stopped) { patch(id, { phase: "done", terminalNotified: true }); throw new BridgeError("Cloud work is stopped.", 409); }
      const fresh = message.trim() === "/new", conversationId = await conversation(channel, fresh, stillAuthorized);
      patch(id, { conversationId });
      if (fresh) { patch(id, { phase: "done", terminalNotified: true }); return entry(id)!; }
      if (stillAuthorized && !await stillAuthorized() || options.integrations().status().stopped || channel === "phone" && !permitted("phone")) throw new BridgeError("Cloud conversation permission changed.", 403);
      // Persist admission intent before the sole POST. A timeout never causes an
      // automatic replay, even if the bridge may have accepted the original.
      const task = Task.parse(await options.rpc("tasks", { method: "POST", message, conversationId, projectId: options.projectId }));
      if (task.conversationId !== conversationId || task.projectId && task.projectId !== options.projectId) throw new BridgeError("Submitted task scope changed.", 403);
      patch(id, { taskId: task.id, status: task.status, phase: "tracked" }); return entry(id)!;
    } catch (error) {
      if (entry(id)?.phase !== "done") patch(id, { phase: "unknown" });
      throw error;
    }
  }
  function currentQuestion(task: TaskValue, binding: QuestionBinding) {
    if (task.status !== "waiting" || binding.kind !== "task" || binding.projectId !== options.projectId || binding.taskId !== task.id || Date.parse(binding.expiresAt) <= Date.parse(time())) return undefined;
    return task.questions.find(card => card.kind === "question" && card.reviewable === true && card.id === binding.questionId && card.revision === binding.revision &&
      card.expiresAt && Date.parse(card.expiresAt) > Date.parse(time()));
  }
  function bindingFor(task: TaskValue): QuestionBinding | null {
    const card = task.questions.find(card => card.kind === "question" && card.reviewable === true && card.revision && card.expiresAt && Date.parse(card.expiresAt) > Date.parse(time()));
    return card ? { kind: "task", projectId: options.projectId, taskId: task.id, questionId: card.id, revision: card.revision!, expiresAt: card.expiresAt! } : null;
  }
  async function answer(id: string, channel: EntryValue["channel"], binding: QuestionBinding, text: string, stillAuthorized?: () => Promise<boolean>): Promise<string> {
    if (Date.parse(binding.expiresAt) <= Date.parse(time())) return "That question expired. Open Jarvis for the current question.";
    const digest = hash(JSON.stringify([options.projectId, channel, binding, text]));
    const prior = entry(id); if (prior) { if (prior.digest !== digest) throw new BridgeError("Question response changed.", 409); return "That response was already submitted. Inspect Jarvis for its current state."; }
    if (binding.kind === "objective") {
      const response = z.object({ body: z.object({ id: IntegrationId, projectId: IntegrationId, revision: z.number().int().positive(),
        question: z.object({ id: IntegrationId, revision: z.number().int().positive(), expiresAt: z.iso.datetime() }).nullable() }) }).parse(
        await options.rpc("objectives", { method: "GET", path: `/v1/objectives/${binding.objectiveId}?projectId=${encodeURIComponent(options.projectId)}` }));
      const current = response.body;
      if (current.projectId !== options.projectId || current.id !== binding.objectiveId || !current.question || current.question.id !== binding.questionId || current.question.revision !== binding.revision || Date.parse(current.question.expiresAt) <= Date.parse(time())) return "That question changed. Open Jarvis for the current question.";
      admit(id, channel, digest);
      try { await options.rpc("objectives", { method: "POST", path: `/v1/objectives/${current.id}/answer?projectId=${encodeURIComponent(options.projectId)}`,
        body: { expectedRevision: current.revision, questionId: binding.questionId, questionRevision: binding.revision, answer: text } }); patch(id, { phase: "done", terminalNotified: true }); }
      catch (error) { patch(id, { phase: "unknown" }); throw error; }
      return "Your answer is attached to that objective. External actions still require secure review.";
    }
    const task = await readTask(binding.taskId), card = currentQuestion(task, binding);
    if (!card) return "That question changed. Open Jarvis for the current question.";
    const selected = card.options.filter(option => option.id === text.trim() || option.label === text.trim());
    if (selected.length !== 1 && !(selected.length === 0 && card.allowText === true)) return "Reply with one exact option label or open Jarvis to answer the current question.";
    admit(id, channel, digest); patch(id, { taskId: task.id, conversationId: task.conversationId });
    try {
      if (stillAuthorized && !await stillAuthorized() || options.integrations().status().stopped || channel === "phone" && !permitted("phone")) throw new BridgeError("Conversation permission changed.", 403);
      await options.rpc("respond_question", { taskId: task.id, interactionId: card.id, expectedRevision: card.revision,
        ...(selected.length === 1 ? { optionId: selected[0].id } : { text }) });
      patch(id, { phase: "tracked", status: "running" });
      mutate(value => { if (value[channel]?.question?.questionId === card.id) { value[channel]!.question = null; value[channel]!.questionCallSid = null; } });
      return "Your answer is attached to that exact question. External actions still require secure review.";
    } catch (error) { patch(id, { phase: "unknown" }); throw error; }
  }
  async function proposals(task: TaskValue): Promise<void> {
    for (const card of task.approvals) if (card.kind === "approval" && card.reviewable === true && card.revision && card.options.some(option => option.id === "approve")) {
      await options.control.createActionProposal({ projectId: options.projectId, deviceId: "cloud-runtime", ref: { taskId: task.id, interactionId: card.id, revision: card.revision, optionId: "approve" } });
    }
  }
  async function onTelegramMessage(message: InboundTelegram): Promise<void> {
    if (message.chatId !== options.telegramDestination || !options.integrations().telegram?.paired()) throw new BridgeError("Paired Telegram owner required.", 403);
    if (!message.text.trim() || message.text.length > 16000) throw new BridgeError("Message is outside the conversation limit.", 400);
    const id = `telegram-${message.updateId}`;
    return serial("telegram", async () => {
      try {
        if (message.question) {
          if (message.text.length > 4000) { notify(`${id}:length`, `That answer exceeds the clarification limit. Keep it under four thousand characters or use Jarvis. ${reviewUrl}`); return; }
          const result = await answer(id, "telegram", message.question, message.text); notify(`${id}:answer`, `${result} ${reviewUrl}`, {}, entry(id)?.createdAt); return;
        }
        if (genericConsent.test(message.text)) {
          const current = state().telegram;
          if (current) for (const item of state().entries.filter(value => value.taskId && value.conversationId === current.conversationId && value.phase === "tracked")) {
            if ((await readTask(item.taskId!, current.conversationId)).approvals.length) { notify(`${id}:approval`, `Use the exact secure review to authorize actions. ${reviewUrl}`); return; }
          }
        }
        const submitted = await submit(id, "telegram", message.text);
        const text = message.text.trim() === "/new" ? "A new conversation is ready." : submitted.phase === "unknown" || submitted.phase === "submitting" ? "I cannot confirm whether that request started. Inspect Jarvis before submitting it again." : "Your request is in Jarvis.";
        notify(`${id}:received`, `${text} ${reviewUrl}`, {}, submitted.createdAt);
      } catch {
        notify(`${id}:uncertain`, `I could not confirm this request's current state. It was not automatically retried. Inspect Jarvis before submitting it again. ${reviewUrl}`, {}, entry(id)?.createdAt);
      }
    });
  }
  let notifying = false;
  async function notifyPending(): Promise<{ checked: number; notified: number }> {
    if (notifying || options.integrations().status().stopped) return { checked: 0, notified: 0 };
    notifying = true; let checked = 0, notified = 0;
    try {
      for (const item of state().entries.filter(value => value.taskId && ["tracked", "unknown"].includes(value.phase))) {
        try {
          const task = await readTask(item.taskId!, item.conversationId ?? undefined); checked++; patch(item.id, { status: task.status, phase: "tracked" });
          if (task.status === "waiting") {
            await proposals(task);
            const binding = bindingFor(task), card = binding ? currentQuestion(task, binding) : undefined;
            const detail = permitted("telegram", !!binding || item.channel === "phone"), key = `${task.id}:waiting:${hash(JSON.stringify([task.approvals, task.questions]))}`;
            const text = detail && card ? `${card.title}\n${card.detail}\n${card.options.map(option => option.label).join(" · ")}\nReply to this message with the exact option label.\n${reviewUrl}` : `Jarvis needs ${task.approvals.length ? "secure action review" : "your answer"}. ${reviewUrl}`;
            if (notify(key, text, { kind: binding ? "question" : "reply", question: binding, disclosure: detail && card ? "project_details" : "minimal" }, item.createdAt)) notified++;
          } else if (terminal(task)) {
            const detail = permitted("telegram", item.channel === "phone"), text = detail && task.reply ? `${task.reply.slice(0, 3500)}\n${reviewUrl}` : `Jarvis work is ${task.status}. Inspect its result and observed outcomes: ${reviewUrl}`;
            if (notify(`${task.id}:terminal:${task.status}`, text, { kind: item.channel === "phone" ? "routine" : "reply", disclosure: detail && task.reply ? "project_details" : "minimal" }, item.createdAt)) {
              patch(item.id, { phase: "done", terminalNotified: true }); notified++;
            }
          }
        } catch { /* Retain unresolved work and retry read-only reconciliation on the next tick. */ }
      }
      return { checked, notified };
    } finally { notifying = false; }
  }
  async function phoneAllowed(input: IntegrationContext & { callSid: string }): Promise<boolean> {
    if (input.projectId !== options.projectId || !permitted("phone") || options.integrations().status().stopped) return false;
    const call = await options.integrations().verifiedCall(input.callSid);
    return !!call && call.callSid === input.callSid && call.projectId === input.projectId && ["ringing", "in_progress"].includes(call.status) && permitted("phone");
  }
  async function onVerifiedCallTranscript(input: IntegrationContext & { callSid: string; text: string }): Promise<string | null> {
    // Only Twilio's already passkey-verified media callback may invoke this hook.
    if (!await phoneAllowed(input)) return null;
    if (!input.text.trim() || input.text.length > 4000) return "Please keep this turn under four thousand characters.";
    const channel = state().phone, binding = channel?.questionCallSid === input.callSid ? channel.question : null;
    // The verified speech transport supplies distinct turns. Repeating the same
    // words deliberately is a new turn; text is not an idempotency key.
    const sequence = mutate(current => ++current.phoneSequence);
    const id = `phone-${hash(JSON.stringify([input.callSid, sequence])).slice(0, 48)}`;
    const started = Date.now(), maximum = Math.min(15000, Math.max(1, options.phoneWaitMs ?? 15000));
    let spokenQuestion: { binding: QuestionBinding; conversationId: string } | undefined, timedOut = false;
    const work = serial("phone", async () => {
      if (!await phoneAllowed(input)) return null;
      if (binding) return answer(id, "phone", binding, input.text, () => phoneAllowed(input));
      if (genericConsent.test(input.text)) return "Spoken agreement on this call cannot authorize an external action. Use the exact secure review in Jarvis.";
      const value = await submit(id, "phone", input.text, () => phoneAllowed(input));
      if (!value.taskId) return value.phase === "done" ? "A new conversation is ready." : "The request's submission is uncertain. Inspect Jarvis before repeating it.";
      while (Date.now() - started < maximum) {
        const task = await readTask(value.taskId, value.conversationId ?? undefined); patch(value.id, { status: task.status });
        if (!await phoneAllowed(input)) return null;
        if (task.status === "waiting") {
          await proposals(task); const question = bindingFor(task), card = question ? currentQuestion(task, question) : undefined;
          if (question && card) { spokenQuestion = { binding: question, conversationId: task.conversationId }; return `${card.title} ${card.detail} ${card.options.map(option => option.label).join(". ")}`.slice(0, 1200); }
          return "That work needs exact secure action review. Open Jarvis to inspect and confirm it.";
        }
        if (terminal(task)) return task.reply ? task.reply.slice(0, 1200) : `That task is ${task.status}. Open Jarvis to inspect the result.`;
        await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, maximum - (Date.now() - started)))));
      }
      return "That work is continuing in the background. Its status and result will be available in Jarvis.";
    }).catch(() => "I could not confirm that request's state. It was not automatically retried. Inspect Jarvis before repeating it.");
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([work, new Promise<string>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(entry(id)?.taskId ? "That work is continuing in the background. Check Jarvis for its result." : "I am still checking whether the request started. Inspect Jarvis before repeating it."); }, maximum); })]);
      if (!await phoneAllowed(input)) return null;
      // A late result after the speaking deadline must not bind an unheard
      // question to the caller's next utterance.
      if (!timedOut && spokenQuestion) mutate(current => {
        if (current.phone?.conversationId === spokenQuestion!.conversationId) {
          current.phone.question = spokenQuestion!.binding; current.phone.questionCallSid = input.callSid;
        }
      });
      return result;
    } finally { if (timer) clearTimeout(timer); }
  }
  return { onTelegramMessage, onVerifiedCallTranscript, notifyPending };
}
