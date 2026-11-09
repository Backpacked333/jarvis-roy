import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createAssistantRuntime } from "../bridge/assistant-runtime.ts";
import { AssistantEventSchema, AssistantStateSchema, reviewDigest, type VoiceProposal } from "../bridge/assistant/index.ts";
import { createHarnessRuntime } from "../bridge/harness-runtime.ts";
import { KnowledgeService, type KnowledgeOptions } from "../bridge/knowledge/index.ts";
import { BridgeError } from "../bridge/errors.ts";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import type { EveClient } from "../bridge/types.ts";
import { FakeDelivery, FakeSession, approvalEvents, completedEvents, event } from "./helpers.ts";

const token = "assistant-integration-local-token-at-least-32-characters";
const nativeToken = "assistant-integration-native-token-at-least-32-characters";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class ConversationSession extends FakeSession {
  readonly sent: string[] = [];
  followup = new FakeDelivery();
  cancelGate: Promise<void> | undefined;
  readonly cancelStarted = deferred();
  async send(message: string) {
    this.sent.push(message);
    this.followup.emit(event("turn.started", { turnId: "turn-2" }, 30));
    return this.followup;
  }
  override async cancel() {
    this.cancelStarted.resolve();
    await this.cancelGate;
    return super.cancel();
  }
}

async function fixture(t: TestContext, approval = false, extractPdf?: KnowledgeOptions["extractPdf"]) {
  const environment: Record<string, string | undefined> = {
    JARVIS_LOCAL_TOKEN: token, JARVIS_NATIVE_TOKEN: nativeToken,
    JARVIS_ENABLE_ASSISTANT: "1", JARVIS_ENABLE_VOICE_APPROVAL: "1",
    OPENROUTER_API_KEY: undefined, ELEVENLABS_API_KEY: undefined, ELEVENLABS_VOICE_ID: undefined,
    JARVIS_WORKER_IMAGE: undefined, JARVIS_DOCKER_BINARY: "/nonexistent/assistant-test-docker",
  };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const directory = await mkdtemp(join(tmpdir(), "jarvis-assistant-http-"));
  const session = new ConversationSession();
  session.initial = approval
    ? new FakeDelivery(approvalEvents(), { status: "awaiting-input", outcome: "awaiting-input" })
    : new FakeDelivery([event("turn.started", { turnId: "turn-1" }, 1)]);
  session.responseDelivery = new FakeDelivery(completedEvents(), { status: "completed", outcome: "handled" });
  const created: string[] = [], attached: string[] = [];
  const client: EveClient = {
    async health() { return { ok: true, status: "ready" }; },
    sessions: {
      async create(input) { created.push(input.message); return { session, delivery: session.initial }; },
      attach(id) { assert.equal(id, session.id); attached.push(id); return session; },
    },
  };
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  const harness = await createHarnessRuntime(directory, "fixture/model");
  const assistant = await createAssistantRuntime(directory, service, harness);
  const knowledge = await KnowledgeService.open({ dataDirectory: directory, enabled: true, extractPdf,
    fetch: (async () => { throw new Error("Unexpected external network request"); }) as typeof fetch });
  const server = createBridgeServer(service, "127.0.0.1", 0, harness, { stopTimeoutMs: 2_000, extensions: {
    assistant: assistant.coordinator, knowledge,
    async close() { await assistant.close(); knowledge.close(); },
  } });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    session.cancelGate = undefined;
    try {
      await shutdownBridge(server);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  function headers(role: "native" | "agent" | "local" = "native") {
    return { authorization: `Bearer ${token}`, "content-type": "application/json",
      ...(role === "native" ? { "x-jarvis-native-token": nativeToken } : {}),
      ...(role === "agent" ? { "x-jarvis-eve-session": session.id } : {}) };
  }
  async function request(path: string, method = "GET", body?: unknown, expected = 200, role: "native" | "agent" | "local" = "native") {
    const response = await fetch(base + path, { method, headers: headers(role),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${raw}`);
    return JSON.parse(raw);
  }
  async function waitFor(predicate: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 4_000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, `Integrated state deadline: ${JSON.stringify(service.taskSnapshot())}`); await delay(10); }
  }
  const state = async () => AssistantStateSchema.parse(await request("/v1/assistant/state"));
  async function start() {
    const conversation = await service.createConversation("Research project");
    const assistantSession = await request("/v1/assistant/sessions", "POST", { title: "Research", focus: {
      kind: "conversation", conversationId: conversation.id, roomId: null,
    } }, 201);
    const turn = await request(`/v1/assistant/sessions/${assistantSession.id}/turns`, "POST", {
      expectedRevision: assistantSession.revision, text: "Investigate the evidence", intent: "continue",
    }, 202);
    await waitFor(() => Boolean(service.contextForEveSession(session.id)) &&
      service.taskSnapshot().some(task => task.id === turn.taskId && task.status === (approval ? "waiting" : "running")));
    if (approval) await service.waitForObservedDelivery(turn.taskId);
    return { conversation, assistantSession, turn };
  }
  async function propose() {
    const started = await start();
    const task = service.taskSnapshot().find(task => task.id === started.turn.taskId)!;
    assert.equal(task.approvals[0].reviewable, true);
    const proposal = await request(`/v1/assistant/sessions/${started.assistantSession.id}/proposals`, "POST", {
      turnId: started.turn.id, action: { taskId: task.id, interactionId: task.approvals[0].id,
        revision: task.approvals[0].revision, optionId: "approve" },
    }, 201) as VoiceProposal;
    return { ...started, proposal };
  }
  function nativeEvent(proposal: VoiceProposal, fields: Record<string, unknown>) {
    return { appActive: true, sessionUnlocked: true, event: {
      eventId: randomUUID(), proposalId: proposal.id, proposalRevision: proposal.revision,
      digest: proposal.digest, timestamp: new Date().toISOString(), nativeSessionId: "native-test-session", ...fields,
    } };
  }
  async function ready(proposal: VoiceProposal) {
    proposal = await request("/v1/assistant/native-events", "POST", nativeEvent(proposal, {
      type: "review_displayed", reviewDigest: reviewDigest(proposal.action),
    }));
    proposal = await request("/v1/assistant/native-events", "POST", nativeEvent(proposal, {
      type: "readback_started", readbackId: "readback-1", reviewDigest: reviewDigest(proposal.action),
    }));
    assert.equal(proposal.challenge, null, "The challenge is withheld until playback drains");
    return await request("/v1/assistant/native-events", "POST", nativeEvent(proposal, {
      type: "readback_drained", readbackId: "readback-1",
    })) as VoiceProposal;
  }
  return { base, headers, request, state, waitFor, start, propose, ready, nativeEvent,
    service, session, created, attached, assistant: assistant.coordinator };
}

test("HTTP assistant and knowledge require native authority or the exact scoped Eve callback", async t => {
  const f = await fixture(t);
  await f.request("/v1/assistant/state", "GET", undefined, 403, "local");
  await f.request("/v1/assistant/state", "GET", undefined, 403, "agent");
  assert.deepEqual((await f.state()).sessions, []);
  await f.request("/v1/assistant/tool-context", "GET", undefined, 403, "local");
  await f.request("/v1/assistant/tool-context", "GET", undefined, 403, "agent");
  await f.request("/v1/context/resources", "POST", { projectId: "project", kind: "calendar" }, 403, "local");
  const { conversation, turn } = await f.start();
  const context = await f.request("/v1/assistant/tool-context", "GET", undefined, 200, "agent");
  assert.equal(context.taskId, turn.taskId); assert.equal(context.projectId, conversation.id);
  const grantBody = { projectId: conversation.id, resourceKind: "file", resourceId: "document-private",
    label: "Private notes", operations: ["read_document"], cloudAllowed: false, expiresAt: null };
  await f.request("/v1/grants", "POST", grantBody, 403, "agent");
  const grant = await f.request("/v1/grants", "POST", grantBody, 201);
  const imported = await f.request("/v1/knowledge/import", "POST", {
    projectId: conversation.id, grantId: grant.id, resourceId: grant.resourceId,
    filename: "notes.md", title: "Private notes", mediaType: "text/markdown",
    bytesBase64: Buffer.from("Evidence from a selected local source.").toString("base64"),
  }, 201);
  assert.equal(imported.passages[0].text, "Evidence from a selected local source.");
  const path = `/v1/knowledge/sources/${imported.source.id}?projectId=${conversation.id}`;
  assert.equal((await f.request(path + "&purpose=local")).source.id, imported.source.id);
  await f.request(path + "&purpose=cloud", "GET", undefined, 403, "agent");
  await f.request(path + "&purpose=local", "GET", undefined, 403, "agent");
  await f.request(`/v1/knowledge/sources/${imported.source.id}?projectId=other-project&purpose=cloud`, "GET", undefined, 403, "agent");
  assert.deepEqual((await f.request("/v1/assistant/tool-context", "GET", undefined, 200, "agent")).grants, []);
  await f.request(`/v1/grants/${grant.id}/revoke`, "POST", { expectedRevision: grant.revision });
  await f.request(path + "&purpose=local", "GET", undefined, 403);
});

test("assistant turns project committed reply updates and reuse the same Eve conversation", async t => {
  const f = await fixture(t);
  const { assistantSession, turn, conversation } = await f.start();
  f.session.initial.emit(event("content.completed", { partId: "reply-1", kind: "text", phase: "reply", value: "First result" }, 2));
  await f.waitFor(() => f.assistant.state().presentations.some(card => card.content.kind === "text" && card.content.markdown === "First result"));
  const first = f.assistant.state().presentations[0];
  assert.equal(first.turnId, turn.id);
  f.session.initial.emit(event("content.completed", { partId: "reply-1", kind: "text", phase: "reply", value: "Final evidence" }, 3));
  f.session.initial.emit(event("turn.settled", { turnId: "turn-1", outcome: "completed" }, 4));
  f.session.initial.finish({ status: "completed", outcome: "handled" });
  await f.service.waitForObservedDelivery(turn.taskId);
  await f.waitFor(() => f.assistant.state().turns[0].status === "completed");
  const final = f.assistant.state().presentations.find(card => card.id === first.id)!;
  assert.ok(final.revision > first.revision); assert.deepEqual(final.content, { kind: "text", markdown: "Final evidence" });
  const next = await f.request(`/v1/assistant/sessions/${assistantSession.id}/turns`, "POST", {
    expectedRevision: assistantSession.revision, text: "Explain the conclusion", intent: "continue",
  }, 202);
  await f.waitFor(() => f.session.sent.length === 1);
  assert.equal(f.created.length, 1); assert.deepEqual(f.attached, [f.session.id]);
  assert.equal(next.conversationId, conversation.id);
  const context = await f.request("/v1/assistant/tool-context", "GET", undefined, 200, "agent");
  assert.equal(context.taskId, next.taskId); assert.equal(context.projectId, conversation.id);
  f.session.followup.emit(event("turn.settled", { turnId: "turn-2", outcome: "completed" }, 31));
  f.session.followup.finish({ status: "completed", outcome: "handled" });
  await f.service.waitForObservedDelivery(next.taskId);
});

test("document cards resolve actual passages and recheck grants before captured cloud disclosure", async t => {
  const f = await fixture(t);
  const { assistantSession, turn, conversation } = await f.start();
  const grant = await f.request("/v1/grants", "POST", { projectId: conversation.id, resourceKind: "file",
    resourceId: "selected-document", label: "Selected document", operations: ["read_document"], cloudAllowed: true, expiresAt: null }, 201);
  const imported = await f.request("/v1/knowledge/import", "POST", { projectId: conversation.id, grantId: grant.id,
    resourceId: grant.resourceId, filename: "result.md", title: "Result", mediaType: "text/markdown",
    bytesBase64: Buffer.from("Private measurement: the observed value is 42.").toString("base64") }, 201);
  const card = await f.request("/v1/assistant/present", "POST", { title: "Actual evidence", content: {
    kind: "document", sourceVersionId: imported.source.id, passages: [{ id: imported.passages[0].id,
      text: "fabricated replacement", locator: { page: 99, lineStart: 99, lineEnd: 100 } }],
  } }, 201, "agent");
  assert.deepEqual(card.content.passages, [{ id: imported.passages[0].id,
    text: imported.passages[0].text, locator: imported.passages[0].locator }]);
  await f.request("/v1/assistant/present", "POST", { title: "Wrong passage", content: {
    kind: "document", sourceVersionId: imported.source.id, passages: [{ id: "unrelated-passage",
      text: "fake", locator: { page: null, lineStart: 1, lineEnd: 1 } }],
  } }, 409, "agent");
  const diff = await f.request("/v1/assistant/present", "POST", { title: "Proposed edit", content: {
    kind: "code_diff", language: "python", diff: "-wrong\n+proposed", verification: "passed",
  } }, 201, "agent");
  assert.equal(diff.content.verification, "unverified");
  f.session.initial.emit(event("turn.settled", { turnId: "turn-1", outcome: "completed" }, 4));
  f.session.initial.finish({ status: "completed", outcome: "handled" });
  await f.service.waitForObservedDelivery(turn.taskId);
  const next = await f.request(`/v1/assistant/sessions/${assistantSession.id}/turns`, "POST", {
    expectedRevision: assistantSession.revision, text: "Explain this passage", intent: "continue",
    presentationRef: { presentationId: card.id, revision: card.revision },
  }, 202);
  await f.waitFor(() => f.session.sent.length === 1);
  assert.ok(!f.session.sent[0].includes("Private measurement"), "Dispatch sends a reference, not cached private content");
  const context = await f.request("/v1/assistant/tool-context", "GET", undefined, 200, "agent");
  assert.equal(context.capturedPresentation.content.passages[0].text, imported.passages[0].text);
  await f.request(`/v1/grants/${grant.id}/revoke`, "POST", { expectedRevision: grant.revision });
  await f.request("/v1/assistant/tool-context", "GET", undefined, 403, "agent");
  f.session.followup.emit(event("turn.settled", { turnId: "turn-2", outcome: "completed" }, 31));
  f.session.followup.finish({ status: "completed", outcome: "handled" });
  await f.service.waitForObservedDelivery(next.taskId);
});

test("manual focus changes cannot carry a captured card into another project", async t => {
  const f = await fixture(t);
  const { assistantSession, turn } = await f.start();
  const card = await f.request("/v1/assistant/present", "POST", { title: "Project notes",
    content: { kind: "text", markdown: "Private first-project result" } }, 201, "agent");
  f.session.initial.emit(event("turn.settled", { turnId: "turn-1", outcome: "completed" }, 4));
  f.session.initial.finish({ status: "completed", outcome: "handled" });
  await f.service.waitForObservedDelivery(turn.taskId);
  const other = await f.service.createConversation("Separate project");
  const focused = await f.request(`/v1/assistant/sessions/${assistantSession.id}/focus`, "POST", {
    expectedRevision: assistantSession.revision, focus: { kind: "conversation", conversationId: other.id, roomId: null },
  });
  const rejected = await f.request(`/v1/assistant/sessions/${assistantSession.id}/turns`, "POST", {
    expectedRevision: focused.revision, text: "Discuss that", intent: "continue",
    presentationRef: { presentationId: card.id, revision: card.revision },
  }, 202);
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.taskId, null);
  assert.equal(f.created.length, 1, "No cloud dispatch occurs with cross-project cached content");
});

test("HTTP SSE replays escaped frames, streams new cards, and preserves held visual references", async t => {
  const f = await fixture(t);
  const { assistantSession, turn } = await f.start();
  const card = await f.request("/v1/assistant/present", "POST", { title: "Evidence",
    content: { kind: "text", markdown: "hello\n\nevent: fake\ndata: injected" } }, 201, "agent");
  const replay = await f.request("/v1/assistant/events?after=0");
  const abort = new AbortController();
  const response = await fetch(f.base + "/v1/assistant/events?after=0", {
    headers: { ...f.headers(), accept: "text/event-stream" }, signal: abort.signal,
  });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder(); let text = "";
  async function readFrames(count: number) {
    while (text.split("\n\n").length - 1 < count) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value, { stream: true });
    }
    return text.split("\n\n").filter(Boolean).map(frame => {
      assert.equal(frame.split("\ndata:").length, 2, "Untrusted markdown cannot inject SSE fields");
      assert.equal(frame.includes("\nevent: fake"), false);
      const [id, data] = frame.split("\n"); const parsed = JSON.parse(data.slice(6));
      assert.equal(Number(id.slice(4)), parsed.sequence); return parsed;
    });
  }
  try {
    const frames = await readFrames(replay.events.length);
    assert.deepEqual(frames.slice(0, replay.events.length), replay.events);
    const revised = await f.assistant.present({ id: card.id, expectedRevision: card.revision,
      sessionId: assistantSession.id, turnId: turn.id, title: "Revised evidence", content: { kind: "text", markdown: "New version" } });
    const streamed = await readFrames(replay.events.length + 1);
    assert.equal(streamed.at(-1).data.revision, revised.revision);
    await f.request(`/v1/assistant/sessions/${assistantSession.id}/turns`, "POST", {
      expectedRevision: assistantSession.revision, text: "Use this", intent: "side_question",
      presentationRef: { presentationId: card.id, revision: card.revision },
    }, 202);
    assert.equal(f.created.length, 2, "A held revision remains explicitly bound during follow-up");
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});

test("idle SSE connects immediately and reconnect replays each missed event exactly once", async t => {
  const f = await fixture(t);
  const { turn } = await f.start();
  const before = await f.request("/v1/assistant/events?after=0");
  async function stream(after: number) {
    const abort = new AbortController();
    // A caught-up client must receive headers without waiting for a model event
    // or the 15-second heartbeat. The timeout also bounds every stream read.
    const response = await fetch(`${f.base}/v1/assistant/events?after=${after}`, {
      headers: { ...f.headers(), accept: "text/event-stream" },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let pending = "";
    async function next() {
      while (true) {
        const separator = pending.indexOf("\n\n");
        if (separator >= 0) {
          const frame = pending.slice(0, separator); pending = pending.slice(separator + 2);
          if (frame.startsWith(":")) continue;
          const lines = frame.split("\n"), data = lines.find(line => line.startsWith("data: "));
          assert.ok(data);
          const parsed = AssistantEventSchema.parse(JSON.parse(data.slice(6)));
          assert.equal(lines.find(line => line.startsWith("id: ")), `id: ${parsed.sequence}`);
          return parsed;
        }
        const chunk = await reader.read(); assert.equal(chunk.done, false);
        pending += decoder.decode(chunk.value, { stream: true });
      }
    }
    return { next, async close() { abort.abort(); await reader.cancel().catch(() => {}); } };
  }
  const first = await stream(before.sequence);
  let cursor: number;
  try {
    f.session.initial.emit(event("content.completed", { partId: "reply-1", kind: "text", phase: "reply", value: "First streamed result" }, 2));
    const received = await first.next();
    assert.equal(received.type, "presentation.updated");
    assert.equal(received.sequence, before.sequence + 1);
    cursor = received.sequence;
  } finally { await first.close(); }
  f.session.initial.emit(event("content.completed", { partId: "reply-1", kind: "text", phase: "reply", value: "Completed while disconnected" }, 3));
  f.session.initial.finish({ status: "completed", reply: "Completed while disconnected" });
  await f.service.waitForObservedDelivery(turn.taskId);
  await f.waitFor(() => f.assistant.state().turns[0].status === "completed");
  const missed = await f.request(`/v1/assistant/events?after=${cursor}`);
  assert.ok(missed.events.length >= 2);
  const reconnected = await stream(cursor);
  try {
    const replayed = [];
    for (let i = 0; i < missed.events.length; i++) replayed.push(await reconnected.next());
    assert.deepEqual(replayed, missed.events);
    assert.equal(new Set(replayed.map(item => item.sequence)).size, replayed.length);
    await f.request("/v1/assistant/present", "POST", { title: "After reconnect", content: { kind: "text", markdown: "New live result" } }, 201, "agent");
    const live = await reconnected.next();
    assert.equal(live.sequence, missed.sequence + 1);
    assert.equal(live.type, "presentation.updated");
    await f.request(`/v1/assistant/events?after=${live.sequence + 1}`, "GET", undefined, 409);
  } finally { await reconnected.close(); }
});

test("native voice protocol executes exactly one existing Eve approval response", async t => {
  const f = await fixture(t, true);
  const { proposal } = await f.propose();
  const forged = f.nativeEvent(proposal, { type: "review_displayed", reviewDigest: reviewDigest(proposal.action) });
  await f.request("/v1/assistant/native-events", "POST", forged, 403, "agent");
  assert.equal(f.session.responses.length, 0);
  const ready = await f.ready(proposal);
  assert.equal(ready.status, "awaiting_confirmation"); assert.match(ready.challenge!, /^confirm [a-z]+ \d{4}$/);
  const confirmation = f.nativeEvent(ready, { type: "utterance", readbackId: "readback-1",
    transcript: ready.challenge, captureStartedAt: new Date().toISOString() });
  const completed = await f.request("/v1/assistant/native-events", "POST", confirmation);
  assert.equal(completed.status, "completed");
  assert.deepEqual(f.session.responses, [[{ interactionId: "interaction-1", optionId: "approve" }]]);
  await f.request("/v1/assistant/native-events", "POST", confirmation, 409);
  assert.equal(f.session.responses.length, 1);
  await f.waitFor(() => f.service.taskSnapshot()[0].status === "completed");
});

test("Stop all invalidates pending native confirmations before cancellation finishes", async t => {
  const f = await fixture(t, true);
  const { proposal } = await f.propose();
  const ready = await f.ready(proposal);
  const gate = deferred(); f.session.cancelGate = gate.promise;
  const stop = f.request("/v1/stop", "POST", {});
  void stop.catch(() => {});
  await f.session.cancelStarted.promise;
  const confirmation = f.nativeEvent(ready, { type: "utterance", readbackId: "readback-1",
    transcript: ready.challenge, captureStartedAt: new Date().toISOString() });
  try {
    await f.request("/v1/assistant/native-events", "POST", confirmation, 409);
    assert.equal((await f.state()).proposals.find(item => item.id === proposal.id)!.status, "invalidated");
    await f.request("/v1/assistant/sessions", "POST", { title: "Late", focus: { kind: "none" } }, 409);
    assert.equal(f.session.responses.length, 0);
  } finally { gate.resolve(); await stop; }
  await f.request("/v1/assistant/native-events", "POST", confirmation, 409);
  assert.equal(f.session.responses.length, 0);
  assert.equal(f.service.taskSnapshot()[0].status, "cancelled");
});

test("native revoke and Stop interrupt an in-flight granted import before it can publish", async t => {
  for (const control of ["revoke", "stop"] as const) await t.test(control, async t => {
    const entered = deferred(), release = deferred(); let aborted = false;
    const f = await fixture(t, false, async (_bytes, signal) => {
      entered.resolve();
      return new Promise((resolve, reject) => {
        const abort = () => { aborted = true; reject(new BridgeError("Document extraction cancelled.", 409)); };
        signal!.addEventListener("abort", abort, { once: true });
        void release.promise.then(() => { signal!.removeEventListener("abort", abort); resolve([{ text: "Held private content", page: 1 }]); });
      });
    });
    const grant = await f.request("/v1/grants", "POST", { projectId: "import-project", resourceKind: "file",
      resourceId: "selected-pdf", label: "Selected document", operations: ["read_document"], cloudAllowed: true, expiresAt: null }, 201);
    const importing = fetch(f.base + "/v1/knowledge/import", { method: "POST", headers: f.headers(), body: JSON.stringify({
      projectId: grant.projectId, grantId: grant.id, resourceId: grant.resourceId, filename: "paper.pdf", title: "Paper",
      mediaType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.7\ncontrolled extractor fixture").toString("base64"),
    }) });
    await entered.promise;
    const controlling = control === "revoke"
      ? f.request(`/v1/grants/${grant.id}/revoke`, "POST", { expectedRevision: grant.revision })
      : f.request("/v1/stop", "POST", {});
    void controlling.catch(() => {});
    try {
      const completedBeforeRelease = await Promise.race([controlling.then(() => true), delay(1_000).then(() => false)]);
      assert.equal(completedBeforeRelease, true, `${control} must preempt the blocked read`);
      assert.equal(aborted, true);
      const response = await importing;
      assert.equal(response.status, 409, await response.text());
      assert.deepEqual((await f.request("/v1/knowledge/sources?projectId=import-project&purpose=local")).sources, []);
    } finally { release.resolve(); await controlling; await importing; }
  });
});
