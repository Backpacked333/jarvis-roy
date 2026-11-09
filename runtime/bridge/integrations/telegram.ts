import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NumericOwnerId, OutboxInputSchema, QuestionBindingSchema, type IntegrationContext, type IntegrationHooks, type OutboxRecord, type QuestionBinding } from "./contracts.ts";
import { IntegrationTransport } from "./transport.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const updateSchema = z.object({ update_id: z.number().int().nonnegative(), message: z.object({
  message_id: z.number().int().positive(), text: z.string().max(4096).optional(),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  from: z.object({ id: z.number().int().safe(), is_bot: z.boolean() }).optional(),
  reply_to_message: z.object({ message_id: z.number().int().positive() }).optional(),
}).optional() });
type Inbox = { id: string; status: "received" | "dispatching" | "delivered" | "unknown"; update: z.infer<typeof updateSchema> };
export interface TelegramOptions { botToken: string; ownerChatId: string; timeZone: string; context: IntegrationContext }

export class TelegramIntegration {
  private polling = false;
  private flushing = false;
  private readonly transport: IntegrationTransport;
  private readonly options: TelegramOptions;
  private readonly hooks: IntegrationHooks;
  constructor(transport: IntegrationTransport, options: TelegramOptions, hooks: IntegrationHooks) {
    this.transport = transport; this.options = options; this.hooks = hooks;
    NumericOwnerId.parse(options.ownerChatId);
    if (!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,200}$/.test(options.botToken)) throw new Error("Invalid Telegram bot token");
    new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone }).format(new Date());
    const previous = this.store.get<{ ownerChatId: string }>("telegram", "owner");
    if (previous && previous.ownerChatId !== options.ownerChatId) throw new Error("Telegram owner cannot change without explicit unpairing");
  }
  private get store() { return this.transport.store; }
  private now(): string { return this.transport.now().toISOString(); }
  private local(at: string) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: this.options.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
    const part = (type: string) => parts.find(item => item.type === type)!.value;
    return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
  }
  private api(method: string): URL { return new URL(`https://api.telegram.org/bot${this.options.botToken}/${method}`); }
  paired(): boolean { return this.store.get<{ ownerChatId: string }>("telegram", "owner")?.ownerChatId === this.options.ownerChatId; }
  /** Native setup only. The numeric private owner identity is fixed in configuration. */
  beginPairing(): { code: string; expiresAt: string } {
    const code = String(randomInt(100000, 1000000)), expiresAt = new Date(this.transport.now().getTime() + 600_000).toISOString();
    this.store.put("telegram", "pair", { hash: digest(code), expiresAt }); return { code, expiresAt };
  }
  unpair(): void { this.store.remove("telegram", "owner"); this.store.remove("telegram", "pair"); this.stopOutbound(); }
  stopped(): boolean { return this.store.get<{ stopped: boolean }>("telegram", "control")?.stopped ?? false; }
  resume(): void { this.store.put("telegram", "control", { stopped: false }); }
  stopOutbound(): void {
    this.store.transaction(() => {
      this.store.put("telegram", "control", { stopped: true });
      for (const item of this.store.list<OutboxRecord>("outbox")) if (item.status === "queued") this.store.put("outbox", item.id, { ...item, status: "cancelled" });
    });
  }
  async pollOnce(signal?: AbortSignal): Promise<{ received: number }> {
    if (this.polling) return { received: 0 }; this.polling = true;
    try {
      const cursor = this.store.get<{ offset: number }>("telegram", "cursor")?.offset ?? 0;
      const body = await this.transport.request(this.api("getUpdates"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset: cursor, timeout: 20, limit: 100, allowed_updates: ["message"] }) }, this.options.context, "telegramRequestUsd", signal);
      const response = z.object({ ok: z.literal(true), result: z.array(updateSchema).max(100) }).parse(body);
      const updates = response.result.sort((a, b) => a.update_id - b.update_id);
      // /stop is processed ahead of any ordinary message in the received batch.
      const owned = (update: z.infer<typeof updateSchema>) => update.message?.chat.type === "private" && String(update.message.chat.id) === this.options.ownerChatId && String(update.message.from?.id) === this.options.ownerChatId && update.message.from?.is_bot === false;
      const stopHandled = new Set<number>();
      for (const update of updates) if (update.update_id >= cursor && !this.store.get("inbox", `telegram-${update.update_id}`) && owned(update) && update.message?.text?.trim() === "/stop" && this.paired()) {
        stopHandled.add(update.update_id);
        this.stopOutbound(); await this.hooks.onStop();
      }
      let received = 0;
      for (const update of updates) {
        signal?.throwIfAborted();
        const id = `telegram-${update.update_id}`;
        if (update.update_id < cursor || this.store.get("inbox", id)) continue;
        this.store.transaction(() => {
          this.store.put("inbox", id, { id, status: "received", update } satisfies Inbox);
          this.store.put("telegram", "cursor", { offset: update.update_id + 1 });
        });
        if (!owned(update) || !update.message?.text) { this.store.put("inbox", id, { id, status: "delivered", update }); continue; }
        const message = update.message, text = message.text!.trim();
        if (!this.paired()) {
          const pair = this.store.get<{ hash: string; expiresAt: string }>("telegram", "pair"), code = /^\/start ([0-9]{6})$/.exec(text)?.[1];
          if (pair && code && Date.parse(pair.expiresAt) > this.transport.now().getTime() && safeEqual(pair.hash, digest(code))) {
            this.store.transaction(() => { this.store.put("telegram", "owner", { ownerChatId: this.options.ownerChatId, pairedAt: this.now() }); this.store.remove("telegram", "pair"); });
          }
          this.store.put("inbox", id, { id, status: "delivered", update }); continue;
        }
        if (text === "/stop") {
          if (!stopHandled.has(update.update_id)) { this.stopOutbound(); await this.hooks.onStop(); }
          this.store.put("inbox", id, { id, status: "delivered", update }); continue;
        }
        const parsedBinding = QuestionBindingSchema.safeParse(message.reply_to_message ? this.store.get("question", String(message.reply_to_message.message_id)) : undefined);
        const binding = parsedBinding.success ? parsedBinding.data : undefined;
        // A reply to an expired/unknown card never becomes an unbound generic answer.
        if (message.reply_to_message && (!binding || Date.parse(binding.expiresAt) <= this.transport.now().getTime())) { this.store.put("inbox", id, { id, status: "delivered", update }); continue; }
        this.store.put("inbox", id, { id, status: "dispatching", update });
        try {
          await this.hooks.onTelegramMessage?.({ updateId: update.update_id, messageId: message.message_id, chatId: this.options.ownerChatId, text, question: binding ?? null });
          this.store.put("inbox", id, { id, status: "delivered", update }); received++;
        } catch { this.store.put("inbox", id, { id, status: "unknown", update }); }
      }
      return { received };
    } finally { this.polling = false; }
  }
  enqueue(raw: unknown): OutboxRecord {
    const input = OutboxInputSchema.parse(raw), existing = this.store.get<OutboxRecord>("outbox", input.id);
    if (existing) {
      for (const key of Object.keys(input) as (keyof typeof input)[]) if (JSON.stringify(existing[key]) !== JSON.stringify(input[key])) throw new Error("Outbox request identity changed");
      return existing;
    }
    if (input.kind === "question" && !input.question || input.kind !== "question" && input.question) throw new Error("Question notifications require their exact question binding");
    if (input.question?.kind === "task" && input.question.projectId !== input.projectId) throw new Error("Task question belongs to another project");
    const record: OutboxRecord = { ...input, version: 1, status: "queued", createdAt: this.now(), sentAt: null, messageId: null };
    this.store.put("outbox", input.id, record); return record;
  }
  async scheduleDigests(): Promise<void> {
    if (this.stopped() || !this.paired()) return;
    const local = this.local(this.now()); if (local.hour !== 9 && local.hour !== 18) return;
    const slot = local.hour === 9 ? "09" : "18", id = `digest-${local.day}-${slot}`;
    if (this.store.get("outbox", id)) return;
    const text = await this.hooks.digest?.(slot, this.options.context);
    if (text) this.enqueue({ id, ...this.options.context, kind: "digest", disclosure: "project_details", text, notBefore: this.now(), question: null });
  }
  async flushOnce(signal?: AbortSignal): Promise<{ sent: number }> {
    if (this.flushing || this.stopped() || !this.paired()) return { sent: 0 }; this.flushing = true;
    try {
      let sent = 0;
      for (const item of this.store.list<OutboxRecord>("outbox").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        signal?.throwIfAborted(); if (this.stopped()) break;
        if (item.status !== "queued" || Date.parse(item.notBefore) > this.transport.now().getTime()) continue;
        const local = this.local(this.now()), routine = item.kind !== "reply";
        if (routine && (local.hour >= 22 || local.hour < 8)) continue;
        if (routine && this.store.list<OutboxRecord>("outbox").filter(record => record.kind !== "reply" && record.sentAt && this.local(record.sentAt).day === local.day && ["sending", "sent", "unknown"].includes(record.status)).length >= 4) continue;
        const disclosureAllowed = () => item.disclosure === "minimal" || this.hooks.authorizeDisclosure?.({ projectId: item.projectId, channel: "telegram", destinationId: this.options.ownerChatId, proactive: routine }) === true;
        if (!disclosureAllowed()) { this.store.put("outbox", item.id, { ...item, status: "cancelled" }); continue; }
        if (item.question && Date.parse(item.question.expiresAt) <= this.transport.now().getTime()) { this.store.put("outbox", item.id, { ...item, status: "cancelled" }); continue; }
        let dispatched = false;
        try {
          const result = await this.transport.request(this.api("sendMessage"), { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: this.options.ownerChatId, text: item.text, ...(item.question ? { reply_markup: { force_reply: true, selective: true } } : {}) }) }, item, "telegramRequestUsd", signal,
            () => {
              if (this.stopped() || !disclosureAllowed()) { this.store.put("outbox", item.id, { ...item, status: "cancelled" }); throw new Error("Outbound messages stopped or disclosure grant changed"); }
              this.store.put("outbox", item.id, { ...item, status: "sending", sentAt: this.now() }); dispatched = true;
            });
          const receipt = z.object({ ok: z.literal(true), result: z.object({ message_id: z.number().int().positive(), chat: z.object({ id: z.number().int().safe() }) }) }).parse(result);
          if (String(receipt.result.chat.id) !== this.options.ownerChatId) throw new Error("Telegram receipt belongs to another chat");
          this.store.transaction(() => {
            this.store.put("outbox", item.id, { ...item, status: "sent", sentAt: this.now(), messageId: receipt.result.message_id });
            if (item.question) this.store.put("question", String(receipt.result.message_id), item.question);
          }); sent++;
        } catch (error) {
          if (dispatched) this.store.put("outbox", item.id, { ...item, status: "unknown", sentAt: this.now() });
          throw error;
        }
      }
      return { sent };
    } finally { this.flushing = false; }
  }
  outbox(): OutboxRecord[] { return this.store.list("outbox"); }
}
