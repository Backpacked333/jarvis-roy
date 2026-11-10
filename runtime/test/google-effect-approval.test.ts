import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarvisService } from "../bridge/service.ts";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { googleEffectBinding } from "../bridge/google-effect-contracts.ts";
import { executeApprovedGoogleAction } from "../agent/lib/google-action.ts";
import { BridgeError } from "../bridge/errors.ts";
import { approvalEvents, event, FakeDelivery, FakeEveClient } from "./helpers.ts";

const input = { projectId: "project-a", objectiveId: null, requestId: "send-one", accountId: "account-a", kind: "gmail_send" as const,
  to: "self@example.com", subject: "Reviewed subject", text: "Exact reviewed text" };
const status = (expected: number) => (error: unknown) => error instanceof BridgeError && error.status === expected;
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const limit = Date.now() + 2_000; while (!await predicate()) { if (Date.now() > limit) throw new Error("Fixture observation timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-google-approval-")), client = new FakeEveClient();
  const events = approvalEvents(); (events[1].data.capability as { name: string }).name = "google_action"; events[1].data.input = input;
  client.session.initial = new FakeDelivery(events, { status: "awaiting-input", outcome: "awaiting-input" });
  const cancel = client.session.cancel.bind(client.session);
  client.session.cancel = async () => { client.session.responseDelivery.finish({ status: "cancelled" }); return cancel(); };
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  const task = await service.createTask("Send the reviewed message", undefined, input.projectId); await service.drain();
  t.after(async () => { client.session.responseDelivery.finish({ status: "cancelled" }); await service.stop().catch(() => {}); await service.drain(); await rm(directory, { recursive: true, force: true }); });
  const started = async () => { client.session.responseDelivery.emit(event("call.started", { callId: "call-1" }, 7));
    await waitUntil(() => service.taskSnapshot()[0].events.includes("google_action started.")); };
  const approve = async () => { await service.respond(task.id, "interaction-1", "approve", 1); await started(); };
  return { service, client, task, directory, started, approve };
}

test("Google execution requires the exact approval acknowledgement and observed call, then consumes once", async t => {
  const f = await fixture(t); let executed = 0;
  const execute = async () => { executed++; return { submitted: true }; };
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", input, execute), status(409));
  let release!: () => void; f.client.session.respondGate = new Promise(resolve => { release = resolve; });
  const responding = f.service.respond(f.task.id, "interaction-1", "approve", 1);
  await waitUntil(() => f.client.session.responses.length === 1);
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", input, execute), status(425));
  release(); await responding;
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", input, execute), status(425));
  await f.started();
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", { ...input, text: "Changed" }, execute), status(403));
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "other-call", input, execute), status(403));
  let complete!: () => void;
  const first = f.service.executeGoogleEffect(f.client.session.id, "call-1", input, async binding => {
    assert.equal(binding.digest, googleEffectBinding(input).digest); assert.equal(binding.approvalId, "interaction-1");
    executed++; await new Promise<void>(resolve => { complete = resolve; }); return { submitted: true };
  });
  await waitUntil(() => executed === 1);
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", input, execute), status(409));
  complete(); assert.deepEqual(await first, { submitted: true });
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", input, execute), status(409));
  assert.equal(executed, 1);
});

test("lost Google approval receipt quarantines the task and effect together across restart", async t => {
  const f = await fixture(t);
  f.client.session.respond = async () => { throw new Error("approval receipt lost"); };
  await assert.rejects(f.service.respond(f.task.id, "interaction-1", "approve", 1), /Do not retry/);
  const persisted = JSON.parse(await readFile(join(f.directory, "tasks.json"), "utf8"));
  assert.equal(persisted.tasks[0].googleEffects[0].status, "unknown");
  assert.equal(persisted.tasks[0].responseUnconfirmed, true);
  assert.equal(persisted.tasks[0].status, "interrupted");
  assert.deepEqual(persisted.tasks[0].approvals, []);
  await assert.rejects(f.service.respond(f.task.id, "interaction-1", "approve", 1), status(409));
  const restored = await JarvisService.create({ client: new FakeEveClient(), dataDirectory: f.directory, model: "fixture/model" });
  assert.equal(restored.taskSnapshot()[0].status, "interrupted");
  await assert.rejects(restored.executeGoogleEffect(f.client.session.id, "call-1", input, async () => { throw new Error("must not run"); }), status(409));
});

test("ambiguous Google submission remains unknown durably and cannot be replayed after restart", async t => {
  const f = await fixture(t); await f.approve();
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", input, async () => { throw new Error("connection lost"); }), /connection lost/);
  const persisted = JSON.parse(await readFile(join(f.directory, "tasks.json"), "utf8")); assert.equal(persisted.tasks[0].googleEffects[0].status, "unknown");
  await assert.rejects(f.service.executeGoogleEffect(f.client.session.id, "call-1", input, async () => { throw new Error("must not run"); }), status(409));
  f.client.session.responseDelivery.finish({ status: "failed" }); await f.service.drain();
  const restored = await JarvisService.create({ client: new FakeEveClient(), dataDirectory: f.directory, model: "fixture/model" });
  await assert.rejects(restored.executeGoogleEffect(f.client.session.id, "call-1", input, async () => { throw new Error("replayed"); }), status(409));
});

test("Stop aborts in-flight Google forwarding and never changes an uncertain provider effect into success", async t => {
  const f = await fixture(t); await f.approve(); let entered = false;
  const operation = f.service.executeGoogleEffect(f.client.session.id, "call-1", input, async (_binding, signal) => {
    entered = true; await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
  });
  const failure = assert.rejects(operation, /stopped/); await waitUntil(() => entered); await f.service.cancel(f.task.id); await failure;
  const persisted = JSON.parse(await readFile(join(f.directory, "tasks.json"), "utf8")); assert.equal(persisted.tasks[0].googleEffects[0].status, "unknown");
});

test("Google bridge releases admission while gateway reserves cost, and authenticated cloud Stop uses all fences", async t => {
  const f = await fixture(t); await f.approve();
  const saved = { ...process.env }, nativeFetch = globalThis.fetch;
  process.env.JARVIS_LOCAL_TOKEN = "google-test-local-token-with-32-characters";
  process.env.JARVIS_CLOUD_RUNTIME_TOKEN = "google-test-runtime-token-with-32-characters";
  process.env.JARVIS_RUNTIME_PROFILE = "cloud"; process.env.JARVIS_ENABLE_GOOGLE = "1";
  let reservations = 0, brokerStops = 0;
  const server = createBridgeServer(f.service, "127.0.0.1", 0, undefined, { extensions: { cloudBroker: async raw => {
    const input = raw as { operation: string }; if (input.operation === "reserve") { reservations++; return { id: "reservation-one" }; }
    if (input.operation === "stop") brokerStops++; return {};
  } } }); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { globalThis.fetch = nativeFetch; f.client.session.responseDelivery.finish({ status: "cancelled" }); await shutdownBridge(server);
    for (const key of ["JARVIS_LOCAL_TOKEN", "JARVIS_CLOUD_RUNTIME_TOKEN", "JARVIS_RUNTIME_PROFILE", "JARVIS_ENABLE_GOOGLE"]) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const headers = { authorization: `Bearer ${process.env.JARVIS_LOCAL_TOKEN}`, "content-type": "application/json", "x-jarvis-cloud-runtime-token": process.env.JARVIS_CLOUD_RUNTIME_TOKEN! };
  globalThis.fetch = (async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1:39300/")) {
      const request = JSON.parse(String(init!.body)); assert.equal(request.digest, googleEffectBinding(input).digest);
      assert.equal(new Headers(init!.headers).has("x-jarvis-native-token"), false);
      const reserved = await nativeFetch(base + "/v1/cloud/runtime", { method: "POST", headers, body: JSON.stringify({ version: 1, operation: "reserve", payload: { estimatedUsd: 1 } }), signal: AbortSignal.timeout(2_000) });
      assert.equal(reserved.status, 200); return Response.json({ submitted: true });
    }
    return nativeFetch(url, init);
  }) as typeof fetch;
  const executed = await nativeFetch(base + "/v1/integrations/google/execute", { method: "POST", headers: { ...headers, "x-jarvis-eve-session": f.client.session.id },
    body: JSON.stringify({ callId: "call-1", input }), signal: AbortSignal.timeout(3_000) });
  assert.equal(executed.status, 200); assert.equal(reservations, 1);
  const stopped = await nativeFetch(base + "/v1/cloud/runtime", { method: "POST", headers,
    body: JSON.stringify({ version: 1, operation: "stop", payload: {} }), signal: AbortSignal.timeout(3_000) });
  assert.equal(stopped.status, 200); assert.equal(brokerStops, 0); assert.ok(f.client.session.cancelCalls > 0);
});

test("Google tool callback retries only the 425 observation race and carries no native or gateway credential", async t => {
  const previous = { local: process.env.JARVIS_LOCAL_TOKEN, enabled: process.env.JARVIS_ENABLE_GOOGLE };
  process.env.JARVIS_LOCAL_TOKEN = "google-tool-local-token-with-32-characters"; process.env.JARVIS_ENABLE_GOOGLE = "1";
  t.after(() => { for (const [key, value] of [["JARVIS_LOCAL_TOKEN", previous.local], ["JARVIS_ENABLE_GOOGLE", previous.enabled]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } });
  let calls = 0;
  const fetcher = (async (_url, init) => { calls++; const headers = new Headers(init!.headers);
    assert.equal(headers.has("x-jarvis-native-token"), false); assert.equal(headers.has("x-jarvis-cloud-runtime-token"), false);
    return calls === 1 ? new Response("", { status: 425 }) : Response.json({ submitted: true }); }) as typeof fetch;
  const context = { sessionId: "session-a", callId: "call-a", approved: true, delegated: false, signal: new AbortController().signal };
  assert.deepEqual(await executeApprovedGoogleAction(input, context, fetcher), { submitted: true }); assert.equal(calls, 2);
  await assert.rejects(executeApprovedGoogleAction(input, { ...context, approved: false }, fetcher), /explicit Eve approval/);
  let deniedCalls = 0; await assert.rejects(executeApprovedGoogleAction(input, context, (async () => { deniedCalls++; return new Response("", { status: 409 }); }) as typeof fetch), /uncertain/); assert.equal(deniedCalls, 1);
});
