import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import test from "node:test";
import {
  IntegrationService, ExistingVoiceSpeechAdapter, muLaw8kToPcm16k, pcmToMuLaw8k,
  type GoogleChange, type InboundTelegram, type IntegrationOptions, type TelephonySpeechAdapter,
} from "../bridge/integrations/index.ts";
import { ReserveBudgetSchema, type Objective } from "../bridge/objectives/contracts.ts";

const owner = "123456789", callSid = `CA${"a".repeat(32)}`, accountSid = `AC${"b".repeat(32)}`, streamSid = `MZ${"c".repeat(32)}`;
const context = { projectId: "project-1", objectiveId: null };
const readScopes = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function fixture(overrides: Partial<IntegrationOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-integrations-"));
  let clock = Date.parse("2026-11-09T09:00:00.000Z"), stops = 0, messageId = 100, tokenScope = readScopes;
  const requests: { url: URL; init: RequestInit }[] = [], messages: InboundTelegram[] = [], changes: GoogleChange[] = [];
  const updates: unknown[][] = [], reservations: unknown[] = [], settlements: unknown[] = [];
  let handler: ((url: URL, init: RequestInit) => Response | Promise<Response> | undefined) | undefined;
  let speechOptions: Parameters<TelephonySpeechAdapter["open"]>[0] | undefined; const pcm: Buffer[] = [];
  const options: IntegrationOptions = { dataDirectory: directory, enabled: true, encryptionKey: Buffer.alloc(32, 7), now: () => new Date(clock),
    ledger: { reserve(input) { ReserveBudgetSchema.parse(input); reservations.push(input); return { id: randomUUID() }; }, settle(id, result) { settlements.push({ id, ...result }); } },
    prices: { telegramRequestUsd: 0, googleRequestUsd: 0, twilioRequestUsd: 0, twilioMinuteUsd: 0.01, elevenLabsMinuteUsd: 0.01, elevenLabsCharacterUsd: 0.00001 },
    telegram: { botToken: "123456:abcdefghijklmnopqrstuvwxyzABCDEFGHI", ownerChatId: owner, timeZone: "UTC", context },
    google: { clientId: "fixture.apps.googleusercontent.com", clientSecret: "fixture-client-secret", redirectUri: "https://jarvis.example/v1/cloud/integrations/google/callback" },
    twilio: { accountSid, authToken: "fixture-twilio-token", ownerNumber: "+15550002222", fromNumber: "+15550001111", publicBaseUrl: "https://jarvis.example", timeZone: "UTC" },
    hooks: { authorizeDisclosure: () => true, authorizeCallOutreach: () => true, async onStop() { stops++; },
      async onTelegramMessage(message) { messages.push(message); }, async onGoogleChange(change) { changes.push(change); }, async onVerifiedCallTranscript() { return "Private project status"; },
      async digest(slot) { return `Digest ${slot}`; } },
    speech: { async open(input) { speechOptions = input; return { acceptPcm(input) { pcm.push(input); }, close() {} }; } },
    approvalAuthority: { async run(_effect, execute) { return execute(); } },
    fetch: (async (input, init = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      const custom = await handler?.(url, init); if (custom) return custom;
      if (url.hostname === "api.telegram.org" && url.pathname.endsWith("/getUpdates")) return json({ ok: true, result: updates.shift() ?? [] });
      if (url.hostname === "api.telegram.org" && url.pathname.endsWith("/sendMessage")) return json({ ok: true, result: { message_id: ++messageId, chat: { id: Number(owner) } } });
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "private-access-token", refresh_token: "private-refresh-token", token_type: "Bearer", expires_in: 120, scope: tokenScope });
      if (url.pathname === "/oauth2/v3/userinfo") return json({ sub: "owner-google-sub", email: "owner@example.com", email_verified: true });
      if (url.pathname.endsWith("/OutgoingCallerIds.json")) return json({ outgoing_caller_ids: [{ phone_number: "+15550002222" }] });
      if (url.pathname.endsWith("/Calls.json")) return json({ sid: callSid, to: "+15550002222", from: "+15550001111", status: "queued" });
      if (url.pathname.endsWith(`/Calls/${callSid}.json`)) return json({ sid: callSid, status: "completed" });
      throw new Error(`Unexpected fixture URL ${url.origin}${url.pathname}`);
    }) as typeof fetch,
    ...overrides,
  };
  let service = await IntegrationService.open(options);
  const update = (id: number, text: string, chatId = owner, reply?: number) => ({ update_id: id, message: { message_id: id + 1, text, chat: { id: Number(chatId), type: "private" }, from: { id: Number(chatId), is_bot: false }, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } });
  async function pair() { const pairing = service.telegram!.beginPairing(); updates.push([update(1, `/start ${pairing.code}`)]); await service.telegram!.pollOnce(); assert.equal(service.telegram!.paired(), true); }
  async function connect(consent: "read" | "gmail_send" | "calendar_write" = "read") {
    tokenScope = consent === "read" ? readScopes : `openid email https://www.googleapis.com/auth/${consent === "gmail_send" ? "gmail.send" : "calendar.events"}`;
    const pending = service.google!.beginOAuth({ ...context, accountId: "owner-google", consent, labels: ["Label_A"], calendars: ["primary"], retentionAllowed: true, cloudAllowed: true });
    return service.google!.completeOAuth(new URL(pending.url).searchParams.get("state")!, "fixture-authorization-code");
  }
  const sign = (url: string, parameters: Record<string, string>) => createHmac("sha1", "fixture-twilio-token").update(url + Object.keys(parameters).sort().map(key => key + parameters[key]).join("")).digest("base64");
  return { directory, options, get service() { return service; }, requests, messages, changes, updates, reservations, settlements, pcm,
    enableCalls() { return service.updateOutreachPolicy({ projectId: context.projectId, expectedRevision: service.readOutreachPolicy(context.projectId).revision, enabled: true, timeZone: "UTC", timezoneConfirmed: true, categories: ["blocking_deadline", "call_when_ready"] }); },
    get speechOptions() { return speechOptions; }, stops: () => stops, update, pair, connect, sign,
    setHandler(value: typeof handler) { handler = value; }, setTime(value: string) { clock = Date.parse(value); }, advance(ms: number) { clock += ms; },
    now: () => new Date(clock).toISOString(),
    async restart() { await service.close(); service = await IntegrationService.open(options); },
    async cleanup() { await service.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("Telegram pairs one numeric private owner, binds exact reply cards, persists update IDs and stops immediately", async () => {
  const f = await fixture();
  try {
    const pair = f.service.telegram!.beginPairing();
    f.updates.push([f.update(1, `/start ${pair.code}`, "999999"), f.update(2, `/start ${pair.code}`)]);
    await f.service.telegram!.pollOnce(); assert.equal(f.service.telegram!.paired(), true);
    const question = { objectiveId: "objective-1", questionId: "question-1", revision: 3, expiresAt: "2026-11-09T10:00:00.000Z" };
    f.service.telegram!.enqueue({ id: "question-out", ...context, kind: "question", text: "Which scope?", notBefore: f.now(), question });
    assert.equal((await f.service.telegram!.flushOnce()).sent, 1);
    f.updates.push([f.update(3, "Project one", owner, 101), f.update(4, "yes", owner, 999)]);
    await f.service.telegram!.pollOnce(); assert.deepEqual(f.messages[0].question, { kind: "objective", ...question }); assert.equal(f.messages.length, 1);
    await f.restart(); f.updates.push([f.update(3, "Project one", owner, 101), f.update(5, "/stop")]);
    await f.service.telegram!.pollOnce(); assert.equal(f.messages.length, 1); assert.equal(f.stops(), 1); assert.equal(f.service.status().stopped, true);
    assert.equal((f.requests.filter(request => request.url.pathname.endsWith("getUpdates")).at(-1)!.init.body as string).includes('"offset":5'), true);
  } finally { await f.cleanup(); }
});

test("Telegram task-question replies retain exact task/project/card revision and cannot authorize an effect", async () => {
  let approvals = 0;
  const f = await fixture({ approvalAuthority: { async run(_effect, execute) { approvals++; return execute(); } } });
  try {
    await f.pair();
    const question = { kind: "task", taskId: "task-1", projectId: "project-1", questionId: "question-1", revision: 4, expiresAt: "2026-11-09T10:00:00.000Z" };
    f.service.telegram!.enqueue({ id: "task-question", ...context, kind: "question", text: "Which source should I read?", disclosure: "project_details", notBefore: f.now(), question });
    await f.service.telegram!.flushOnce(); f.updates.push([f.update(2, "yes, approve all", owner, 101)]); await f.service.telegram!.pollOnce();
    assert.deepEqual(f.messages[0].question, question); assert.equal(f.messages[0].text, "yes, approve all"); assert.equal(approvals, 0);
    assert.throws(() => f.service.telegram!.enqueue({ id: "forged-approval", ...context, kind: "question", text: "Approve?", notBefore: f.now(), question: { ...question, kind: "approval", optionId: "approve" } }));
  } finally { await f.cleanup(); }
});

test("Telegram outbox enforces quiet hours, four routine sends per day and 09/18 digest identity", async () => {
  const f = await fixture();
  try {
    await f.pair(); f.setTime("2026-11-09T23:00:00.000Z");
    for (let i = 0; i < 5; i++) f.service.telegram!.enqueue({ id: `routine-${i}`, ...context, kind: "routine", text: `Update ${i}`, notBefore: f.now() });
    assert.equal((await f.service.telegram!.flushOnce()).sent, 0);
    f.setTime("2026-11-10T09:00:00.000Z"); await f.service.telegram!.scheduleDigests(); await f.service.telegram!.scheduleDigests();
    assert.equal(f.service.telegram!.outbox().filter(item => item.kind === "digest").length, 1);
    assert.equal((await f.service.telegram!.flushOnce()).sent, 4); assert.equal((await f.service.telegram!.flushOnce()).sent, 0);
  } finally { await f.cleanup(); }
});

test("uncertain Telegram delivery survives restart without automatic replay; unknown prices never dispatch", async () => {
  const f = await fixture();
  try {
    await f.pair(); f.setHandler(url => { if (url.pathname.endsWith("sendMessage")) throw new Error("network disappeared after write"); return undefined; });
    f.service.telegram!.enqueue({ id: "uncertain-send", ...context, kind: "routine", text: "One update", notBefore: f.now() });
    await assert.rejects(f.service.telegram!.flushOnce(), /network disappeared/);
    assert.equal(f.service.telegram!.outbox()[0].status, "unknown");
    const before = f.requests.length; await f.restart(); await f.service.telegram!.flushOnce(); assert.equal(f.requests.length, before);
    assert.ok(f.settlements.some(value => (value as { accounting: string }).accounting === "unknown"));
  } finally { await f.cleanup(); }
  const noPrice = await fixture({ prices: {} });
  try { await assert.rejects(noPrice.service.telegram!.pollOnce(), /Explicit provider price/); assert.equal(noPrice.requests.length, 0); }
  finally { await noPrice.cleanup(); }
});

test("Telegram project disclosure revoked during budget reservation cancels the durable message before send", async () => {
  let allowed = true, revoke = false;
  const f = await fixture({
    hooks: { async onStop() {}, authorizeDisclosure: () => allowed },
    ledger: { reserve(input) { ReserveBudgetSchema.parse(input); if (revoke) allowed = false; return { id: randomUUID() }; }, settle() {} },
  });
  try {
    await f.pair(); f.service.telegram!.enqueue({ id: "private-out", ...context, kind: "routine", text: "Private project result", disclosure: "project_details", notBefore: f.now() });
    revoke = true; await assert.rejects(f.service.telegram!.flushOnce(), /disclosure grant changed/);
    assert.equal(f.service.telegram!.outbox()[0].status, "cancelled"); assert.equal(f.requests.some(request => request.url.pathname.endsWith("/sendMessage")), false);
  } finally { await f.cleanup(); }
});

test("Google PKCE is single-use, read and write consent are separate, tokens are encrypted at rest", async () => {
  const f = await fixture();
  try {
    const pending = f.service.google!.beginOAuth({ ...context, accountId: "owner-google", consent: "read", labels: ["Label_A"], calendars: ["primary"] });
    const url = new URL(pending.url), state = url.searchParams.get("state")!;
    assert.equal(url.origin, "https://accounts.google.com"); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.ok(!url.href.includes("gmail.send"));
    await f.service.google!.completeOAuth(state, "authorization-code");
    await assert.rejects(f.service.google!.completeOAuth(state, "authorization-code"), /consumed/);
    const posted = new URLSearchParams(String(f.requests.find(request => request.url.hostname === "oauth2.googleapis.com")!.init.body));
    assert.equal(posted.get("code_verifier")!.length, 43);
    assert.throws(() => f.service.google!.prepareGoogleAction({ ...context, accountId: "owner-google", requestId: "send-1", kind: "gmail_send", to: "person@example.com", subject: "Hello", text: "body" }), /Separate consent/);
    const file = join(f.directory, "integrations", "integrations.sqlite"); assert.equal((await stat(file)).mode & 0o777, 0o600);
    const bytes = await readFile(file); assert.equal(bytes.includes(Buffer.from("private-refresh-token")), false); assert.equal(bytes.includes(Buffer.from("private-access-token")), false);
    await f.restart(); assert.equal(f.service.google!.accounts()[0].email, "owner@example.com");
  } finally { await f.cleanup(); }
});

test("Google read polling uses selected label/calendar, refreshes tokens, and advances incremental cursors every five minutes", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.setHandler(url => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) { assert.equal(url.searchParams.get("labelIds"), "Label_A"); return json({ messages: [{ id: "message-1" }] }); }
      if (url.pathname.endsWith("/messages/message-1")) return json({ id: "message-1", historyId: "101", labelIds: ["Label_A"], snippet: "Selected mail" });
      if (url.pathname.endsWith("/history")) { assert.equal(url.searchParams.get("labelId"), "Label_A"); assert.equal(url.searchParams.get("startHistoryId"), "100"); return json({ historyId: "102", history: [] }); }
      if (url.pathname.endsWith("/events")) { assert.equal(url.pathname.includes("primary"), true); return json({ items: [{ id: "event-1", etag: "revision-1", summary: "Planning" }], nextSyncToken: "sync-1" }); }
    });
    assert.equal((await f.service.google!.pollOnce("owner-google")).skipped, false); assert.equal(f.changes.length, 2);
    const before = f.requests.length; assert.equal((await f.service.google!.pollOnce("owner-google")).skipped, true); assert.equal(f.requests.length, before);
    f.advance(300_000); await f.service.google!.pollOnce("owner-google");
    assert.equal(f.changes.length, 2); assert.ok(f.requests.some(request => request.url.searchParams.get("syncToken") === "sync-1"));
    assert.ok(f.requests.some(request => String(request.init.body).includes("grant_type=refresh_token")));
  } finally { await f.cleanup(); }
});

test("Google send requires exact approval callback and durable request identity; lost response never retries", async () => {
  let approved = false, approvals = 0;
  const f = await fixture({ approvalAuthority: { async run(effect, execute) { approvals++; assert.equal(effect.approvalId, "approval-1"); if (!approved) throw new Error("Existing approval missing"); return execute(); } } });
  try {
    await f.connect(); await f.connect("gmail_send");
    const prepared = f.service.google!.prepareGoogleAction({ ...context, accountId: "owner-google", requestId: "send-1", kind: "gmail_send", to: "person@example.com", subject: "Hello", text: "Exact body" });
    let sends = 0; f.setHandler(url => { if (url.pathname.endsWith("/messages/send")) { sends++; throw new Error("lost receipt"); } return undefined; });
    await assert.rejects(f.service.google!.executeGoogleAction(prepared, "approval-1"), /Existing approval/); assert.equal(sends, 0);
    approved = true; await assert.rejects(f.service.google!.executeGoogleAction(prepared, "approval-1"), /unknown/); assert.equal(sends, 1);
    await f.restart(); await assert.rejects(f.service.google!.executeGoogleAction(prepared, "approval-1"), /uncertain/); assert.equal(sends, 1); assert.equal(approvals, 2);
    await assert.rejects(f.service.google!.executeGoogleAction({ ...prepared, exactArguments: "changed" }, "approval-1"), /Exact existing/);
  } finally { await f.cleanup(); }
});

test("Google OAuth alone cannot retain or disclose context; revocation invalidates exact retained references", async () => {
  const f = await fixture();
  try {
    const pending = f.service.google!.beginOAuth({ ...context, accountId: "owner-google", consent: "read", labels: ["Label_A"], calendars: [] });
    const account = await f.service.google!.completeOAuth(new URL(pending.url).searchParams.get("state")!, "authorization-code");
    const before = f.requests.length; assert.equal((await f.service.google!.pollOnce(account.id)).skipped, true); assert.equal(f.requests.length, before);
    f.setHandler(url => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "message-1" }] });
      if (url.pathname.endsWith("/messages/message-1")) return json({ id: "message-1", historyId: "101", labelIds: ["Label_A"], payload: { mimeType: "text/plain", body: { data: Buffer.from("Selected source text").toString("base64url") } } });
    });
    let changed = f.service.google!.updateConsent({ accountId: account.id, expectedRevision: account.revision, labels: account.labels, calendars: [], retentionAllowed: true, cloudAllowed: false });
    await f.service.google!.pollOnce(account.id); assert.equal(f.changes.length, 1); assert.equal(f.changes[0].cloudAllowed, false); assert.equal(f.service.google!.readGoogleContext(context.projectId).entries.length, 0);
    changed = f.service.google!.updateConsent({ accountId: account.id, expectedRevision: changed.revision, labels: account.labels, calendars: [], retentionAllowed: true, cloudAllowed: true });
    f.setHandler(url => {
      if (url.pathname.endsWith("/history")) return json({ historyId: "102", history: [{ messagesAdded: [{ message: { id: "message-1" } }] }] });
      if (url.pathname.endsWith("/messages/message-1")) return json({ id: "message-1", historyId: "102", labelIds: ["Label_A"], snippet: "Selected source text" });
    });
    await f.service.google!.pollOnce(account.id); const entry = f.service.google!.readGoogleContext(context.projectId).entries[0]; assert.ok(entry);
    assert.equal(f.service.google!.authorizeGoogleContext(entry, context.projectId), true); assert.equal(f.service.google!.authorizeGoogleContext(entry, "other-project"), false);
    f.service.google!.updateConsent({ accountId: account.id, expectedRevision: changed.revision, labels: [], calendars: [], retentionAllowed: false, cloudAllowed: false });
    assert.equal(f.service.google!.authorizeGoogleContext(entry, context.projectId), false); assert.equal(f.service.google!.readGoogleContext(context.projectId).entries.length, 0);
    await f.restart(); assert.equal(f.service.google!.readGoogleContext(context.projectId).entries.length, 0);
  } finally { await f.cleanup(); }
});

test("Google disconnect cancels an in-flight selected-source read before retained publication", async () => {
  const f = await fixture();
  try {
    await f.connect(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    f.setHandler((url, init) => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "message-1" }] });
      if (url.pathname.endsWith("/messages/message-1")) { entered(); return new Promise((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }); }); }
    });
    const read = f.service.google!.pollOnce("owner-google"), rejected = assert.rejects(read, /disconnected/);
    await started; f.service.google!.disconnect("owner-google"); await rejected;
    assert.equal(f.changes.length, 0); assert.equal(f.service.google!.readGoogleContext(context.projectId).entries.length, 0);
  } finally { await f.cleanup(); }
});

test("Twilio priority calls require verified fixed owner, deadline policy, configured costs and authenticated webhooks", async () => {
  const f = await fixture();
  try {
    const input = { ...context, id: "call-1", issueId: "issue-1", blocked: true, unansweredSince: "2026-11-09T08:40:00.000Z", deadlineAt: "2026-11-09T09:30:00.000Z" };
    await assert.rejects(f.service.twilio!.startPriorityCall(input), /Verified owner/);
    await f.service.twilio!.verifyOwnerNumber(context); f.enableCalls();
    await assert.rejects(f.service.twilio!.startPriorityCall({ ...input, unansweredSince: "2026-11-09T08:59:00.000Z" }), /10 minutes/);
    const call = await f.service.twilio!.startPriorityCall(input); assert.equal(call.callSid, callSid);
    assert.equal((await f.service.twilio!.startPriorityCall(input)).callSid, callSid);
    const request = f.requests.find(item => item.url.pathname.endsWith("/Calls.json"))!;
    const form = new URLSearchParams(String(request.init.body)); assert.equal(form.get("To"), "+15550002222"); assert.equal(form.get("TimeLimit"), "300"); assert.equal(form.get("Record"), "false");
    await assert.rejects(f.service.twilio!.startPriorityCall({ ...input, id: "call-2", issueId: "issue-2" }), /five-minute/);
    const url = form.get("Url")!, parameters = { CallSid: callSid, AccountSid: accountSid, To: "+15550002222", From: "+15550001111" };
    assert.throws(() => f.service.twilio!.voiceWebhook(url, parameters, "wrong"), /Unauthenticated/);
    const twiml = f.service.twilio!.voiceWebhook(url, parameters, f.sign(url, parameters)); assert.match(twiml, /trusted Jarvis review page/); assert.doesNotMatch(twiml, /issue-1|project-1|Private/);
    await assert.rejects(f.service.authorizeCall(callSid, { credentialId: "credential", ownerSessionId: "session", verifiedAt: "invalid", expiresAt: "invalid" }));
  } finally { await f.cleanup(); }
});

test("Twilio media stays generic until live call-bound passkey proof, converts audio and invalidates expired proof", async () => {
  const f = await fixture();
  try {
    await f.service.twilio!.verifyOwnerNumber(context); f.enableCalls();
    await f.service.twilio!.startPriorityCall({ ...context, id: "media-call", issueId: "issue-1", blocked: true, unansweredSince: "2026-11-09T08:40:00.000Z", deadlineAt: "2026-11-09T09:30:00.000Z" });
    const url = "https://jarvis.example/v1/cloud/integrations/twilio/voice?id=media-call", parameters = { CallSid: callSid, AccountSid: accountSid, To: "+15550002222", From: "+15550001111" };
    const twiml = f.service.twilio!.voiceWebhook(url, parameters, f.sign(url, parameters)); const token = /name="token" value="([^"]+)"/.exec(twiml)![1];
    const mediaUrl = "https://jarvis.example/v1/cloud/integrations/twilio/media", output: unknown[] = [];
    const media = f.service.twilio!.openMediaConnection(mediaUrl, f.sign(mediaUrl, {}), frame => output.push(frame));
    await media.receive(JSON.stringify({ event: "start", start: { callSid, streamSid, accountSid, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { token } } }));
    const frame = (chunk: number) => JSON.stringify({ event: "media", streamSid, media: { track: "inbound", chunk: String(chunk), payload: Buffer.alloc(160, 255).toString("base64") } });
    await media.receive(frame(1)); assert.equal(f.speechOptions, undefined); assert.equal(f.pcm.length, 0); assert.equal(await f.service.verifiedCall(callSid), null);
    await f.service.authorizeCall(callSid, { credentialId: "credential", ownerSessionId: "session", verifiedAt: f.now(), expiresAt: "2026-11-09T09:02:00.000Z" });
    assert.deepEqual(await f.service.verifiedCall(callSid), { callSid, projectId: context.projectId, status: "in_progress" });
    await media.receive(frame(2)); assert.equal(f.pcm[0].length, 640); assert.equal(f.pcm[0].every(byte => byte === 0), true);
    assert.equal(await f.speechOptions!.onTranscript("What changed?"), "Private project status");
    f.speechOptions!.onAudio(Buffer.alloc(960)); assert.equal(output.length, 1);
    f.advance(120_001); assert.equal(await f.speechOptions!.onTranscript("What changed?"), null); assert.equal(await f.service.verifiedCall(callSid), null);
    const count = output.length; f.speechOptions!.onAudio(Buffer.alloc(960)); assert.equal(output.length, count);
    media.close();
  } finally { await f.cleanup(); }
});

test("G.711 conversion preserves silence, sign and bounded frame sizes", () => {
  const silence = muLaw8kToPcm16k(Buffer.from([255, 127])); assert.deepEqual([...silence], [0, 0, 0, 0, 0, 0, 0, 0]);
  const positive = Buffer.alloc(8); positive.writeInt16LE(10000, 0); positive.writeInt16LE(10000, 2); positive.writeInt16LE(-10000, 4); positive.writeInt16LE(-10000, 6);
  const restored = muLaw8kToPcm16k(pcmToMuLaw8k(positive)); assert.ok(restored.readInt16LE(0) > 9000); assert.ok(restored.readInt16LE(4) < -9000);
  assert.throws(() => muLaw8kToPcm16k(Buffer.alloc(8001)), /too large/); assert.throws(() => pcmToMuLaw8k(Buffer.alloc(3)), /Invalid/);
});

function waitingObjective(): Objective {
  return { version: 1, id: "objective-1", requestId: "request-1", projectId: "project-1", title: "Research", goal: "Compare the selected sources", revision: 1,
    status: "waiting_for_user", cancelRequested: false, createdAt: "2026-11-09T08:00:00.000Z", updatedAt: "2026-11-09T09:00:00.000Z", deadlineAt: "2026-11-09T09:45:00.000Z", wakeAt: null,
    steps: [], attempts: [], checkpoint: null, question: { id: "question-1", revision: 1, prompt: "Which sources?", expiresAt: "2026-11-09T10:00:00.000Z" },
    budget: { limitUsd: 5, spentUsd: 0, reservedUsd: 0 }, lastError: null };
}

test("outreach is disabled by default and escalation derives a known-sent current question with a ten-minute wait", async () => {
  const f = await fixture();
  try {
    const objective = waitingObjective(); assert.equal(f.service.readOutreachPolicy(context.projectId).enabled, false);
    assert.equal(await f.service.considerObjectiveCall(objective), null);
    assert.throws(() => f.service.updateOutreachPolicy({ projectId: context.projectId, expectedRevision: 0, enabled: true, timeZone: "UTC", timezoneConfirmed: false, categories: ["blocking_deadline"] }), /Confirm/);
    f.enableCalls(); await f.service.twilio!.verifyOwnerNumber(context); await f.pair();
    assert.equal(await f.service.considerObjectiveCall(objective), null);
    f.service.telegram!.enqueue({ id: "blocking-question", projectId: objective.projectId, objectiveId: objective.id, kind: "question", disclosure: "project_details", text: objective.question!.prompt, notBefore: f.now(),
      question: { kind: "objective", objectiveId: objective.id, questionId: objective.question!.id, revision: objective.question!.revision, expiresAt: objective.question!.expiresAt } });
    await f.service.telegram!.flushOnce(); f.advance(599_999); assert.equal(await f.service.considerObjectiveCall(objective), null);
    f.advance(2); assert.equal((await f.service.considerObjectiveCall(objective))!.callSid, callSid); assert.equal(await f.service.considerObjectiveCall(objective), null);
    assert.equal(f.requests.filter(request => request.url.pathname.endsWith("/Calls.json")).length, 1);
    await f.restart(); assert.equal(f.service.readOutreachPolicy(context.projectId).enabled, true);
  } finally { await f.cleanup(); }
});

test("call-when-ready needs a fresh owner request for the authoritative unchanged objective and consumes it once", async () => {
  let current = { ...waitingObjective(), status: "running" as const, question: null } as Objective;
  const f = await fixture({ hooks: { async onStop() {}, authorizeDisclosure: () => true, authorizeCallOutreach: () => true, async readObjective() { return current; } } });
  try {
    f.enableCalls(); await f.service.twilio!.verifyOwnerNumber(context);
    await assert.rejects(f.service.requestCallWhenReady({ projectId: current.projectId, objectiveId: current.id, expectedRevision: 2, expiresAt: "2026-11-09T18:00:00.000Z" }), /changed/);
    await f.service.requestCallWhenReady({ projectId: current.projectId, objectiveId: current.id, expectedRevision: 1, expiresAt: "2026-11-09T18:00:00.000Z" });
    assert.equal(await f.service.considerObjectiveCall(current), null);
    current = { ...current, revision: 2, status: "completed" };
    assert.equal(await f.service.considerObjectiveCall({ ...current, goal: "Changed work" }), null);
    assert.equal((await f.service.considerObjectiveCall(current))!.callSid, callSid); assert.equal(await f.service.considerObjectiveCall(current), null);
  } finally { await f.cleanup(); }
});

test("real HTTP callback routing rejects forged Twilio requests and settles an authenticated terminal receipt", async () => {
  const f = await fixture();
  const server = createServer((request, response) => { void f.service.route(request, response, new URL(request.url!, "https://jarvis.example")).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    await f.service.twilio!.verifyOwnerNumber(context); f.enableCalls();
    await f.service.twilio!.startPriorityCall({ ...context, id: "http-call", issueId: "issue-http", blocked: true, unansweredSince: "2026-11-09T08:40:00.000Z", deadlineAt: "2026-11-09T09:30:00.000Z" });
    const path = "/v1/cloud/integrations/twilio/voice?id=http-call", publicUrl = `https://jarvis.example${path}`;
    const parameters = { CallSid: callSid, AccountSid: accountSid, To: "+15550002222", From: "+15550001111" };
    const target = `http://127.0.0.1:${address.port}${path}`;
    const forged = await fetch(target, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "forged" }, body: new URLSearchParams(parameters) });
    assert.equal(forged.status, 403);
    const accepted = await fetch(target, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": f.sign(publicUrl, parameters) }, body: new URLSearchParams(parameters) });
    assert.equal(accepted.status, 200); assert.match(await accepted.text(), /<Connect>/);
    const statusPath = "/v1/cloud/integrations/twilio/status?id=http-call", status = { CallSid: callSid, AccountSid: accountSid, CallStatus: "completed", CallDuration: "59" };
    const terminal = await fetch(`http://127.0.0.1:${address.port}${statusPath}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": f.sign(`https://jarvis.example${statusPath}`, status) }, body: new URLSearchParams(status) });
    assert.equal(terminal.status, 204); assert.equal(await f.service.readCall(callSid), null);
    assert.equal(f.service.twilio!.calls()[0].chargedUsd, 0.01);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test("telephony speech uses the existing authenticated WebSocket protocol and ignores input while thinking", { timeout: 5000 }, async () => {
  const server = createServer(), sockets = new WebSocketServer({ server });
  let commit!: () => void, spoken!: () => void, respond!: () => void, heard!: () => void;
  const committed = new Promise<void>(resolve => { commit = resolve; }), speech = new Promise<void>(resolve => { spoken = resolve; }), heardAudio = new Promise<void>(resolve => { heard = resolve; });
  const frames: Record<string, unknown>[] = [], audio: Buffer[] = []; let failed = false;
  sockets.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer fixture-private-voice-token");
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>; frames.push(frame);
      const header = { version: 1, sessionId: frame.sessionId, generation: frame.generation };
      if (frame.type === "start") socket.send(JSON.stringify({ ...header, type: "state", state: "listening", detail: null }));
      if (frame.type === "commit") { respond = () => socket.send(JSON.stringify({ ...header, type: "transcript", text: "Give me the status", final: true, context: { roomId: "project-1", conversationId: null, question: null } })); commit(); }
      if (frame.type === "speak") {
        socket.send(JSON.stringify({ ...header, type: "audio", sequence: 0, sampleRate: 24000, pcm: Buffer.alloc(960).toString("base64") }));
        socket.send(JSON.stringify({ ...header, type: "audio_end" })); spoken();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const adapter = new ExistingVoiceSpeechAdapter({ url: `ws://127.0.0.1:${address.port}/v1/voice/stream`, token: "fixture-private-voice-token" });
  const controller = new AbortController();
  const session = await adapter.open({ callSid, context: { roomId: "project-1", conversationId: null, question: null }, signal: controller.signal,
    onAudio(bytes) { audio.push(bytes); heard(); }, async onTranscript(text) { assert.equal(text, "Give me the status"); return "A concise reply"; }, onError() { failed = true; } });
  try {
    session.acceptPcm(Buffer.alloc(32000)); await committed;
    for (let i = 0; i < 100; i++) session.acceptPcm(Buffer.alloc(640));
    assert.equal(failed, false); respond(); await speech;
    await heardAudio;
    assert.equal(frames.filter(frame => frame.type === "audio").length, 2);
    assert.equal(frames.find(frame => frame.type === "speak")!.text, "A concise reply");
    assert.equal(audio[0].length, 960);
  } finally {
    session.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
