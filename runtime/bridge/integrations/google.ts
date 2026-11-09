import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../harness-contracts/validation.ts";
import { ContextSchema, IntegrationId, type ApprovedEffect, type GoogleChange, type IntegrationApprovalAuthority, type IntegrationContext, type IntegrationHooks } from "./contracts.ts";
import { IntegrationTransport, ProviderHttpError } from "./transport.ts";

const SCOPES = {
  read: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly"],
  gmail_send: ["https://www.googleapis.com/auth/gmail.send"],
  calendar_write: ["https://www.googleapis.com/auth/calendar.events"],
} as const;
type Consent = keyof typeof SCOPES;
const consentSchema = z.enum(["read", "gmail_send", "calendar_write"]);
const resource = z.string().min(1).max(300).refine(value => !/[\r\n\x00]/.test(value));
const beginSchema = ContextSchema.extend({ accountId: IntegrationId, consent: consentSchema,
  labels: z.array(resource).max(10).default([]), calendars: z.array(resource).max(10).default([]),
  retentionAllowed: z.boolean().default(false), cloudAllowed: z.boolean().default(false),
}).refine(value => !value.cloudAllowed || value.retentionAllowed, "Cloud reasoning requires separately approved retention");
type OAuthPending = z.infer<typeof beginSchema> & { stateHash: string; verifier: string; expiresAt: string; status: "pending" | "consumed"; generation: number };
type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: string; scopes: string[] };
export interface GoogleAccount extends IntegrationContext { id: string; subject: string; email: string; labels: string[]; calendars: string[]; credentials: Partial<Record<Consent, string>>; lastPollAt: string | null; revision: number; retentionAllowed: boolean; cloudAllowed: boolean }
export interface RetainedGoogleEntry extends GoogleChange { id: string; sourceRevision: string; accountRevision: number; updatedAt: string }
export interface GoogleOptions { clientId: string; clientSecret?: string; redirectUri: string }
const commonAction = { ...ContextSchema.shape, requestId: IntegrationId, accountId: IntegrationId };
export const GoogleActionInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...commonAction, kind: z.literal("gmail_send"), to: z.string().email().max(254), subject: z.string().max(200).refine(value => !/[\r\n]/.test(value)), text: z.string().min(1).max(20_000) }),
  z.strictObject({ ...commonAction, kind: z.literal("calendar_write"), calendarId: resource, summary: z.string().min(1).max(300), description: z.string().max(20_000), start: z.iso.datetime(), end: z.iso.datetime() }),
]);
export type GoogleAction = z.infer<typeof GoogleActionInputSchema>;
export interface PreparedGoogleAction { input: GoogleAction; digest: string; exactArguments: string }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenResponse = z.object({ access_token: z.string().min(1).max(10_000), refresh_token: z.string().max(10_000).optional(), expires_in: z.number().int().min(1).max(86_400), scope: z.string().max(10_000).optional(), token_type: z.string() });

export class GoogleIntegration {
  private readonly busy = new Set<string>();
  private readonly reads = new Map<string, AbortController>();
  private readonly transport: IntegrationTransport; private readonly options: GoogleOptions;
  private readonly hooks: IntegrationHooks; private readonly authority?: IntegrationApprovalAuthority;
  constructor(transport: IntegrationTransport, options: GoogleOptions,
    hooks: IntegrationHooks, authority?: IntegrationApprovalAuthority) {
    this.transport = transport; this.options = options; this.hooks = hooks; this.authority = authority;
    const redirect = new URL(options.redirectUri);
    if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash || redirect.search || redirect.pathname !== "/v1/cloud/integrations/google/callback") throw new Error("Google redirect must be the fixed HTTPS callback");
    if (!options.clientId || options.clientId.length > 500) throw new Error("Google client ID required");
  }
  private get store() { return this.transport.store; }
  private account(id: string): GoogleAccount { const account = this.store.get<GoogleAccount>("google_account", IntegrationId.parse(id)); if (!account) throw new Error("Google account not linked"); return account; }
  beginOAuth(raw: unknown): { url: string; expiresAt: string } {
    const input = beginSchema.parse(raw), current = this.store.get<GoogleAccount>("google_account", input.accountId);
    if (current && current.projectId !== input.projectId) throw new Error("Google account belongs to another project");
    if (input.consent !== "read" && !current) throw new Error("Connect read access before requesting separate write consent");
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url"), stateHash = hash(state);
    const expiresAt = new Date(this.transport.now().getTime() + 600_000).toISOString();
    const generation = this.store.get<{ value: number }>("google_generation", input.accountId)?.value ?? 0;
    const pending: OAuthPending = { ...input, stateHash, verifier: this.store.seal("oauth", stateHash, verifier), expiresAt, status: "pending", generation };
    this.store.put("oauth", stateHash, pending);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri, response_type: "code",
      scope: ["openid", "email", ...SCOPES[input.consent]].join(" "), state, code_challenge: hashBase64(verifier), code_challenge_method: "S256", access_type: "offline", prompt: "consent", include_granted_scopes: "false" })) url.searchParams.set(key, value);
    return { url: url.href, expiresAt };
  }
  async completeOAuth(state: string, code: string, signal?: AbortSignal): Promise<Omit<GoogleAccount, "credentials">> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4000) throw new Error("Invalid OAuth callback");
    const stateHash = hash(state), pending = this.store.get<OAuthPending>("oauth", stateHash);
    if (!pending || pending.status !== "pending" || Date.parse(pending.expiresAt) <= this.transport.now().getTime()) throw new Error("OAuth state is expired or already consumed");
    this.store.put("oauth", stateHash, { ...pending, status: "consumed", verifier: "" });
    const verifier = this.store.unseal<string>("oauth", stateHash, pending.verifier);
    const response = tokenResponse.parse(await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.options.redirectUri, code_verifier: verifier }, pending, signal));
    if (response.token_type.toLowerCase() !== "bearer") throw new Error("Unsupported OAuth token type");
    const scopes = response.scope?.split(/\s+/) ?? [];
    if (!SCOPES[pending.consent].every(scope => scopes.includes(scope))) throw new Error("Requested Google consent was not granted");
    const identity = z.object({ sub: z.string().min(1).max(300), email: z.string().email(), email_verified: z.literal(true) }).parse(await this.transport.request(new URL("https://www.googleapis.com/oauth2/v3/userinfo"),
      { headers: { authorization: `Bearer ${response.access_token}` } }, pending, "googleRequestUsd", signal));
    const current = this.store.get<GoogleAccount>("google_account", pending.accountId);
    if ((this.store.get<{ value: number }>("google_generation", pending.accountId)?.value ?? 0) !== pending.generation) throw new Error("Google connection was cancelled");
    if (current && (current.subject !== identity.sub || current.projectId !== pending.projectId)) throw new Error("Google consent returned a different account");
    const previous = current?.credentials[pending.consent] ? this.store.unseal<Tokens>("google_token", `${pending.accountId}:${pending.consent}`, current.credentials[pending.consent]!) : undefined;
    const tokens: Tokens = { accessToken: response.access_token, refreshToken: response.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: new Date(this.transport.now().getTime() + response.expires_in * 1000).toISOString(), scopes };
    const account: GoogleAccount = { id: pending.accountId, subject: identity.sub, email: identity.email, projectId: pending.projectId, objectiveId: pending.objectiveId,
      labels: pending.consent === "read" ? pending.labels : current!.labels, calendars: pending.consent === "read" ? pending.calendars : current!.calendars,
      credentials: { ...current?.credentials, [pending.consent]: this.store.seal("google_token", `${pending.accountId}:${pending.consent}`, tokens) }, lastPollAt: current?.lastPollAt ?? null,
      revision: (current?.revision ?? 0) + 1, retentionAllowed: pending.consent === "read" ? pending.retentionAllowed : current!.retentionAllowed,
      cloudAllowed: pending.consent === "read" ? pending.cloudAllowed : current!.cloudAllowed };
    this.reads.get(account.id)?.abort(new Error("Google consent changed"));
    this.store.transaction(() => { this.store.put("google_account", account.id, account); this.pruneRetained(account); }); return this.publicAccount(account);
  }
  private tokenRequest(parameters: Record<string, string>, context: IntegrationContext, signal?: AbortSignal) {
    return this.transport.request(new URL("https://oauth2.googleapis.com/token"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...parameters, client_id: this.options.clientId, ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}) }).toString() }, context, "googleRequestUsd", signal);
  }
  private async token(account: GoogleAccount, consent: Consent, signal?: AbortSignal): Promise<string> {
    const encrypted = account.credentials[consent]; if (!encrypted) throw new Error("Separate Google consent is required");
    const tokens = this.store.unseal<Tokens>("google_token", `${account.id}:${consent}`, encrypted);
    if (!SCOPES[consent].every(scope => tokens.scopes.includes(scope))) throw new Error("Google scope no longer permits this operation");
    if (Date.parse(tokens.expiresAt) - this.transport.now().getTime() > 60_000) return tokens.accessToken;
    if (!tokens.refreshToken) throw new Error("Google reconnect required");
    const response = tokenResponse.parse(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, account, signal));
    const scopes = response.scope?.split(/\s+/) ?? tokens.scopes;
    if (response.token_type.toLowerCase() !== "bearer" || !SCOPES[consent].every(scope => scopes.includes(scope))) throw new Error("Google refresh changed consent");
    const next = { accessToken: response.access_token, refreshToken: response.refresh_token ?? tokens.refreshToken, expiresAt: new Date(this.transport.now().getTime() + response.expires_in * 1000).toISOString(), scopes };
    const current = this.account(account.id);
    if (current.subject !== account.subject || current.revision !== account.revision) throw new Error("Google account changed during token refresh");
    this.store.put("google_account", account.id, { ...current, credentials: { ...current.credentials, [consent]: this.store.seal("google_token", `${account.id}:${consent}`, next) } });
    return next.accessToken;
  }
  private async api(path: string, account: GoogleAccount, consent: Consent, init: RequestInit = {}, signal?: AbortSignal, beforeSend?: () => void) {
    const token = await this.token(account, consent, signal);
    return this.transport.request(new URL(path), { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }, account, "googleRequestUsd", signal, () => {
      const current = this.account(account.id);
      if (current.subject !== account.subject || current.projectId !== account.projectId || !current.credentials[consent]) throw new Error("Google consent changed");
      beforeSend?.();
    });
  }
  private publicAccount(account: GoogleAccount): Omit<GoogleAccount, "credentials"> { const { credentials: _, ...visible } = account; return visible; }
  accounts(): Omit<GoogleAccount, "credentials">[] { return this.store.list<GoogleAccount>("google_account").map(account => this.publicAccount(account)); }
  disconnect(id: string): void {
    IntegrationId.parse(id); this.reads.get(id)?.abort(new Error("Google account disconnected"));
    this.store.transaction(() => {
      this.store.put("google_generation", id, { value: (this.store.get<{ value: number }>("google_generation", id)?.value ?? 0) + 1 });
      this.store.remove("google_account", id);
      this.pruneRetained({ id, retentionAllowed: false } as GoogleAccount);
    });
  }
  updateConsent(raw: unknown): Omit<GoogleAccount, "credentials"> {
    const input = z.strictObject({ accountId: IntegrationId, expectedRevision: z.number().int().positive(), retentionAllowed: z.boolean(), cloudAllowed: z.boolean(), labels: z.array(resource).max(10), calendars: z.array(resource).max(10) })
      .refine(value => !value.cloudAllowed || value.retentionAllowed, "Cloud reasoning requires retention consent").parse(raw);
    const account = this.account(input.accountId);
    if (account.revision !== input.expectedRevision) throw new Error("Google connection changed; inspect its current revision");
    this.reads.get(account.id)?.abort(new Error("Google consent changed"));
    const updated: GoogleAccount = { ...account, revision: account.revision + 1, retentionAllowed: input.retentionAllowed, cloudAllowed: input.cloudAllowed, labels: input.labels, calendars: input.calendars, lastPollAt: null };
    this.store.transaction(() => { this.store.put("google_account", account.id, updated); this.pruneRetained(updated); }); return this.publicAccount(updated);
  }
  private pruneRetained(account: GoogleAccount): void {
    const allowed = (change: GoogleChange) => account.retentionAllowed && (change.provider === "gmail" ? account.labels : account.calendars).includes(change.resourceId);
    for (const entry of this.store.list<RetainedGoogleEntry>("google_change")) if (entry.accountId === account.id) {
      if (!allowed(entry)) this.store.remove("google_change", entry.id);
      else this.store.put("google_change", entry.id, { ...entry, accountRevision: account.revision, cloudAllowed: account.cloudAllowed,
        sourceRevision: `${account.revision}:${entry.sourceRevision.slice(entry.sourceRevision.indexOf(":") + 1)}` });
    }
    for (const row of this.store.list<{ id: string; change?: GoogleChange }>("inbox")) if (row.change?.accountId === account.id && !allowed(row.change)) this.store.remove("inbox", row.id);
  }
  authorizeGoogleContext(ref: { id: string; sourceRevision: string }, projectId: string): boolean {
    try {
      this.store.assertWritable();
      const entry = this.store.get<RetainedGoogleEntry>("google_change", ref.id); if (!entry || entry.sourceRevision !== ref.sourceRevision || entry.projectId !== projectId) return false;
      const account = this.account(entry.accountId);
      return account.projectId === projectId && account.revision === entry.accountRevision && account.retentionAllowed && account.cloudAllowed && (entry.provider === "gmail" ? account.labels : account.calendars).includes(entry.resourceId);
    } catch { return false; }
  }
  readGoogleContext(projectId: string): { version: 1; entries: RetainedGoogleEntry[] } {
    IntegrationId.parse(projectId); const entries: RetainedGoogleEntry[] = []; let bytes = 0;
    for (const entry of this.store.list<RetainedGoogleEntry>("google_change").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (!this.authorizeGoogleContext(entry, projectId)) continue;
      const size = Buffer.byteLength(JSON.stringify(entry)); if (bytes + size > 65536) continue;
      entries.push(entry); bytes += size; if (entries.length >= 20) break;
    }
    return { version: 1, entries };
  }
  cancelReads(): void { for (const controller of this.reads.values()) controller.abort(new Error("Google polling stopped")); }
  private async publish(change: GoogleChange, version: string): Promise<void> {
    const current = this.account(change.accountId);
    if (!current.retentionAllowed || current.projectId !== change.projectId || !(change.provider === "gmail" ? current.labels : current.calendars).includes(change.resourceId)) throw new Error("Google source consent changed");
    change = { ...change, retentionAllowed: true, cloudAllowed: current.cloudAllowed };
    if (Buffer.byteLength(JSON.stringify(change)) > 60000) throw new Error("Selected Google item exceeds retained-context limit");
    const id = hash(`${change.provider}:${change.accountId}:${change.resourceId}:${change.externalId}:${current.revision}:${version}`);
    const retainedId = hash(`${change.provider}:${change.accountId}:${change.resourceId}:${change.externalId}`);
    const retained: RetainedGoogleEntry = { ...change, id: retainedId, sourceRevision: `${current.revision}:${version}`, accountRevision: current.revision, updatedAt: this.transport.now().toISOString() };
    this.store.transaction(() => {
      this.store.put("google_change", retainedId, retained);
      const history = this.store.list<RetainedGoogleEntry>("google_change").filter(entry => entry.accountId === current.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const old of history.slice(500)) this.store.remove("google_change", old.id);
    });
    if (this.store.get("inbox", id)) return;
    const receipt = { id, change: { ...change, content: null }, sourceRevision: retained.sourceRevision };
    this.store.put("inbox", id, { ...receipt, status: "dispatching" });
    try { await this.hooks.onGoogleChange?.(change); this.store.put("inbox", id, { ...receipt, status: "delivered" }); }
    catch { this.store.put("inbox", id, { ...receipt, status: "unknown" }); throw new Error("Google change handoff is uncertain; inspect before replaying"); }
  }
  async pollOnce(accountId: string, signal?: AbortSignal): Promise<{ skipped: boolean }> {
    if (this.busy.has(accountId)) return { skipped: true };
    const account = this.account(accountId);
    if (!account.retentionAllowed) return { skipped: true };
    if (account.lastPollAt && this.transport.now().getTime() - Date.parse(account.lastPollAt) < 300_000) return { skipped: true };
    const controller = new AbortController(); this.reads.set(accountId, controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    this.busy.add(accountId); this.store.put("google_account", accountId, { ...account, lastPollAt: this.transport.now().toISOString() });
    try {
      for (const label of account.labels) await this.pollLabel(account, label, combined);
      for (const calendar of account.calendars) await this.pollCalendar(account, calendar, combined);
      return { skipped: false };
    } finally { this.busy.delete(accountId); this.reads.delete(accountId); }
  }
  private async pollLabel(account: GoogleAccount, label: string, signal?: AbortSignal): Promise<void> {
    const key = `${account.id}:gmail:${hash(label)}`, cursor = this.store.get<{ historyId?: string; pageToken?: string; initialHistoryId?: string }>("google_cursor", key);
    const incremental = !!cursor?.historyId;
    const list = new URL(incremental ? "https://gmail.googleapis.com/gmail/v1/users/me/history" : "https://gmail.googleapis.com/gmail/v1/users/me/messages");
    list.searchParams.set(incremental ? "labelId" : "labelIds", label); list.searchParams.set("maxResults", "100");
    if (incremental) {
      list.searchParams.set("startHistoryId", cursor!.historyId!);
      for (const type of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) list.searchParams.append("historyTypes", type);
    }
    // Snapshot the history cursor before the initial scan, so messages arriving
    // during pagination are covered by the next incremental read.
    const initialHistoryId = incremental ? undefined : cursor?.initialHistoryId ?? z.object({ historyId: z.string() }).parse(await this.api("https://gmail.googleapis.com/gmail/v1/users/me/profile", account, "read", {}, signal)).historyId;
    let nextPage = cursor?.pageToken, historyId = cursor?.historyId;
    const ids = new Set<string>();
    for (let page = 0; page < 3; page++) {
      if (nextPage) list.searchParams.set("pageToken", nextPage);
      let result: Record<string, unknown>;
      try { result = z.record(z.string(), z.unknown()).parse(await this.api(list.href, account, "read", {}, signal)); }
      catch (error) { if (error instanceof ProviderHttpError && error.status === 404 && incremental) { this.store.remove("google_cursor", key); return; } throw error; }
      const historyItem = z.object({ message: z.object({ id: z.string(), labelIds: z.array(z.string()).optional() }) });
      const messages = incremental ? z.array(z.object({ messagesAdded: z.array(historyItem).optional(), messagesDeleted: z.array(historyItem).optional(), labelsAdded: z.array(historyItem).optional(), labelsRemoved: z.array(historyItem).optional() })).parse(result.history ?? [])
        .flatMap(item => [item.messagesAdded, item.messagesDeleted, item.labelsAdded, item.labelsRemoved].flatMap(items => items?.map(item => item.message) ?? [])) : z.array(z.object({ id: z.string() })).parse(result.messages ?? []);
      for (const message of messages) ids.add(message.id);
      if (typeof result.historyId === "string") historyId = result.historyId;
      nextPage = typeof result.nextPageToken === "string" ? result.nextPageToken : undefined; if (!nextPage) break;
    }
    for (const id of ids) {
      let message: { id: string; historyId: string; labelIds: string[]; snippet?: string; payload?: unknown };
      try { message = z.object({ id: z.string(), historyId: z.string(), labelIds: z.array(z.string()), snippet: z.string().optional(), payload: z.unknown().optional() }).parse(await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, account, "read", {}, signal)); }
      catch (error) { if (error instanceof ProviderHttpError && error.status === 404) { this.removeRetainedItem(account.id, "gmail", label, id); continue; } throw error; }
      if (message.labelIds.includes(label)) await this.publish({ provider: "gmail", accountId: account.id, projectId: account.projectId, resourceId: label, externalId: message.id, content: readableMail(message) }, message.historyId);
      else this.removeRetainedItem(account.id, "gmail", label, id);
    }
    if (nextPage) this.store.put("google_cursor", key, { ...cursor, initialHistoryId, pageToken: nextPage });
    else if (incremental ? historyId : initialHistoryId) this.store.put("google_cursor", key, { historyId: incremental ? historyId : initialHistoryId });
  }
  private removeRetainedItem(accountId: string, provider: "gmail" | "calendar", resourceId: string, externalId: string): void {
    this.store.transaction(() => {
      this.store.remove("google_change", hash(`${provider}:${accountId}:${resourceId}:${externalId}`));
      for (const row of this.store.list<{ id: string; change?: GoogleChange }>("inbox")) if (row.change?.accountId === accountId && row.change.provider === provider && row.change.resourceId === resourceId && row.change.externalId === externalId) this.store.remove("inbox", row.id);
    });
  }
  private async pollCalendar(account: GoogleAccount, calendar: string, signal?: AbortSignal): Promise<void> {
    const key = `${account.id}:calendar:${hash(calendar)}`, cursor = this.store.get<{ syncToken?: string; pageToken?: string; timeMin?: string }>("google_cursor", key);
    const list = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`);
    list.searchParams.set("maxResults", "100"); list.searchParams.set("showDeleted", "true");
    const timeMin = cursor?.timeMin ?? this.transport.now().toISOString();
    if (cursor?.syncToken) list.searchParams.set("syncToken", cursor.syncToken); else list.searchParams.set("timeMin", timeMin);
    let nextPage = cursor?.pageToken, syncToken: string | undefined;
    for (let page = 0; page < 3; page++) {
      if (nextPage) list.searchParams.set("pageToken", nextPage);
      let result: { items: { id: string; etag?: string; updated?: string; [key: string]: unknown }[]; nextPageToken?: string; nextSyncToken?: string };
      try { result = z.object({ items: z.array(z.object({ id: z.string(), etag: z.string().optional(), updated: z.string().optional() }).passthrough()).default([]), nextPageToken: z.string().optional(), nextSyncToken: z.string().optional() }).parse(await this.api(list.href, account, "read", {}, signal)); }
      catch (error) { if (error instanceof ProviderHttpError && error.status === 410 && cursor) { this.store.remove("google_cursor", key); return; } throw error; }
      for (const event of result.items) {
        if (event.status === "cancelled") { this.removeRetainedItem(account.id, "calendar", calendar, event.id); continue; }
        await this.publish({ provider: "calendar", accountId: account.id, projectId: account.projectId, resourceId: calendar, externalId: event.id,
          content: { id: event.id, summary: String(event.summary ?? "").slice(0, 500), description: String(event.description ?? "").slice(0, 16000), location: String(event.location ?? "").slice(0, 1000), start: event.start, end: event.end,
            recurrence: Array.isArray(event.recurrence) ? event.recurrence.slice(0, 20).map(rule => String(rule).slice(0, 500)) : [], recurringEventId: event.recurringEventId ?? null, originalStartTime: event.originalStartTime ?? null,
            coverageNotice: "Provider event records with recurrence rules; recurring schedules are not expanded into every daily occurrence." } }, event.etag ?? event.updated ?? hash(canonicalJson(event)));
      }
      nextPage = result.nextPageToken; syncToken = result.nextSyncToken; if (!nextPage) break;
    }
    if (nextPage) this.store.put("google_cursor", key, { ...cursor, timeMin, pageToken: nextPage });
    else if (syncToken) this.store.put("google_cursor", key, { syncToken });
  }
  prepareGoogleAction(raw: unknown): PreparedGoogleAction {
    const input = GoogleActionInputSchema.parse(raw), account = this.account(input.accountId);
    if (account.projectId !== input.projectId || !account.credentials[input.kind]) throw new Error("Separate consent and matching project required");
    if (input.kind === "calendar_write" && (!account.calendars.includes(input.calendarId) || Date.parse(input.end) <= Date.parse(input.start))) throw new Error("Calendar or event interval is outside configured consent");
    const exactArguments = canonicalJson(input); return { input, exactArguments, digest: hash(exactArguments) };
  }
  async executeGoogleAction(raw: PreparedGoogleAction, approvalId: string, signal?: AbortSignal): Promise<unknown> {
    const prepared = this.prepareGoogleAction(raw.input);
    if (prepared.digest !== raw.digest || prepared.exactArguments !== raw.exactArguments || !this.authority) throw new Error("Exact existing approval authority required");
    const previous = this.store.get<{ digest: string; status: string; result?: unknown }>("attempt", prepared.input.requestId);
    if (previous) { if (previous.digest !== prepared.digest) throw new Error("Google effect request changed"); if (previous.status === "sent") return previous.result; throw new Error("Google effect is already submitted or uncertain; automatic replay is prohibited"); }
    const effect: ApprovedEffect = { approvalId: IntegrationId.parse(approvalId), projectId: prepared.input.projectId, kind: prepared.input.kind, digest: prepared.digest, exactArguments: prepared.exactArguments };
    return this.authority.run(effect, async () => {
      // Reserve the id before awaiting token refresh or transport; concurrent approval callbacks cannot duplicate the effect.
      if (this.store.get("attempt", prepared.input.requestId)) throw new Error("Google effect already submitted");
      this.store.put("attempt", prepared.input.requestId, { id: prepared.input.requestId, digest: prepared.digest, status: "dispatching" });
      try {
        const input = prepared.input, account = this.account(input.accountId);
        let url: string, body: unknown;
        if (input.kind === "gmail_send") {
          url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
          const mime = `To: ${input.to}\r\nSubject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(input.text).toString("base64")}\r\n`;
          body = { raw: Buffer.from(mime).toString("base64url") };
        } else {
          url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`;
          body = { id: hash(input.requestId).slice(0, 40), summary: input.summary, description: input.description, start: { dateTime: input.start }, end: { dateTime: input.end } };
        }
        const result = z.object({ id: z.string().min(1).max(500) }).passthrough().parse(await this.api(url, account, input.kind, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal));
        this.store.put("attempt", input.requestId, { id: input.requestId, digest: prepared.digest, status: "sent", result }); return result;
      } catch { this.store.put("attempt", prepared.input.requestId, { id: prepared.input.requestId, digest: prepared.digest, status: "unknown" }); throw new Error("Google effect outcome is unknown; inspect provider before another action"); }
    });
  }
}
function hashBase64(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function readableMail(message: { id: string; snippet?: string; payload?: unknown }): { id: string; snippet: string; headers: { name: string; value: string }[]; text: string; truncated: boolean } {
  const texts: string[] = [], headers: { name: string; value: string }[] = []; let bytes = 0, truncated = false;
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6 || bytes > 12_000) { truncated = true; return; }
    const part = value as Record<string, unknown>;
    if (depth === 0 && Array.isArray(part.headers)) for (const raw of part.headers.slice(0, 100)) {
      const header = z.object({ name: z.string(), value: z.string() }).safeParse(raw);
      if (header.success && ["from", "to", "subject", "date"].includes(header.data.name.toLowerCase()) && !headers.some(item => item.name.toLowerCase() === header.data.name.toLowerCase())) headers.push({ name: header.data.name, value: header.data.value.slice(0, 1000) });
    }
    if (part.mimeType === "text/plain" && part.body && typeof part.body === "object") {
      const data = (part.body as Record<string, unknown>).data;
      if (typeof data === "string" && /^[A-Za-z0-9_-]*={0,2}$/.test(data)) {
        const text = Buffer.from(data.slice(0, 100000), "base64url").toString("utf8"), available = Math.max(0, 12_000 - bytes);
        texts.push(text.slice(0, available)); bytes += Math.min(text.length, available); if (text.length > available || data.length > 100000) truncated = true;
      }
    }
    if (Array.isArray(part.parts)) { for (const child of part.parts.slice(0, 30)) visit(child, depth + 1); if (part.parts.length > 30) truncated = true; }
  };
  if (message.payload) visit(message.payload, 0);
  return { id: message.id, snippet: (message.snippet ?? "").slice(0, 2000), headers, text: texts.join("\n"), truncated };
}
