import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Script, runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import test from "node:test";
import { z } from "zod";
import { connectedServicesStatus, createConnectedServices, ConnectedServiceError, calendarServiceSchema, emailServiceSchema, homeServiceSchema, messageServiceSchema } from "../agent/lib/connected-services.ts";
import { createAppleRunner, type AppleRunner } from "../agent/lib/apple-services/process.ts";
import { appleScripts } from "../agent/lib/apple-services/scripts.ts";
import { homeConfiguration } from "../agent/lib/apple-services/home-assistant.ts";
import emailTool from "../agent/tools/email_service.ts";
import calendarTool from "../agent/tools/calendar_service.ts";
import messageTool from "../agent/tools/message_service.ts";
import homeTool from "../agent/tools/home_service.ts";

const appleEnv = { JARVIS_ENABLE_APPLE_SERVICES: "1" };
const homeEnv = { HOME_ASSISTANT_URL: "https://fixture.invalid:8123", HOME_ASSISTANT_TOKEN: "fixture-private-token" };
const mailSend = { action: "send", accountId: "fixture-account", from: "sender@example.invalid", to: ["recipient@example.invalid"], subject: "Exact subject", body: "Exact plain text\nSecond line" };
const eventCreate = { action: "create_event", calendarId: "fixture-calendar", title: "Fixture event", start: "2026-11-08T09:00:00-05:00", end: "2026-11-08T10:00:00-05:00", notes: "No attendees", location: "Fixture location" };
const imessageSend = { action: "send", serviceId: "fixture-imessage", recipient: "+15555550100", body: "Fixture only" };
const homeCall = { action: "call_service", domain: "light", service: "turn_on", entityId: "light.fixture", data: { brightness: 100 } };
const submitted = { status: "submitted", delivery: "unconfirmed" };
const header = { messageId: 123, subject: "Fixture subject", sender: "sender@example.invalid", receivedAt: "2026-11-06T12:00:00.000Z" };

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-connected-services-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function childFixture() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 999_999, stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const noNetwork: typeof fetch = async () => { throw new Error("Unexpected network call"); };

test("status reports configuration, never connected accounts, secrets or provider origin", () => {
  assert.equal(connectedServicesStatus({}, "darwin").mail.state, "disabled");
  assert.equal(connectedServicesStatus(appleEnv, "linux").mail.state, "requires_macos");
  assert.equal(connectedServicesStatus(appleEnv, "darwin").mail.state, "configured_unverified");
  const configured = connectedServicesStatus({ ...appleEnv, ...homeEnv }, "darwin");
  assert.equal(configured.homeAssistant.state, "configured_unverified");
  assert.equal(configured.messages.unsupported.includes("read_history"), true);
  assert.equal(JSON.stringify(configured).includes(homeEnv.HOME_ASSISTANT_TOKEN), false);
  assert.equal(JSON.stringify(configured).includes("fixture.invalid"), false);
  assert.equal(connectedServicesStatus({ HOME_ASSISTANT_TOKEN: "fixture" }).homeAssistant.state, "invalid_configuration");
});

test("all four tools require fresh approval even for reads, and policy evaluation has no side effects", async () => {
  for (const tool of [emailTool, calendarTool, messageTool, homeTool]) {
    assert.equal(tool.availableInSubagents, false);
    assert.equal(typeof tool.approval, "function");
    const policy = tool.approval as () => unknown;
    assert.equal(await policy(), "user-approval");
    assert.equal(await policy(), "user-approval");
  }
  for (const schema of [emailServiceSchema, calendarServiceSchema, messageServiceSchema, homeServiceSchema]) {
    const json = z.toJSONSchema(schema);
    assert.equal(json.type, "object");
    assert.equal("oneOf" in json, false);
  }
});

test("disabled/native-unavailable/pre-cancelled adapters never launch an app or transport", async () => {
  let calls = 0;
  const runner: AppleRunner = async () => { calls++; return {}; };
  const disabled = createConnectedServices({ env: {}, platform: "darwin", appleRunner: runner, fetch: noNetwork });
  await assert.rejects(disabled.email({ action: "list_accounts" }), /disabled/);
  await assert.rejects(disabled.calendar({ action: "list_calendars" }), /disabled/);
  await assert.rejects(disabled.message({ action: "list_services" }), /disabled/);
  await assert.rejects(disabled.home({ action: "list_entities", limit: 10 }), /not connected/);
  const unsupported = await disabled.message({ action: "read_history" });
  assert.equal((unsupported as { status: string }).status, "unsupported");
  const linux = createConnectedServices({ env: appleEnv, platform: "linux", appleRunner: runner });
  await assert.rejects(linux.email({ action: "list_accounts" }), /require macOS/);
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  await assert.rejects(disabled.email({ action: "list_accounts" }, { signal: controller.signal }), /cancelled before execution/);
  assert.equal(calls, 0);
});

test("schemas reject unsupported/excess fields, unsafe recipients, bad dates and ranges before execution", async () => {
  for (const invalid of [
    { ...mailSend, script: "anything" }, { ...mailSend, attachments: ["/private/path"] }, { ...mailSend, cc: ["elsewhere@example.invalid"] },
    { ...mailSend, to: Array(6).fill("recipient@example.invalid") }, { ...mailSend, to: ["same@example.invalid", "SAME@example.invalid"] },
    { ...mailSend, subject: "hello\r\nBcc: elsewhere@example.invalid" }, { ...mailSend, body: "x\0y" },
    { action: "read_message", messageId: "../../../mail" }, { action: "list_inbox", since: "2026-11-01", limit: 26 },
  ]) assert.equal(emailServiceSchema.safeParse(invalid).success, false);
  for (const invalid of [
    { ...eventCreate, start: "2026-02-30T09:00:00Z" }, { ...eventCreate, end: "2026-11-08T08:00:00-05:00" },
    { ...eventCreate, end: "2027-11-08T10:00:00-05:00" }, { ...eventCreate, attendees: ["guest@example.invalid"] },
    { ...eventCreate, calendarId: "" }, { ...eventCreate, start: "2026-11-08T09:00:00" },
  ]) assert.equal(calendarServiceSchema.safeParse(invalid).success, false);
  assert.equal(messageServiceSchema.safeParse({ ...imessageSend, recipient: "555 555 0100" }).success, false);
  assert.equal(messageServiceSchema.safeParse({ ...imessageSend, service: "SMS" }).success, false);
  let calls = 0;
  const adapter = createConnectedServices({ env: appleEnv, platform: "darwin", now: () => Date.parse("2026-11-06T12:00:00Z"), appleRunner: async () => { calls++; return {}; } });
  await assert.rejects(adapter.email({ action: "list_inbox", since: "2026-09-01T00:00:00Z", limit: 1 }), /last 30 days/);
  await assert.rejects(adapter.email({ action: "list_inbox", since: "2026-11-07T00:00:00Z", limit: 1 }), /future/);
  await assert.rejects(adapter.calendar({ ...eventCreate, attendees: [] }), /Invalid connected-service input/);
  assert.equal(calls, 0);
});

test("osascript uses fixed embedded source, separate argv, no shell, detached group and minimal environment", async () => {
  const child = childFixture();
  let invocation: { command: string; argv: readonly string[]; options: SpawnOptions } | undefined;
  const runner = createAppleRunner({ spawn: (command, argv, options) => { invocation = { command, argv, options }; return child; } });
  const untrusted = '"; do shell script "DO_NOT_EXECUTE"\n-- -e evil';
  const promise = runner("message_send", ["fixture-service", "+15555550100", untrusted], {});
  assert.equal(invocation?.command, "/usr/bin/osascript");
  assert.deepEqual(invocation?.argv, ["-l", "AppleScript", "-e", appleScripts.message_send.source, "--", "fixture-service", "+15555550100", untrusted]);
  assert.equal(invocation?.argv[3].includes(untrusted), false);
  assert.equal(invocation?.options.shell, false);
  assert.equal(invocation?.options.detached, true);
  assert.deepEqual(Object.keys(invocation?.options.env ?? {}).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(invocation?.options.env?.PATH, "/usr/bin:/bin");
  child.stdout?.emit("data", Buffer.from(JSON.stringify({ ok: true, data: submitted })));
  child.emit("close", 0);
  assert.deepEqual(await promise, submitted);
  for (const script of Object.values(appleScripts)) {
    if (script.language === "JavaScript") assert.doesNotThrow(() => new Script(script.source));
  }
});

test("process failures with private stderr are sanitized; Automation denial is actionable", async () => {
  for (const scenario of [
    { stderr: "Private error data (-1743)", code: 1, stdout: "", expected: /Automation permission denied/ },
    { stderr: "private credentials and mailbox", code: 1, stdout: "", expected: /local app rejected/ },
    { stderr: "", code: 0, stdout: "private non-JSON content", expected: /invalid response/ },
    { stderr: "", code: 0, stdout: JSON.stringify({ ok: false, code: "private-provider-error" }), expected: /local app could not complete/ },
  ]) {
    const child = childFixture();
    const runner = createAppleRunner({ spawn: () => child });
    const result = runner("mail", ['{"action":"list_accounts"}'], {});
    child.stderr?.emit("data", Buffer.from(scenario.stderr));
    child.stdout?.emit("data", Buffer.from(scenario.stdout));
    child.emit("close", scenario.code);
    await assert.rejects(result, (error: Error) => {
      assert.match(error.message, scenario.expected);
      assert.equal(error.message.includes("private"), false);
      return true;
    });
  }
});

test("native timeouts, cancellation and output caps terminate the entire process group with escalation", async () => {
  for (const scenario of ["timeout", "cancel", "stdout", "stderr"]) {
    const child = childFixture();
    const signals: [number, string][] = [];
    const controller = new AbortController();
    const runner = createAppleRunner({ spawn: () => child, killGroup: (pid, signal) => { signals.push([pid, signal]); }, timeoutMs: 15, killGraceMs: 5 });
    const promise = runner("mail", [JSON.stringify(mailSend)], { mutation: true, signal: controller.signal });
    if (scenario === "cancel") controller.abort();
    if (scenario === "stdout") child.stdout?.emit("data", Buffer.alloc(128_001));
    if (scenario === "stderr") child.stderr?.emit("data", Buffer.alloc(8_001));
    await assert.rejects(promise, (error: ConnectedServiceError) => {
      assert.equal(error.uncertain, true);
      assert.match(error.message, /do not retry automatically/);
      return true;
    });
    child.emit("close", 1);
    await delay(10);
    assert.deepEqual(signals, [[999_999, "SIGTERM"], [999_999, "SIGKILL"]]);
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const runner = createAppleRunner({ spawn: () => { calls++; return childFixture(); } });
  await assert.rejects(runner("mail", [], { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);
});

test("native outputs are schema-bounded, selected-message-specific and stripped of credential-like data", async () => {
  const calls: unknown[] = [];
  const adapter = createConnectedServices({ env: appleEnv, platform: "darwin", appleRunner: async (script, argv) => {
    calls.push([script, JSON.parse(argv[0])]);
    return { ...header, body: "A fixture\u001b with api_key=privatefixturetoken", truncated: false, authHeader: "never return this" };
  } });
  const result = await adapter.email({ action: "read_message", messageId: 123 }) as Record<string, unknown>;
  assert.deepEqual(calls, [["mail", { action: "read_message", messageId: 123 }]]);
  assert.equal(result.body, "A fixture with api_key=[redacted]");
  assert.equal("authHeader" in result, false);
  const oversized = createConnectedServices({ env: appleEnv, platform: "darwin", appleRunner: async () => ({ ...header, body: "x".repeat(16_001), truncated: true }) });
  await assert.rejects(oversized.email({ action: "read_message", messageId: 123 }), /oversized/);
  await assert.rejects(adapter.email({ action: "read_message", messageId: 124 }), /different message/);
});

test("exact approved mail, calendar and iMessage arguments are passed once; duplicate attempts persist privately", async () => {
  await withDirectory(async (directory) => {
    const calls: { script: string; argv: string[] }[] = [];
    const runner: AppleRunner = async (script, argv) => {
      calls.push({ script, argv });
      return script === "calendar" ? { status: "created", eventId: "fixture-event" } : submitted;
    };
    const create = () => createConnectedServices({ env: appleEnv, platform: "darwin", directory, appleRunner: runner });
    const context = { sessionId: "fixture-session" };
    await create().email(mailSend, context);
    await create().calendar(eventCreate, context);
    await create().message(imessageSend, context);
    assert.deepEqual(JSON.parse(calls[0].argv[0]), mailSend);
    assert.deepEqual(JSON.parse(calls[1].argv[0]), eventCreate);
    assert.deepEqual(calls[2], { script: "message_send", argv: [imessageSend.serviceId, imessageSend.recipient, imessageSend.body] });
    await assert.rejects(create().email(mailSend, context), /identical action was already attempted/);
    await assert.rejects(create().calendar(eventCreate, context), /identical action/);
    await assert.rejects(create().message(imessageSend, context), /identical action/);
    assert.equal(calls.length, 3);
    const ledger = path.join(directory, "connected-service-operations");
    assert.equal((await stat(ledger)).mode & 0o777, 0o700);
    for (const file of await readdir(ledger)) {
      assert.match(file, /^[0-9a-f]{64}\.attempt$/);
      assert.equal(await readFile(path.join(ledger, file), "utf8"), "attempted\n");
      assert.equal((await stat(path.join(ledger, file))).mode & 0o777, 0o600);
    }
  });
});

test("uncertain sends never retry, including after a new adapter/session, and concurrent identical sends execute at most once", async () => {
  await withDirectory(async (directory) => {
    let calls = 0;
    const runner: AppleRunner = async () => { calls++; throw new Error("private provider details"); };
    const create = () => createConnectedServices({ env: appleEnv, platform: "darwin", directory, appleRunner: runner });
    await assert.rejects(create().email(mailSend, { sessionId: "first" }), /outcome is uncertain/);
    await assert.rejects(create().email(mailSend, { sessionId: "second" }), /uncertain outcome/);
    assert.equal(calls, 1);
    const result = await Promise.allSettled([create().message(imessageSend, { sessionId: "third" }), create().message(imessageSend, { sessionId: "third" })]);
    assert.equal(result.every((r) => r.status === "rejected"), true);
    assert.equal(calls, 2);
    assert.equal((await readdir(path.join(directory, "connected-service-operations"))).filter((f) => f.endsWith(".pending")).length, 2);
  });
});

test("static mail script checks approved recipients and content before its single send operation", () => {
  let sends = 0;
  let createCount = 0;
  const toRecipients: { address: () => string }[] = [];
  const content = Object.assign(() => mailSend.body, { attachments: [] });
  const message = { toRecipients, ccRecipients: [], bccRecipients: [], content, subject: () => mailSend.subject, sender: () => mailSend.from };
  const app = {
    alwaysBccMyself: () => false, alwaysCcMyself: () => false,
    accounts: { whose: () => [{ enabled: () => true, emailAddresses: () => [mailSend.from] }] },
    OutgoingMessage: (properties: unknown) => { assert.deepEqual(JSON.parse(JSON.stringify(properties)), { sender: mailSend.from, subject: mailSend.subject, content: mailSend.body, visible: false }); return message; },
    outgoingMessages: { push: () => { createCount++; } },
    ToRecipient: ({ address }: { address: string }) => ({ address: () => address }),
    send: () => { sends++; return true; },
  };
  const evaluate = () => JSON.parse(runInNewContext(`${appleScripts.mail.source}\nrun(argv)`, { Application: () => app, argv: [JSON.stringify(mailSend)] }));
  assert.deepEqual(evaluate(), { ok: true, data: submitted });
  assert.equal(createCount, 1);
  assert.equal(sends, 1);
  toRecipients.length = 0;
  message.bccRecipients.push("unexpected" as never);
  assert.equal(evaluate().code, "mail_content_changed");
  assert.equal(sends, 1);
});

test("Home Assistant origin configuration rejects token leakage routes and requires explicit private-IP HTTP opt-in", () => {
  for (const url of ["http://10.0.0.2:8123", "https://user:password@fixture.invalid", "https://@fixture.invalid", "https://fixture.invalid/path", "https://fixture.invalid/?token=private", "https://fixture.invalid/#fragment", "https://fixture.invalid/?", "https://fixture.invalid/#", "file:///api", "ftp://fixture.invalid"]) {
    assert.throws(() => homeConfiguration({ ...homeEnv, HOME_ASSISTANT_URL: url }), /Configure HOME_ASSISTANT_URL/);
  }
  for (const url of ["http://8.8.8.8", "http://home.example.invalid", "http://169.254.169.254", "http://[2001:4860:4860::8888]"]) {
    assert.throws(() => homeConfiguration({ ...homeEnv, HOME_ASSISTANT_URL: url, JARVIS_ALLOW_HOME_ASSISTANT_HTTP: "1" }));
  }
  for (const url of ["http://10.0.0.2:8123", "http://192.168.1.2", "http://172.16.0.1", "http://127.0.0.1:8123", "http://[::1]:8123", "http://[fd00::1]:8123"]) {
    assert.equal(homeConfiguration({ ...homeEnv, HOME_ASSISTANT_URL: url, JARVIS_ALLOW_HOME_ASSISTANT_HTTP: "1" })?.origin, new URL(url).origin);
  }
});

test("Home Assistant fixed endpoints/auth, redirect:error and bounded sanitized state projection", async () => {
  let invocation: { url: string; options?: RequestInit } | undefined;
  const fixtureFetch: typeof fetch = async (url, options) => {
    invocation = { url: String(url), options };
    return jsonResponse([
      { entity_id: "light.fixture", state: "on", last_changed: "2026-11-06T12:00:00Z", attributes: { token: "private", friendly_name: "Bearer private" } },
      { entity_id: "lock.front_door", state: "locked" },
      { entity_id: "switch.fixture", state: homeEnv.HOME_ASSISTANT_TOKEN },
      { entity_id: "fan.fixture", state: "off" },
    ]);
  };
  const adapter = createConnectedServices({ env: homeEnv, fetch: fixtureFetch });
  const result = await adapter.home({ action: "list_entities", limit: 2 }) as { entities: unknown[]; truncated: boolean };
  assert.equal(invocation?.url, `${homeEnv.HOME_ASSISTANT_URL}/api/states`);
  assert.equal(invocation?.options?.redirect, "error");
  assert.equal(new Headers(invocation?.options?.headers).get("authorization"), `Bearer ${homeEnv.HOME_ASSISTANT_TOKEN}`);
  assert.deepEqual(result.entities, [{ entityId: "light.fixture", state: "on", lastChanged: "2026-11-06T12:00:00Z" }, { entityId: "switch.fixture", state: "unrecognized", lastChanged: null }]);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("Home Assistant enforces domain-service-parameter allowlists before transport", async () => {
  let calls = 0;
  const adapter = createConnectedServices({ env: homeEnv, fetch: async () => { calls++; return jsonResponse([]); } });
  for (const input of [
    { ...homeCall, domain: "lock", entityId: "lock.front_door" }, { ...homeCall, domain: "alarm_control_panel" },
    { ...homeCall, service: "toggle" }, { ...homeCall, service: "run_script" }, { ...homeCall, entityId: "switch.fixture" },
    { ...homeCall, data: { entity_id: "light.some_other_fixture" } }, { ...homeCall, url: "https://exfiltrate.invalid" },
    { ...homeCall, domain: "climate", entityId: "climate.fixture", service: "turn_on", data: {} },
    { ...homeCall, domain: "media_player", entityId: "media_player.fixture", service: "volume_set", data: { volume_level: 2 } },
    { ...homeCall, domain: "fan", entityId: "fan.fixture", service: "set_percentage", data: {} },
    { ...homeCall, service: "turn_off", data: { brightness: 5 } },
  ]) await assert.rejects(adapter.home(input, { sessionId: "fixture" }), ConnectedServiceError);
  assert.equal(homeServiceSchema.safeParse({ action: "read_state", entityId: "light.fixture/../../config" }).success, false);
  assert.equal(calls, 0);
});

test("Home Assistant exact approved service is POSTed once and raw provider result is withheld", async () => {
  await withDirectory(async (directory) => {
    const calls: { url: string; body: unknown }[] = [];
    const adapter = createConnectedServices({ env: homeEnv, directory, fetch: async (url, options) => {
      assert.equal(options?.method, "POST");
      calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
      return jsonResponse([{ secret: homeEnv.HOME_ASSISTANT_TOKEN, private: "provider payload" }]);
    } });
    const result = await adapter.home(homeCall, { sessionId: "fixture-session" });
    assert.deepEqual(calls, [{ url: `${homeEnv.HOME_ASSISTANT_URL}/api/services/light/turn_on`, body: { entity_id: "light.fixture", brightness: 100 } }]);
    assert.deepEqual(result, { status: "submitted", effect: "unconfirmed", entityId: "light.fixture", domain: "light", service: "turn_on" });
    await assert.rejects(adapter.home(homeCall, { sessionId: "fixture-session" }), /identical action/);
    assert.equal(calls.length, 1);
  });
});

test("explicit pre-effect refusal can be approved again after permission/configuration is fixed", async () => {
  await withDirectory(async (directory) => {
    let attempts = 0;
    const adapter = createConnectedServices({ env: appleEnv, platform: "darwin", directory, appleRunner: async () => {
      attempts++;
      if (attempts === 1) throw new ConnectedServiceError("permission_denied", "Automation permission denied.");
      return submitted;
    } });
    await assert.rejects(adapter.email(mailSend, { sessionId: "fixture" }), /permission denied/);
    assert.deepEqual(await readdir(path.join(directory, "connected-service-operations")), []);
    assert.deepEqual(await adapter.email(mailSend, { sessionId: "fixture" }), submitted);
    assert.equal(attempts, 2);
  });
});

test("pre-cancelled/missing-session writes never create a ledger entry or call providers", async () => {
  await withDirectory(async (directory) => {
    let calls = 0;
    const adapter = createConnectedServices({ env: { ...appleEnv, ...homeEnv }, platform: "darwin", directory, appleRunner: async () => { calls++; return submitted; }, fetch: async () => { calls++; return jsonResponse([]); } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapter.email(mailSend, { sessionId: "fixture", signal: controller.signal }), /cancelled/);
    await assert.rejects(adapter.home(homeCall, { sessionId: "fixture", signal: controller.signal }), /cancelled/);
    await assert.rejects(adapter.message(imessageSend), /approved Jarvis session/);
    await assert.rejects(adapter.calendar(eventCreate), /approved Jarvis session/);
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("account reads and writes fail closed when approval redaction would hide exact arguments", async () => {
  await withDirectory(async (directory) => {
    let calls = 0;
    const adapter = createConnectedServices({ env: { ...appleEnv, ...homeEnv }, platform: "darwin", directory, appleRunner: async () => { calls++; return submitted; }, fetch: async () => { calls++; return jsonResponse([]); } });
    const context = { sessionId: "fixture" };
    for (const request of [
      () => adapter.email({ ...mailSend, body: "password=fixture-private-value" }, context),
      () => adapter.email({ action: "list_accounts", password: "fixture" }, context),
      () => adapter.email({ action: "read_message", messageId: 123, token: "fixture" }, context),
      () => adapter.calendar({ ...eventCreate, notes: "Bearer fixture-private-value" }, context),
      () => adapter.calendar({ action: "list_events", calendarId: "api_key=fixture", start: eventCreate.start, end: eventCreate.end, limit: 1 }, context),
      () => adapter.message({ ...imessageSend, body: "token=fixture-private-value" }, context),
      () => adapter.message({ action: "list_services", authorization: "fixture" }, context),
      () => adapter.home({ action: "read_state", entityId: "light.fixture", token: "fixture" }, context),
      () => adapter.home({ ...homeCall, data: { ...homeCall.data, password: "fixture" } }, context),
    ]) await assert.rejects(request, (error: ConnectedServiceError) => error.code === "unreviewable_input" && !error.message.includes("fixture-private-value"));
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("static Calendar script uses exact timezone-qualified dates/calendar without attendee or deletion operations", () => {
  let created = 0;
  let selected: unknown;
  const event = { uid: () => "fixture-created-event" };
  const app = {
    calendars: { whose: (filter: unknown) => {
      selected = filter;
      return [{ writable: () => true, events: { push: (value: unknown) => { assert.equal(value, event); created++; } } }];
    } },
    Event: (properties: Record<string, unknown>) => {
      assert.deepEqual(Object.keys(properties).sort(), ["alldayEvent", "description", "endDate", "location", "startDate", "summary"]);
      assert.equal((properties.startDate as Date).getTime(), Date.parse(eventCreate.start));
      assert.equal((properties.endDate as Date).getTime(), Date.parse(eventCreate.end));
      assert.equal(properties.summary, eventCreate.title);
      return event;
    },
  };
  const result = JSON.parse(runInNewContext(`${appleScripts.calendar.source}\nrun(argv)`, { Application: () => app, argv: [JSON.stringify(eventCreate)] }));
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), { id: eventCreate.calendarId });
  assert.deepEqual(result, { ok: true, data: { status: "created", eventId: "fixture-created-event" } });
  assert.equal(created, 1);
  assert.doesNotMatch(appleScripts.calendar.source, /attendees|\.delete\(/);
});

test("static inbox script bounds access to headers and never reads body content during listing", () => {
  let headerReads = 0;
  let selected: unknown;
  const message = { id: () => 123, subject: () => { headerReads++; return "Fixture"; }, sender: () => "fixture@example.invalid", dateReceived: () => new Date("2026-11-06T12:00:00Z"), content: () => { throw new Error("Body must not be read"); } };
  const query = { length: 1000, 0: message, 1: message };
  const app = { inbox: { messages: { whose: (filter: unknown) => { selected = filter; return query; } } } };
  const input = { action: "list_inbox", since: "2026-11-05T12:00:00Z", limit: 2 };
  const result = JSON.parse(runInNewContext(`${appleScripts.mail.source}\nrun(argv)`, { Application: () => app, argv: [JSON.stringify(input)] }));
  assert.equal(result.ok, true);
  assert.equal(result.data.messages.length, 2);
  assert.equal(result.data.truncated, true);
  assert.equal(headerReads, 2);
  assert.equal(JSON.stringify(selected), JSON.stringify({ dateReceived: { _greaterThanEquals: new Date(input.since) } }));
});

test("all Home Assistant allowlisted service/parameter combinations remain exact", async () => {
  await withDirectory(async (directory) => {
    const actions = [
      ["light", "turn_on", {}], ["light", "turn_off", {}], ["switch", "turn_on", {}], ["switch", "turn_off", {}],
      ["fan", "turn_on", {}], ["fan", "turn_off", {}], ["fan", "set_percentage", { percentage: 30 }],
      ["climate", "set_temperature", { temperature: 22 }], ["climate", "set_hvac_mode", { hvac_mode: "heat" }],
      ["media_player", "turn_on", {}], ["media_player", "turn_off", {}], ["media_player", "media_play", {}],
      ["media_player", "media_pause", {}], ["media_player", "media_stop", {}], ["media_player", "volume_set", { volume_level: 0.2 }],
    ] as const;
    let calls = 0;
    for (const [domain, service, data] of actions) {
      const adapter = createConnectedServices({ env: homeEnv, directory, fetch: async (url, options) => {
        calls++;
        assert.equal(String(url), `${homeEnv.HOME_ASSISTANT_URL}/api/services/${domain}/${service}`);
        assert.deepEqual(JSON.parse(String(options?.body)), { entity_id: `${domain}.fixture`, ...data });
        return jsonResponse([]);
      } });
      await adapter.home({ action: "call_service", domain, service, data, entityId: `${domain}.fixture` }, { sessionId: "fixture" });
    }
    assert.equal(calls, actions.length);
  });
});

test("Home Assistant rejects mismatched reads and malformed successful writes instead of claiming success", async () => {
  await withDirectory(async (directory) => {
    const adapter = createConnectedServices({ env: homeEnv, directory, fetch: async () => jsonResponse({ entity_id: "switch.other", state: "on" }) });
    await assert.rejects(adapter.home({ action: "read_state", entityId: "light.fixture" }), /mismatched/);
    await assert.rejects(adapter.home(homeCall, { sessionId: "fixture" }), (error: ConnectedServiceError) => error.code === "invalid_response" && error.uncertain);
    await assert.rejects(adapter.home(homeCall, { sessionId: "new-session" }), /uncertain outcome/);
  });
});

test("Home Assistant errors, redirects, wrong content types and oversized responses never expose provider bodies", async () => {
  for (const response of [
    jsonResponse({ private: homeEnv.HOME_ASSISTANT_TOKEN }, 401), jsonResponse({ private: "credential" }, 403),
    jsonResponse({ private: "credential" }, 404), jsonResponse({ private: "credential" }, 500),
    new Response("private", { status: 302, headers: { location: "https://other.invalid" } }),
    new Response("private HTML", { headers: { "content-type": "text/html" } }),
    new Response("private malformed", { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(512_001), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "512001" } }),
  ]) {
    const adapter = createConnectedServices({ env: homeEnv, fetch: async () => response });
    await assert.rejects(adapter.home({ action: "list_entities", limit: 1 }), (error: Error) => {
      assert.equal(error.message.includes("credential"), false);
      assert.equal(error.message.includes(homeEnv.HOME_ASSISTANT_TOKEN), false);
      assert.equal(error.message.includes("malformed"), false);
      return true;
    });
  }
});

test("real fetch against an isolated loopback redirect fixture never forwards the Authorization token", async () => {
  let redirectedHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/api/states") res.writeHead(302, { location: "/unexpected-target" }).end();
    else { redirectedHits++; res.writeHead(200).end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const adapter = createConnectedServices({ env: { ...homeEnv, HOME_ASSISTANT_URL: `http://127.0.0.1:${address.port}`, JARVIS_ALLOW_HOME_ASSISTANT_HTTP: "1" } });
    await assert.rejects(adapter.home({ action: "list_entities", limit: 1 }), /Redirects are not followed/);
    assert.equal(redirectedHits, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Home Assistant timeout and abort stop fetch/body consumption; uncertain writes cannot retry", async () => {
  await withDirectory(async (directory) => {
    let calls = 0;
    const fixtureFetch: typeof fetch = async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("private reason")), { once: true }));
    };
    const adapter = createConnectedServices({ env: homeEnv, directory, fetch: fixtureFetch, homeTimeoutMs: 15 });
    await assert.rejects(adapter.home(homeCall, { sessionId: "fixture" }), (error: ConnectedServiceError) => error.code === "timeout" && error.uncertain);
    await assert.rejects(adapter.home(homeCall, { sessionId: "different" }), /uncertain outcome/);
    assert.equal(calls, 1);
    const controller = new AbortController();
    const result = adapter.home({ action: "read_state", entityId: "light.fixture" }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(result, /cancelled/);
    let cancelled = false;
    const stalled = createConnectedServices({ env: homeEnv, homeTimeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }) });
    await assert.rejects(stalled.home({ action: "list_entities", limit: 1 }), /timed out/);
    assert.equal(cancelled, true);
  });
});
