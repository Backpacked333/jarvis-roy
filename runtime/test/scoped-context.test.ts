import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";
import { readWindow, listWindows, type DesktopOptions } from "../agent/lib/desktop.ts";
import { readCalendarContext } from "../agent/lib/apple-services/calendar-context.ts";
import { createConnectedServices } from "../agent/lib/connected-services.ts";
import { appleScripts } from "../agent/lib/apple-services/scripts.ts";
import { KnowledgeService } from "../bridge/knowledge/index.ts";
import { readScopedContext, discoverContextResources, windowResourceId, calendarResourceId, mailResourceId } from "../bridge/knowledge-context.ts";

const target = { bundleId: "com.example.Editor", windowId: 42, processId: 123, launchTimestamp: 1_700_000_000.25 };
const windowResult = { kind: "window" as const, ...target, text: "Selected document", truncated: false, contentLabel: "UNTRUSTED WINDOW CONTENT" };
const start = "2026-11-01T00:00:00.000Z", end = "2026-11-08T00:00:00.000Z";
const event = { occurrenceId: "a".repeat(64), eventId: "series", calendarId: "chosen", title: "Seminar", start, end: "2026-11-01T01:00:00.000Z", isAllDay: false };

async function directory(t: TestContext) {
  const value = await mkdtemp(path.join(tmpdir(), "jarvis-scoped-context-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
async function helper(t: TestContext, handler: string): Promise<DesktopOptions> {
  const file = path.join(await directory(t), "helper.cjs");
  await writeFile(file, `#!${process.execPath}\nlet text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(text);${handler}});`, { mode: 0o700 });
  return { platform: "darwin", environment: { JARVIS_ENABLE_DESKTOP: "1", JARVIS_ENABLE_APPLE_SERVICES: "1", JARVIS_NATIVE_HELPER: file } };
}
const response = (result: unknown) => `process.stdout.write(JSON.stringify({ok:true,result:${JSON.stringify(result)}}));`;

test("selected window read forwards all observed identity and cannot fall back to main-screen capture", async (t) => {
  const expected = { version: 1, operation: "read_window", bundleId: target.bundleId, windowId: target.windowId,
    expectedProcessId: target.processId, expectedLaunchTimestamp: target.launchTimestamp };
  const options = await helper(t, `if(JSON.stringify(input)!==${JSON.stringify(JSON.stringify(expected))})process.exit(1);${response(windowResult)}`);
  const result = await readWindow(target, undefined, options);
  assert.equal(result.text, "Selected document");
  assert.match(result.contentLabel, /Only the selected window/);
  for (const changed of [{ windowId: 43 }, { bundleId: "com.example.Other" }, { processId: 124 }, { launchTimestamp: 1_700_000_002 }]) {
    const mismatched = await helper(t, response({ ...windowResult, ...changed }));
    await assert.rejects(readWindow(target, undefined, mismatched), /different window or process/);
  }
  const mainScreen = await helper(t, response({ kind: "screen", text: "Whole display", truncated: false, contentLabel: "UNTRUSTED SCREEN CONTENT" }));
  await assert.rejects(readWindow(target, undefined, mainScreen), /different window or process/);
});

test("window discovery remains app-scoped and rejects duplicate IDs", async (t) => {
  const result = { kind: "windows", bundleId: target.bundleId, processId: target.processId, launchTimestamp: target.launchTimestamp,
    windows: [{ windowId: 42, title: "password=fixture", frame: { x: 0, y: 0, width: 400, height: 300 }, onScreen: true }], truncated: false };
  const options = await helper(t, response(result));
  const listed = await listWindows({ bundleId: target.bundleId }, undefined, options);
  assert.match(listed.windows[0]!.title, /redacted/i);
  const duplicate = await helper(t, response({ ...result, windows: [result.windows[0], result.windows[0]] }));
  await assert.rejects(listWindows({ bundleId: target.bundleId }, undefined, duplicate), /duplicate window/);
});

test("EventKit adapter preserves distinct recurring occurrences and rejects calendar/range substitution", async (t) => {
  const input = { action: "list_events", calendarId: "chosen", start, end, limit: 2 };
  const value = { kind: "calendar_events", calendarId: "chosen", start, end, events: [event,
    { ...event, occurrenceId: "b".repeat(64), start: "2026-11-02T00:00:00.000Z", end: "2026-11-02T01:00:00.000Z" }], truncated: false };
  const options = await helper(t, response(value));
  const result = await readCalendarContext(input, undefined, options);
  assert.equal(result.kind, "calendar_events");
  if (result.kind === "calendar_events") assert.equal(result.events.length, 2);
  for (const invalid of [
    { ...value, calendarId: "other" }, { ...value, events: [{ ...event, calendarId: "other" }] },
    { ...value, events: [event, event] }, { ...value, events: [{ ...event, start: end, end: "2026-11-09T00:00:00.000Z" }] },
  ]) {
    const badOptions = await helper(t, response(invalid));
    await assert.rejects(readCalendarContext(input, undefined, badOptions), /outside the selected/);
  }
  const instantOptions = await helper(t, response({ ...value, events: [{ ...event, end: start }] }));
  assert.equal((await readCalendarContext(input, undefined, instantOptions)).kind, "calendar_events");
});

test("Mail account filtering reads no content from other accounts, even with duplicate message IDs", () => {
  let outsideReads = 0;
  const message = (accountId: string, id: number) => ({ id: () => id,
    mailbox: () => ({ account: () => ({ id: () => accountId }) }),
    subject: () => { if (accountId !== "chosen") outsideReads++; return "Subject"; },
    sender: () => { if (accountId !== "chosen") outsideReads++; return "sender@example.invalid"; },
    dateReceived: () => new Date("2026-11-06T00:00:00Z"),
    content: () => { if (accountId !== "chosen") outsideReads++; return "Selected body"; },
  });
  const messages = [message("other", 12), message("chosen", 12), message("other", 13)];
  const app = { accounts: { whose: ({ id }: { id: string }) => id === "chosen" ? [{ enabled: () => true }] : [] },
    inbox: { messages: { whose: (input: { id?: number }) => messages.filter((item) => input.id === undefined || item.id() === input.id) } } };
  const run = (input: object) => JSON.parse(runInNewContext(`${appleScripts.mail.source}\nrun(argv)`, { Application: () => app, argv: [JSON.stringify(input)] }));
  const listed = run({ action: "list_inbox", accountId: "chosen", since: "2026-11-01T00:00:00Z", limit: 25 });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.accountId, "chosen");
  assert.deepEqual(listed.data.messages.map((item: { messageId: number }) => item.messageId), [12]);
  const selected = run({ action: "read_message", accountId: "chosen", messageId: 12 });
  assert.equal(selected.data.body, "Selected body");
  assert.equal(selected.data.accountId, "chosen");
  assert.equal(run({ action: "read_message", accountId: "chosen", messageId: 13 }).code, "message_not_found");
  assert.equal(run({ action: "read_message", accountId: "missing", messageId: 12 }).code, "account_unavailable");
  assert.equal(outsideReads, 0);
});

test("Mail adapter validates selected account on every returned message", async () => {
  const adapter = createConnectedServices({ env: { JARVIS_ENABLE_APPLE_SERVICES: "1" }, platform: "darwin", now: () => Date.parse(end),
    appleRunner: async () => ({ accountId: "chosen", messages: [{ messageId: 12, accountId: "other", subject: "Other", sender: "sender", receivedAt: start }], truncated: false, ordering: "fixture" }) });
  await assert.rejects(adapter.email({ action: "list_inbox", accountId: "chosen", since: start, limit: 25 }), /outside the selected account/);
});

async function knowledge(t: TestContext) {
  const store = await KnowledgeService.open({ dataDirectory: await directory(t), enabled: true });
  t.after(() => store.close());
  return store;
}

test("scoped reads bind selectors, project and cloud disclosure to an exact persisted grant", async (t) => {
  const store = await knowledge(t);
  const grant = store.createGrant({ projectId: "project", resourceKind: "window", resourceId: windowResourceId(target), label: "Editor", operations: ["inspect_window"], cloudAllowed: false, expiresAt: null });
  const input = { kind: "window", projectId: "project", grantId: grant.id, resourceId: grant.resourceId, purpose: "local", target };
  let reads = 0;
  const dependencies = { window: async () => { reads++; return windowResult; } };
  assert.equal((await readScopedContext(input, store, undefined, dependencies)).resourceId, grant.resourceId);
  for (const changed of [ { purpose: "cloud" }, { projectId: "other" }, { target: { ...target, windowId: 43 } }, { target: { ...target, launchTimestamp: 1_700_000_002 } }]) {
    await assert.rejects(readScopedContext({ ...input, ...changed }, store, undefined, dependencies), /grant|disclosure/);
  }
  assert.equal(reads, 1);
});

test("grant revocation during context read aborts I/O and withholds the result", async (t) => {
  const store = await knowledge(t);
  const grant = store.createGrant({ projectId: "project", resourceKind: "mail_account", resourceId: mailResourceId("chosen"), label: "Mail", operations: ["read_mail"], cloudAllowed: true, expiresAt: null });
  let started!: () => void, complete!: () => void;
  const entered = new Promise<void>((done) => { started = done; });
  const pending = new Promise<void>((done) => { complete = done; });
  let readSignal: AbortSignal | undefined;
  const result = readScopedContext({ kind: "mail_account", projectId: "project", grantId: grant.id, resourceId: grant.resourceId,
    purpose: "cloud", request: { action: "read_message", accountId: "chosen", messageId: 12 } }, store, undefined, {
    mail: async (_input, context) => { readSignal = context?.signal; started(); await pending; return { body: "Must not return" }; },
  });
  await entered;
  store.revokeGrant(grant.id, grant.revision);
  assert.equal(readSignal?.aborted, true);
  complete();
  await assert.rejects(result, /revoked/);
});

test("discovery returns exact grant resource targets and scoped Mail cannot omit an account", async (t) => {
  const result = await discoverContextResources({ projectId: "project", kind: "calendar" }, undefined, {
    calendar: async () => ({ kind: "calendars", calendars: [{ calendarId: "chosen", title: "Work", sourceTitle: "Local" }], truncated: false }),
  });
  assert.equal(result.resources[0]!.resourceId, calendarResourceId("chosen"));
  const store = await knowledge(t);
  await assert.rejects(readScopedContext({ kind: "mail_account", projectId: "project", grantId: "grant", resourceId: "mail_account:chosen",
    purpose: "cloud", request: { action: "read_message", messageId: 12 } }, store));
});
