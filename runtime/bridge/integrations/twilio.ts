import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CallSid, ContextSchema, IntegrationId, PhoneNumber, type CallProof, type CallRecord, type IntegrationHooks } from "./contracts.ts";
import { IntegrationTransport } from "./transport.ts";
import { muLaw8kToPcm16k, pcmToMuLaw8k } from "./audio.ts";
import type { TelephonySpeechAdapter, TelephonySpeechSession } from "./speech.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const xml = (value: string) => value.replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);
export interface TwilioOptions { accountSid: string; authToken: string; fromNumber: string; ownerNumber: string; publicBaseUrl: string; timeZone: string }
export const PriorityCallSchema = ContextSchema.extend({ id: IntegrationId, issueId: IntegrationId,
  deadlineAt: z.iso.datetime(), unansweredSince: z.iso.datetime(), blocked: z.literal(true) });
export class TwilioIntegration {
  private readonly sessions = new Set<{ stop(): void }>();
  private initiating = false;
  private readonly transport: IntegrationTransport; private readonly options: TwilioOptions;
  private readonly hooks: IntegrationHooks; private readonly speech?: TelephonySpeechAdapter;
  constructor(transport: IntegrationTransport, options: TwilioOptions, hooks: IntegrationHooks, speech?: TelephonySpeechAdapter) {
    this.transport = transport; this.options = options; this.hooks = hooks; this.speech = speech;
    if (!/^AC[0-9a-fA-F]{32}$/.test(options.accountSid) || !options.authToken) throw new Error("Twilio credentials required");
    PhoneNumber.parse(options.ownerNumber); PhoneNumber.parse(options.fromNumber);
    const base = new URL(options.publicBaseUrl);
    if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash || base.username || base.password) throw new Error("Twilio public origin must be HTTPS");
    new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone }).format(new Date());
  }
  private get store() { return this.transport.store; }
  private auth(): string { return `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`; }
  private endpoint(path: string): URL { return new URL(`https://api.twilio.com/2010-04-01/Accounts/${this.options.accountSid}/${path}`); }
  private day(at: string): string { return new Intl.DateTimeFormat("en-CA", { timeZone: this.options.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at)); }
  private call(callSid: string): CallRecord | undefined { CallSid.parse(callSid); return this.store.list<CallRecord>("call").find(call => call.callSid === callSid); }
  async verifyOwnerNumber(context: z.infer<typeof ContextSchema>, signal?: AbortSignal): Promise<void> {
    const url = this.endpoint("OutgoingCallerIds.json"); url.searchParams.set("PhoneNumber", this.options.ownerNumber); url.searchParams.set("PageSize", "100");
    const result = z.object({ outgoing_caller_ids: z.array(z.object({ phone_number: z.string() })) }).parse(await this.transport.request(url, { headers: { authorization: this.auth() } }, context, "twilioRequestUsd", signal));
    if (!result.outgoing_caller_ids.some(item => item.phone_number === this.options.ownerNumber)) throw new Error("Verify the owner number in this Twilio account before enabling calls");
    this.store.put("twilio", "owner", { accountSid: this.options.accountSid, number: this.options.ownerNumber, verifiedAt: this.transport.now().toISOString() });
  }
  async startPriorityCall(raw: unknown, signal?: AbortSignal): Promise<CallRecord> {
    if (this.store.get<{ stopped: boolean }>("twilio", "control")?.stopped) throw new Error("Calling is stopped");
    const input = PriorityCallSchema.parse(raw), previous = this.store.get<CallRecord>("call", input.id);
    if (previous) { if (previous.issueId !== input.issueId || previous.projectId !== input.projectId) throw new Error("Call request identity changed"); return previous; }
    if (this.initiating) throw new Error("A call is already being initiated");
    const owner = this.store.get<{ accountSid: string; number: string }>("twilio", "owner");
    if (owner?.number !== this.options.ownerNumber || owner.accountSid !== this.options.accountSid || !this.speech) throw new Error("Verified owner number and shared speech adapter required");
    if (this.hooks.authorizeCallOutreach?.({ projectId: input.projectId, destinationId: this.options.ownerNumber }) !== true) throw new Error("Owner phone outreach permission required");
    const now = this.transport.now(), remaining = Date.parse(input.deadlineAt) - now.getTime();
    if (remaining <= 0 || remaining > 3_600_000 || now.getTime() - Date.parse(input.unansweredSince) < 600_000) throw new Error("Priority calls require a blocked deadline within 60 minutes and an unanswered question for 10 minutes");
    const recent = this.store.list<CallRecord>("call").filter(call => this.day(call.createdAt) === this.day(now.toISOString()));
    if (recent.length >= 2 || recent.some(call => call.issueId === input.issueId) || recent.some(call => now.getTime() - Date.parse(call.createdAt) < 300_000)) throw new Error("Daily call, one-issue, or five-minute spacing limit reached");
    const estimatedUsd = this.transport.price("twilioMinuteUsd") * 5 + this.transport.price("elevenLabsMinuteUsd") * 5 + this.transport.price("elevenLabsCharacterUsd") * 10_000;
    if (estimatedUsd > 5) throw new Error("A bounded priority call exceeds the $5 operation limit");
    this.initiating = true;
    try {
      const reservation = await this.transport.ledger.reserve({ projectId: input.projectId, objectiveId: input.objectiveId, requestId: hash(`call:${input.id}`), authority: "integration:priority_call", estimatedUsd });
      const mediaToken = randomBytes(32).toString("base64url");
      const record: CallRecord = { version: 1, id: input.id, issueId: input.issueId, projectId: input.projectId, objectiveId: input.objectiveId,
        callSid: null, status: "initiating", createdAt: now.toISOString(), deadlineAt: input.deadlineAt, verifiedUntil: null, verification: null,
        mediaTokenHash: hash(mediaToken), streamSid: null, reservationId: reservation.id, estimatedUsd, chargedUsd: null, speechInputBytes: 0, speechOutputChars: 0 };
      this.store.put("call", input.id, record); this.store.put("call_token", input.id, { encrypted: this.store.seal("call_token", input.id, mediaToken) });
      let dispatched = false;
      try {
        const callback = new URL("/v1/cloud/integrations/twilio/voice", this.options.publicBaseUrl); callback.searchParams.set("id", input.id);
        const status = new URL("/v1/cloud/integrations/twilio/status", this.options.publicBaseUrl); status.searchParams.set("id", input.id);
        const receipt = z.object({ sid: CallSid, to: z.string(), from: z.string(), status: z.string() }).parse(await this.transport.request(this.endpoint("Calls.json"), {
          method: "POST", headers: { authorization: this.auth(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ To: this.options.ownerNumber, From: this.options.fromNumber,
            Url: callback.href, Method: "POST", StatusCallback: status.href, StatusCallbackMethod: "POST", "StatusCallbackEvent": "completed", TimeLimit: "300", Timeout: "30", Record: "false" }).toString(),
        }, input, "twilioRequestUsd", signal, () => {
          if (this.store.get<{ stopped: boolean }>("twilio", "control")?.stopped || this.hooks.authorizeCallOutreach?.({ projectId: input.projectId, destinationId: this.options.ownerNumber }) !== true) throw new Error("Calling stopped or owner phone outreach permission changed"); dispatched = true;
        }));
        if (receipt.to !== this.options.ownerNumber || receipt.from !== this.options.fromNumber) throw new Error("Twilio returned an unexpected phone identity");
        const current = this.store.get<CallRecord>("call", input.id)!;
        if (current.callSid && current.callSid !== receipt.sid) throw new Error("Twilio call receipt changed identity");
        const saved: CallRecord = { ...current, callSid: receipt.sid, status: current.status === "initiating" ? "ringing" : current.status };
        this.store.put("call", input.id, saved); return saved;
      } catch {
        this.store.put("call", input.id, { ...this.store.get<CallRecord>("call", input.id)!, status: dispatched ? "unknown" : "failed" });
        await this.transport.ledger.settle(reservation.id, { accounting: dispatched ? "unknown" : "measured", estimatedUsd: dispatched ? null : 0 });
        throw new Error("Call was not confirmed; it will not be retried automatically");
      }
    } finally { this.initiating = false; }
  }
  verifyWebhook(url: string, parameters: Record<string, string>, signature: string | undefined): boolean {
    if (!signature || signature.length > 100) return false;
    try {
      const parsed = new URL(url), base = new URL(this.options.publicBaseUrl);
      if (parsed.origin !== base.origin || !parsed.pathname.startsWith("/v1/cloud/integrations/twilio/") || parsed.hash || parsed.username || parsed.password) return false;
      const message = url + Object.keys(parameters).sort().map(key => key + parameters[key]).join("");
      return equal(createHmac("sha1", this.options.authToken).update(message).digest("base64"), signature);
    } catch { return false; }
  }
  voiceWebhook(url: string, parameters: Record<string, string>, signature: string | undefined): string {
    if (!this.verifyWebhook(url, parameters, signature)) throw new Error("Unauthenticated Twilio webhook");
    const id = IntegrationId.parse(new URL(url).searchParams.get("id")), record = this.store.get<CallRecord>("call", id);
    const sid = CallSid.parse(parameters.CallSid);
    if (!record || !["initiating", "ringing", "in_progress"].includes(record.status) || record.callSid && record.callSid !== sid || parameters.AccountSid !== this.options.accountSid || parameters.To !== this.options.ownerNumber || parameters.From !== this.options.fromNumber) throw new Error("Unexpected owner call");
    this.store.put("call", id, { ...record, callSid: sid, status: "in_progress" });
    const token = this.store.get<{ encrypted: string }>("call_token", id); if (!token) throw new Error("Call media token unavailable");
    const media = new URL("/v1/cloud/integrations/twilio/media", this.options.publicBaseUrl); media.protocol = "wss:";
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Jarvis needs your attention. Open your trusted Jarvis review page and verify this call to continue.</Say><Connect><Stream url="${xml(media.href)}"><Parameter name="token" value="${xml(this.store.unseal<string>("call_token", id, token.encrypted))}"/></Stream></Connect><Hangup/></Response>`;
  }
  async statusWebhook(url: string, parameters: Record<string, string>, signature: string | undefined): Promise<void> {
    if (!this.verifyWebhook(url, parameters, signature) || parameters.AccountSid !== this.options.accountSid) throw new Error("Unauthenticated Twilio status");
    const id = IntegrationId.parse(new URL(url).searchParams.get("id")), current = this.store.get<CallRecord>("call", id), sid = CallSid.parse(parameters.CallSid);
    if (!current || current.callSid && current.callSid !== sid) throw new Error("Unknown call status");
    if (!["completed", "busy", "failed", "no-answer", "canceled"].includes(parameters.CallStatus)) return;
    if (["completed", "failed"].includes(current.status)) {
      if (current.reservationId) await this.transport.ledger.settle(current.reservationId, { accounting: current.chargedUsd === null ? "unknown" : "measured", estimatedUsd: current.chargedUsd });
      return;
    }
    const duration = /^\d{1,4}$/.test(parameters.CallDuration ?? "") ? Number(parameters.CallDuration) : null;
    const measured = duration !== null && duration <= 300 && current.status !== "unknown";
    const chargedUsd = measured ? this.transport.price("twilioMinuteUsd") * Math.ceil(duration / 60) + this.transport.price("elevenLabsMinuteUsd") * current.speechInputBytes / 32_000 / 60 + this.transport.price("elevenLabsCharacterUsd") * current.speechOutputChars : null;
    this.store.put("call", id, { ...current, callSid: sid, status: parameters.CallStatus === "completed" ? "completed" : "failed", verification: null, verifiedUntil: null, chargedUsd });
    if (current.reservationId) await this.transport.ledger.settle(current.reservationId, { accounting: measured ? "measured" : "unknown", estimatedUsd: chargedUsd });
    this.stopSessions(sid);
  }
  readCall(callSid: string): { callSid: string; projectId: string; status: "ringing" | "in_progress" } | null {
    const call = this.call(callSid);
    return call && (call.status === "ringing" || call.status === "in_progress") && this.transport.now().getTime() - Date.parse(call.createdAt) < 330_000 ? { callSid, projectId: call.projectId, status: call.status } : null;
  }
  async authorizeCall(callSid: string, proof: CallProof): Promise<void> {
    proof = z.strictObject({ credentialId: z.string().min(1).max(500), ownerSessionId: z.string().min(1).max(500), verifiedAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).parse(proof);
    const live = this.readCall(callSid), call = this.call(callSid), now = this.transport.now().getTime();
    if (!live || !call || !proof.credentialId || !proof.ownerSessionId || Math.abs(now - Date.parse(proof.verifiedAt)) > 5000 || Date.parse(proof.expiresAt) <= now || Date.parse(proof.expiresAt) - now > 300_000) throw new Error("Fresh call-bound owner passkey verification required");
    this.store.put("call", call.id, { ...call, verification: proof, verifiedUntil: proof.expiresAt });
  }
  private verified(callSid: string): CallRecord | null {
    const call = this.call(callSid);
    return this.readCall(callSid) && call?.verifiedUntil && Date.parse(call.verifiedUntil) > this.transport.now().getTime() &&
      this.hooks.authorizeDisclosure?.({ projectId: call.projectId, channel: "phone", destinationId: this.options.ownerNumber, proactive: false }) === true ? call : null;
  }
  openMediaConnection(url: string, signature: string | undefined, send: (frame: unknown) => void): { receive(raw: string): Promise<void>; close(): void } {
    if (!this.verifyWebhook(url, {}, signature)) throw new Error("Authenticated Twilio WebSocket upgrade required");
    let callSid: string | null = null, streamSid: string | null = null, sequence = 0, speech: TelephonySpeechSession | undefined, opening: Promise<void> | undefined, output = Buffer.alloc(0);
    const controller = new AbortController();
    const session = { callSid: () => callSid, stop: () => { controller.abort(); speech?.close(); this.sessions.delete(session); } }; this.sessions.add(session);
    const receive = async (raw: string) => {
      if (controller.signal.aborted) throw new Error("Call media is closed");
      if (Buffer.byteLength(raw) > 16000) throw new Error("Call media frame too large");
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
      if (frame.event === "connected") return;
      if (frame.event === "start") {
        if (callSid) throw new Error("Call stream already bound");
        const start = z.object({ callSid: CallSid, streamSid: z.string().regex(/^MZ[0-9a-fA-F]{32}$/), accountSid: z.string(),
          mediaFormat: z.object({ encoding: z.literal("audio/x-mulaw"), sampleRate: z.literal(8000), channels: z.literal(1) }), customParameters: z.object({ token: z.string().length(43) }) }).parse(frame.start);
        const call = this.call(start.callSid);
        if (!this.readCall(start.callSid) || !call || call.streamSid || start.accountSid !== this.options.accountSid || !equal(call.mediaTokenHash, hash(start.customParameters.token))) throw new Error("Call stream identity does not match");
        callSid = start.callSid; streamSid = start.streamSid; this.store.put("call", call.id, { ...call, streamSid }); return;
      }
      if (!callSid || !streamSid || frame.streamSid !== streamSid) throw new Error("Unbound call media");
      if (frame.event === "stop") return session.stop();
      if (frame.event !== "media") return;
      const media = z.object({ track: z.literal("inbound"), chunk: z.string().regex(/^\d{1,9}$/), payload: z.string().max(11000) }).parse(frame.media);
      const chunk = Number(media.chunk); if (chunk !== sequence + 1) throw new Error("Call audio sequence changed"); sequence = chunk;
      const call = this.verified(callSid); if (!call) return; // Generic TwiML only before passkey; never forward unverified audio.
      if (!speech) {
        if (!opening) opening = this.speech!.open({ callSid, context: { roomId: call.projectId, conversationId: null, question: null }, signal: controller.signal,
          onAudio: pcm => {
            if (!callSid || !this.verified(callSid)) return session.stop();
            output = Buffer.concat([output, pcm]); const usable = output.length - output.length % 6;
            if (!usable) return; const encoded = pcmToMuLaw8k(output.subarray(0, usable), 24000); output = output.subarray(usable);
            for (let offset = 0; offset < encoded.length; offset += 160) send({ event: "media", streamSid, media: { payload: encoded.subarray(offset, offset + 160).toString("base64") } });
          },
          onTranscript: async text => {
            const live = callSid ? this.verified(callSid) : null; if (!live) return null;
            if (text.trim().toLowerCase() === "stop") { session.stop(); await this.hooks.onStop(); return null; }
            const answer = await this.hooks.onVerifiedCallTranscript?.({ projectId: live.projectId, objectiveId: live.objectiveId, callSid: callSid!, text });
            const current = callSid ? this.verified(callSid) : null;
            if (!current || !answer) return null;
            if (answer.length > 4000 || current.speechOutputChars + answer.length > 10000) { session.stop(); return null; }
            this.store.put("call", current.id, { ...current, speechOutputChars: current.speechOutputChars + answer.length }); return answer;
          }, onError: session.stop,
        }).then(result => { speech = result; }).catch(error => { session.stop(); throw error; });
        await opening;
      }
      const bytes = Buffer.from(media.payload, "base64");
      if (!bytes.length || bytes.length > 8000 || bytes.toString("base64") !== media.payload) throw new Error("Invalid µ-law frame");
      const pcm = muLaw8kToPcm16k(bytes), current = this.verified(callSid);
      if (!current || current.speechInputBytes + pcm.length > 9_600_000) return session.stop();
      this.store.put("call", current.id, { ...current, speechInputBytes: current.speechInputBytes + pcm.length }); speech!.acceptPcm(pcm);
    };
    return { receive: async raw => { try { await receive(raw); } catch (error) { session.stop(); throw error; } }, close: session.stop };
  }
  private stopSessions(callSid?: string): void {
    for (const session of this.sessions) if (!callSid || (session as { callSid?: () => string | null }).callSid?.() === callSid) session.stop();
  }
  stop(): void {
    this.store.put("twilio", "control", { stopped: true });
    this.stopSessions();
    for (const call of this.store.list<CallRecord>("call")) if (["ringing", "in_progress"].includes(call.status)) this.store.put("call", call.id, { ...call, verifiedUntil: null, verification: null });
  }
  resume(): void { this.store.put("twilio", "control", { stopped: false }); }
  async cancelCalls(signal?: AbortSignal): Promise<void> {
    this.stop();
    const results = await Promise.allSettled(this.store.list<CallRecord>("call").filter(call => call.callSid && ["ringing", "in_progress"].includes(call.status)).map(async call => {
      const result = z.object({ sid: CallSid, status: z.literal("completed") }).parse(await this.transport.request(this.endpoint(`Calls/${call.callSid}.json`), {
        method: "POST", headers: { authorization: this.auth(), "content-type": "application/x-www-form-urlencoded" }, body: "Status=completed",
      }, call, "twilioRequestUsd", signal));
      if (result.sid !== call.callSid) throw new Error("Cancellation receipt changed call identity");
      const current = this.store.get<CallRecord>("call", call.id)!;
      if (["ringing", "in_progress"].includes(current.status)) this.store.put("call", call.id, { ...current, status: "unknown", verifiedUntil: null, verification: null });
      if (call.reservationId) await this.transport.ledger.settle(call.reservationId, { accounting: "unknown", estimatedUsd: null });
    }));
    if (results.some(result => result.status === "rejected")) throw new Error("Some call cancellations remain unconfirmed; private media is stopped");
  }
  calls(): CallRecord[] { return this.store.list("call"); }
}
