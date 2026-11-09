import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { ContextSchema, IntegrationId, type CallProof, type IntegrationApprovalAuthority, type IntegrationContext, type IntegrationHooks, type IntegrationLedger, type IntegrationPrices } from "./contracts.ts";
import { IntegrationStore } from "./store.ts";
import { IntegrationTransport } from "./transport.ts";
import { TelegramIntegration, type TelegramOptions } from "./telegram.ts";
import { GoogleIntegration, type GoogleOptions } from "./google.ts";
import { TwilioIntegration, type TwilioOptions } from "./twilio.ts";
import type { TelephonySpeechAdapter } from "./speech.ts";
import { OutreachPolicies } from "./outreach.ts";

export * from "./contracts.ts";
export * from "./google.ts";
export * from "./telegram.ts";
export * from "./twilio.ts";
export * from "./speech.ts";
export * from "./audio.ts";
export * from "./outreach.ts";
export { IntegrationStore } from "./store.ts";
export interface IntegrationOptions {
  dataDirectory: string; enabled?: boolean; encryptionKey?: Uint8Array; fetch?: typeof fetch; now?: () => Date;
  ledger: IntegrationLedger; prices: IntegrationPrices; hooks: IntegrationHooks;
  telegram?: TelegramOptions; google?: GoogleOptions; twilio?: TwilioOptions;
  approvalAuthority?: IntegrationApprovalAuthority; speech?: TelephonySpeechAdapter;
}
/** Trusted runtime orchestration only. Provider callbacks authenticate their own
 * signatures/state; account mutation methods must be exposed only to the owner. */
export class IntegrationService {
  readonly enabled: boolean;
  readonly telegram?: TelegramIntegration; readonly google?: GoogleIntegration; readonly twilio?: TwilioIntegration;
  private readonly store?: IntegrationStore;
  private readonly options: IntegrationOptions;
  private readonly outreach?: OutreachPolicies;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 16000, perMessageDeflate: false });
  private loop?: Promise<void>; private controller?: AbortController;
  private constructor(options: IntegrationOptions, store?: IntegrationStore) {
    this.options = options; this.enabled = options.enabled ?? process.env.JARVIS_ENABLE_INTEGRATIONS === "1"; this.store = store;
    if (!store) return;
    this.outreach = new OutreachPolicies(store, options.twilio?.timeZone ?? options.telegram?.timeZone ?? "UTC", options.now ?? (() => new Date()));
    const transport = new IntegrationTransport(store, options.ledger, options.prices, options.fetch, options.now);
    const hooks: IntegrationHooks = { ...options.hooks,
      authorizeCallOutreach: input => this.outreach!.allows(input.projectId, input.category ?? "blocking_deadline") && options.hooks.authorizeCallOutreach?.({ projectId: input.projectId, destinationId: input.destinationId }) === true,
      onStop: () => this.performStop(true) };
    if (options.telegram) this.telegram = new TelegramIntegration(transport, options.telegram, hooks);
    if (options.google) this.google = new GoogleIntegration(transport, options.google, hooks, options.approvalAuthority);
    if (options.twilio) this.twilio = new TwilioIntegration(transport, options.twilio, hooks, options.speech);
  }
  static async open(options: IntegrationOptions): Promise<IntegrationService> {
    if (!(options.enabled ?? process.env.JARVIS_ENABLE_INTEGRATIONS === "1")) return new IntegrationService(options);
    if (!options.encryptionKey) throw new Error("A private integration encryption key is required");
    const store = new IntegrationStore(options.encryptionKey);
    try { await store.open(options.dataDirectory); return new IntegrationService(options, store); }
    catch (error) { store.close(); throw error; }
  }
  private requireEnabled(): IntegrationStore { if (!this.enabled || !this.store) throw new Error("Integrations are disabled"); return this.store; }
  status() {
    const owner = this.store?.get<{ number: string; accountSid: string }>("twilio", "owner");
    return { version: 1 as const, enabled: this.enabled, stopped: this.store?.get<{ stopped: boolean }>("control", "global")?.stopped ?? false,
      stopStatus: this.store?.get<{ status: "stopping" | "confirmed" | "uncertain" }>("control", "stop_status")?.status ?? "not_requested",
      telegram: { configured: !!this.telegram, paired: this.telegram?.paired() ?? false, ownerChatId: this.options.telegram?.ownerChatId ?? null },
      google: { configured: !!this.google, accounts: this.google?.accounts().map(account => ({ ...account, consents: Object.keys(this.store!.get<{ credentials: object }>("google_account", account.id)!.credentials) })) ?? [] },
      twilio: { configured: !!this.twilio, ownerNumber: this.options.twilio?.ownerNumber ?? null, ownerVerified: !!owner && owner.number === this.options.twilio?.ownerNumber && owner.accountSid === this.options.twilio?.accountSid } };
  }
  readCursor<T = unknown>(name: string): T | undefined { return this.requireEnabled().get<T>("runtime_cursor", IntegrationId.parse(name)); }
  writeCursor(name: string, value: unknown): void { this.requireEnabled().put("runtime_cursor", IntegrationId.parse(name), value); }
  async readCall(callSid: string) { return this.twilio?.readCall(callSid) ?? null; }
  async verifiedCall(callSid: string) { return this.twilio?.currentVerifiedCall(callSid) ?? null; }
  revokeCallAuthorizations(): void {
    for (const socket of this.sockets.clients) socket.close(1000, "Call authorization revoked");
    this.twilio?.revokeAuthorizations();
  }
  async authorizeCall(callSid: string, proof: CallProof): Promise<void> { if (!this.twilio) throw new Error("Calling is not configured"); return this.twilio.authorizeCall(callSid, proof); }
  readOutreachPolicy(projectId: string) { this.requireEnabled(); return this.outreach!.read(projectId); }
  updateOutreachPolicy(raw: unknown) { this.requireEnabled(); return this.outreach!.update(raw); }
  async requestCallWhenReady(raw: unknown) { this.requireEnabled(); return this.outreach!.requestReady(raw, this.options.hooks.readObjective); }
  async considerObjectiveCall(raw: unknown) {
    this.requireEnabled(); if (!this.twilio || this.status().stopped) return null;
    const candidate = this.outreach!.blockingCandidate(raw, this.telegram?.outbox() ?? []);
    if (candidate && !this.twilio.calls().some(call => call.issueId === candidate.issueId)) return this.twilio.startPriorityCall(candidate);
    const ready = this.outreach!.consumeReady(raw); return ready ? this.twilio.startReadyCall(ready) : null;
  }
  private stopLocal(): void {
    if (!this.store) return;
    this.google?.cancelReads();
    for (const socket of this.sockets.clients) socket.close(1000, "Stopped");
    this.twilio?.stop(); this.store.put("control", "global", { stopped: true }); this.store.put("control", "stop_status", { status: "stopping" }); this.telegram?.stopOutbound(); this.outreach?.cancelPending();
  }
  private async performStop(includeRootHook: boolean): Promise<void> {
    const attempt = (operation: () => void | Promise<void>): Promise<void> => {
      try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
    };
    const operations = [attempt(() => this.stopLocal()), attempt(() => this.twilio?.cancelCalls())];
    if (includeRootHook) operations.push(attempt(() => this.options.hooks.onStop()));
    const results = await Promise.allSettled(operations), failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      try { this.store?.put("control", "stop_status", { status: "uncertain", failedOperations: failures.length }); } catch {}
      throw new AggregateError(failures.map(result => result.reason), "Stop is incomplete; one or more cancellations remain unconfirmed.");
    }
    this.store?.put("control", "stop_status", { status: "confirmed" });
  }
  async stop(): Promise<void> { return this.performStop(false); }
  resume(): void { this.requireEnabled().put("control", "global", { stopped: false }); this.telegram?.resume(); this.twilio?.resume(); }
  async tick(signal?: AbortSignal): Promise<void> {
    this.requireEnabled(); signal?.throwIfAborted();
    // Polling remains available while stopped so the owner can still reach Jarvis.
    const tasks: Promise<unknown>[] = [];
    if (this.telegram) tasks.push(this.telegram.pollOnce(signal));
    if (!this.status().stopped) {
      for (const account of this.google?.accounts() ?? []) tasks.push(this.google!.pollOnce(account.id, signal));
      if (this.telegram) tasks.push(this.telegram.scheduleDigests().then(() => this.telegram!.flushOnce(signal)));
    }
    const results = await Promise.allSettled(tasks);
    signal?.throwIfAborted();
    if (results.some(result => result.status === "rejected")) this.store!.put("control", "poll_status", { lastFailureAt: (this.options.now?.() ?? new Date()).toISOString(), message: "One integration operation failed; inspect its durable state before retrying effects." });
  }
  start(): void {
    this.requireEnabled(); if (this.loop) return;
    this.controller = new AbortController(); const signal = this.controller.signal;
    this.loop = (async () => {
      while (!signal.aborted) {
        try { await this.tick(signal); } catch { if (signal.aborted) break; }
        await new Promise<void>(resolve => { const timer = setTimeout(done, 1000); timer.unref(); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
      }
    })();
  }
  /** Root calls this only after native or owner-session setup authentication. */
  async setup(method: string, pathname: string, body: unknown): Promise<unknown> {
    this.requireEnabled();
    if (method === "GET" && pathname === "/v1/integrations/status") return this.status();
    if (method === "POST" && pathname === "/v1/integrations/telegram/pair" && this.telegram) { z.strictObject({}).parse(body); return this.telegram.beginPairing(); }
    if (method === "POST" && pathname === "/v1/integrations/google/connect" && this.google) return this.google.beginOAuth(body);
    if (method === "POST" && pathname === "/v1/integrations/google/permissions" && this.google) return this.google.updateConsent(body);
    if (method === "POST" && pathname === "/v1/integrations/twilio/verify-owner" && this.twilio) { await this.twilio.verifyOwnerNumber(ContextSchema.parse(body)); return this.status(); }
    if (pathname === "/v1/integrations/outreach/policy") {
      if (method === "GET") return this.readOutreachPolicy(body && typeof body === "object" && "projectId" in body ? IntegrationId.parse(body.projectId) : this.options.telegram?.context.projectId ?? "personal");
      if (method === "POST") return this.updateOutreachPolicy(body);
    }
    if (method === "POST" && pathname === "/v1/integrations/outreach/ready-request") return this.requestCallWhenReady(body);
    throw new Error("Integration setup operation unavailable");
  }
  /** Only authenticated provider ingress is handled here, never owner controls. */
  async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/v1/cloud/integrations/")) return false;
    const reply = (status: number, content: string, type = "text/plain; charset=utf-8") => { response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(content); };
    try {
      this.requireEnabled();
      if (url.pathname === "/v1/cloud/integrations/google/callback" && request.method === "GET" && this.google) {
        await this.google.completeOAuth(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? ""); reply(200, "Google connected. Return to Jarvis to inspect the selected sources."); return true;
      }
      if (["/v1/cloud/integrations/twilio/voice", "/v1/cloud/integrations/twilio/status"].includes(url.pathname) && request.method === "POST" && this.twilio) {
        if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") throw new Error("Expected Twilio form body");
        const parts: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 64000) throw new Error("Webhook too large"); parts.push(Buffer.from(chunk)); }
        const parameters: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(Buffer.concat(parts).toString("utf8"))) { if (Object.hasOwn(parameters, key)) throw new Error("Duplicate webhook field"); parameters[key] = value; }
        const signature = typeof request.headers["x-twilio-signature"] === "string" ? request.headers["x-twilio-signature"] : undefined;
        if (url.pathname.endsWith("/voice")) reply(200, this.twilio.voiceWebhook(url.href, parameters, signature), "application/xml; charset=utf-8");
        else { await this.twilio.statusWebhook(url.href, parameters, signature); reply(204, ""); }
        return true;
      }
      reply(404, "Not found"); return true;
    } catch { if (!response.headersSent) reply(403, "Integration callback rejected"); else response.destroy(); return true; }
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
    if (url.pathname !== "/v1/cloud/integrations/twilio/media") return false;
    const signature = typeof request.headers["x-twilio-signature"] === "string" ? request.headers["x-twilio-signature"] : undefined;
    if (!this.enabled || !this.twilio || !this.twilio.verifyWebhook(url.href, {}, signature)) { socket.destroy(); return true; }
    this.sockets.handleUpgrade(request, socket, head, client => {
      const media = this.twilio!.openMediaConnection(url.href, signature, frame => {
        if (client.bufferedAmount > 64000) { client.close(1009, "Audio overflow"); return; }
        client.send(JSON.stringify(frame));
      });
      this.sockets.emit("connection", client, request);
      let queued = 0, chain = Promise.resolve();
      client.on("message", (raw, binary) => {
        if (binary || ++queued > 100) { client.close(1008, "Invalid media"); return; }
        chain = chain.then(() => media.receive(raw.toString())).catch(() => { client.close(1008, "Invalid media"); }).finally(() => { queued--; });
      });
      client.on("close", () => media.close()); client.on("error", () => media.close());
    }); return true;
  }
  async close(): Promise<void> {
    this.controller?.abort(); this.google?.cancelReads(); this.twilio?.revokeAuthorizations();
    for (const socket of this.sockets.clients) socket.terminate();
    await this.loop; await new Promise<void>(resolve => this.sockets.close(() => resolve())); this.store?.close();
  }
}
