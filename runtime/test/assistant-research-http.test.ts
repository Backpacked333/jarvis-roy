import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createAssistantRuntime } from "../bridge/assistant-runtime.ts";
import { reviewDigest, type VoiceProposal } from "../bridge/assistant/index.ts";
import { createHarnessRuntime } from "../bridge/harness-runtime.ts";
import { KnowledgeService } from "../bridge/knowledge/index.ts";
import { ResearchService, ResearchRunSchema } from "../bridge/research/index.ts";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import { FakeEveClient, FakeDelivery, approvalEvents, completedEvents } from "./helpers.ts";

const localToken = "research-http-fixture-local-token-over-32-characters";
const nativeToken = "research-http-fixture-native-token-over-32-characters";
type Role = "native" | "agent" | "local";

/** Real HTTP, SQLite and service composition; only external Gateway/Eve are deterministic transports. */
async function fixture(t: TestContext) {
  const environment: Record<string, string | undefined> = {
    JARVIS_LOCAL_TOKEN: localToken, JARVIS_NATIVE_TOKEN: nativeToken,
    JARVIS_ENABLE_ASSISTANT: "1", JARVIS_ENABLE_VOICE_APPROVAL: "1",
    JARVIS_ENABLE_KNOWLEDGE: "1", JARVIS_ENABLE_RESEARCH: "1",
    ELEVENLABS_API_KEY: undefined, ELEVENLABS_VOICE_ID: undefined,
    JARVIS_WORKER_IMAGE: undefined, JARVIS_DOCKER_BINARY: "/nonexistent/research-http-docker",
  };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const directory = await mkdtemp(join(tmpdir(), "jarvis-research-http-"));
  const client = new FakeEveClient();
  client.session.initial = new FakeDelivery(approvalEvents(), { status: "awaiting-input", outcome: "awaiting-input" });
  client.session.responseDelivery = new FakeDelivery(completedEvents(), { status: "completed", outcome: "handled" });
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  const harness = await createHarnessRuntime(directory, "fixture/model");
  const assistant = await createAssistantRuntime(directory, service, harness);
  const gatewayCalls: { stage: "synthesis" | "critique"; prompt: any }[] = [];
  let blockNextModel = false, providerAborts = 0;
  const modelTransport = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith("/models")) return Response.json({ data: [{ id: "fixture/model", type: "language", pricing: { input: "0.000001", output: "0.000002" } }] });
    assert.equal(address, "https://ai-gateway.vercel.sh/v1/chat/completions", "No unexpected provider endpoint");
    const body = JSON.parse(String(init?.body));
    const prompt = JSON.parse(body.messages[1].content);
    const stage = /Independently critique/.test(body.messages[0].content) ? "critique" : "synthesis";
    gatewayCalls.push({ stage, prompt });
    assert.ok(init?.signal, "Provider requests must be abortable");
    if (blockNextModel) {
      blockNextModel = false;
      await new Promise<never>((_resolve, reject) => {
        const abort = () => { providerAborts++; reject(new Error("Synthetic provider observed cancellation")); };
        if (init.signal!.aborted) abort(); else init.signal!.addEventListener("abort", abort, { once: true });
      });
    }
    init.signal!.throwIfAborted();
    const passage = prompt.evidence[0];
    const output = stage === "synthesis" ? {
      title: "Measured result", markdown: "The selected source reports a value of 42. Independent replication remains unresolved.",
      claims: [{ text: "The source reports a value of 42.", status: "supported", citations: [{ passageId: passage.passageId, quote: "The observed value is 42." }] }],
      unresolved: ["Independent replication has not been verified."], checks: [],
    } : {
      verdict: "supported_with_limits", summary: "The exact quotation supports the bounded measurement statement; replication is unresolved.", issues: [],
    };
    return Response.json({ model: "fixture/model", usage: { prompt_tokens: 400, completion_tokens: 100 }, choices: [{ finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(output) } }] });
  }) as typeof fetch;
  const knowledge = await KnowledgeService.open({ dataDirectory: directory, enabled: true,
    fetch: (async () => { throw new Error("This selected-document fixture permits no external retrieval"); }) as typeof fetch });
  const research = await ResearchService.open({ dataDirectory: directory, knowledge, model: "fixture/model", enabled: true,
    fetch: modelTransport, apiKey: "synthetic-research-http-key" });
  const server = createBridgeServer(service, "127.0.0.1", 0, harness, { stopTimeoutMs: 3000, extensions: {
    assistant: assistant.coordinator, knowledge, research,
    async close() { await research.close(); await assistant.close(); knowledge.close(); },
  } });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    try { await shutdownBridge(server); }
    finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  const headers = (role: Role) => ({ authorization: `Bearer ${localToken}`, "content-type": "application/json",
    ...(role === "native" ? { "x-jarvis-native-token": nativeToken } : {}),
    ...(role === "agent" ? { "x-jarvis-eve-session": client.session.id } : {}) });
  async function request(path: string, method = "GET", body?: unknown, status = 200, role: Role = "native") {
    const response = await fetch(base + path, { method, headers: headers(role), signal: AbortSignal.timeout(6000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text);
  }
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 6000;
    for (;;) {
      const value = await read(); if (accept(value)) return value;
      assert.ok(Date.now() < deadline, "HTTP state did not reach its expected condition"); await delay(10);
    }
  }
  const conversation = await request("/v1/conversations", "POST", { title: "Evidence workspace" }, 201);
  const session = await request("/v1/assistant/sessions", "POST", { title: "Evidence workspace", focus: {
    kind: "conversation", conversationId: conversation.id, roomId: null,
  } }, 201);
  const turn = await request(`/v1/assistant/sessions/${session.id}/turns`, "POST", {
    expectedRevision: session.revision, text: "Investigate the selected measurement", intent: "continue",
  }, 202);
  await until(() => request("/v1/state"), state => state.tasks.some((task: any) => task.id === turn.taskId && task.status === "waiting" && task.approvals.length));
  const projectId = conversation.id;
  async function importEvidence(cloudAllowed = true) {
    const grant = await request("/v1/grants", "POST", { projectId, resourceKind: "file", resourceId: randomUUID(), label: "Selected measurement",
      operations: ["read_document"], cloudAllowed, expiresAt: null }, 201);
    const imported = await request("/v1/knowledge/import", "POST", { projectId, grantId: grant.id, resourceId: grant.resourceId,
      filename: "measurement.txt", title: "Measured values", mediaType: "text/plain",
      bytesBase64: Buffer.from("The observed value is 42. Independent replication has not been performed.").toString("base64") }, 201);
    return { grant, imported };
  }
  const researchInput = (sourceId: string) => ({ requestId: randomUUID(), projectId, goal: "Summarize the selected measurement and its limitations.",
    providers: [], sourceVersionIds: [sourceId], budget: { estimatedUsd: 5, maxWallTimeMs: 30_000, maxConcurrentWorkers: 2, maxModelCalls: 2, maxTokens: 100_000 } });
  const readRun = async (id: string, role: Role = "native") => ResearchRunSchema.parse(await request(`/v1/research/runs/${id}?projectId=${projectId}`, "GET", undefined, 200, role));
  async function pendingModel(id: string) { return until(() => readRun(id), run => run.status === "synthesizing" && run.reservedTokens > 0); }
  async function proposal() {
    const state = await request("/v1/state"); const task = state.tasks.find((item: any) => item.id === turn.taskId), card = task.approvals[0];
    return await request(`/v1/assistant/sessions/${session.id}/proposals`, "POST", { turnId: turn.id,
      action: { taskId: turn.taskId, interactionId: card.id, revision: card.revision, optionId: "approve" } }, 201) as VoiceProposal;
  }
  const nativeEvent = (value: VoiceProposal, fields: Record<string, unknown>) => ({ appActive: true, sessionUnlocked: true, event: {
    proposalId: value.id, proposalRevision: value.revision, digest: value.digest, nativeSessionId: "research-http-native-session",
    eventId: randomUUID(), timestamp: new Date().toISOString(), ...fields,
  } });
  async function ready(value: VoiceProposal) {
    value = await request("/v1/assistant/native-events", "POST", nativeEvent(value, { type: "review_displayed", reviewDigest: reviewDigest(value.action) }));
    value = await request("/v1/assistant/native-events", "POST", nativeEvent(value, { type: "readback_started", reviewDigest: reviewDigest(value.action), readbackId: "research-readback" }));
    assert.equal(value.challenge, null);
    return await request("/v1/assistant/native-events", "POST", nativeEvent(value, { type: "readback_drained", readbackId: "research-readback" })) as VoiceProposal;
  }
  return { base, request, headers, until, projectId, turn, session, importEvidence, researchInput, readRun, pendingModel,
    proposal, ready, nativeEvent, gatewayCalls, client, get providerAborts() { return providerAborts; }, blockModel() { blockNextModel = true; } };
}

test("HTTP research imports scoped evidence, runs synthesis plus critique, and returns exact citations before native approval", async t => {
  const f = await fixture(t), { imported } = await f.importEvidence();
  const input = f.researchInput(imported.source.id);
  const run = await f.request("/v1/research/runs", "POST", input, 202, "agent");
  const finished = await f.until(() => f.readRun(run.id, "agent"), value => ["completed", "failed"].includes(value.status));
  assert.equal(finished.status, "completed"); assert.equal(finished.modelCalls, 2); assert.equal(finished.reservedTokens, 0);
  assert.deepEqual(f.gatewayCalls.map(call => call.stage), ["synthesis", "critique"]);
  assert.equal(f.gatewayCalls[1].prompt.draft.title, "Measured result", "The separate critique receives the actual draft");
  const result = await f.request(`/v1/research/runs/${run.id}/result?projectId=${f.projectId}`, "GET", undefined, 200, "agent");
  assert.equal(result.deliverable.citationCheck, "locators_and_quotes_verified");
  assert.equal(result.deliverable.claims[0].citations[0].passageId, imported.passages[0].id);
  assert.equal(result.deliverable.claims[0].citations[0].quote, "The observed value is 42.");
  assert.equal(result.critique.verdict, "supported_with_limits");
  assert.match(result.reviewAuthority, /not_independent_factual_verification/);
  const retrieved = await f.request(`/v1/knowledge/deliverables/${result.deliverable.id}?projectId=${f.projectId}&purpose=cloud`, "GET", undefined, 200, "agent");
  assert.deepEqual(retrieved, result.deliverable);
  const duplicate = await f.request("/v1/research/runs", "POST", input, 202);
  assert.equal(duplicate.id, run.id); assert.equal(f.gatewayCalls.length, 2);

  const proposed = await f.proposal();
  const forged = f.nativeEvent(proposed, { type: "review_displayed", reviewDigest: reviewDigest(proposed.action) });
  await f.request("/v1/assistant/native-events", "POST", forged, 403, "agent");
  const ready = await f.ready(proposed);
  const confirmation = f.nativeEvent(ready, { type: "utterance", readbackId: "research-readback", transcript: ready.challenge,
    captureStartedAt: new Date().toISOString() });
  const approved = await f.request("/v1/assistant/native-events", "POST", confirmation);
  assert.equal(approved.status, "completed"); assert.equal(f.client.session.responses.length, 1);
  assert.deepEqual(f.client.session.responses[0], [{ interactionId: proposed.action.interactionId, optionId: "approve" }]);
  await f.request("/v1/assistant/native-events", "POST", confirmation, 409);
  assert.equal(f.client.session.responses.length, 1, "Replayed confirmation never reaches the execution adapter");
});

test("HTTP research rejects missing identity, cross-project access and local-only evidence", async t => {
  const f = await fixture(t), { imported } = await f.importEvidence(false);
  const noBearer = await fetch(`${f.base}/v1/research/runs?projectId=${f.projectId}`, { headers: { "x-jarvis-native-token": nativeToken } });
  assert.equal(noBearer.status, 401); await noBearer.arrayBuffer();
  await f.request(`/v1/research/runs?projectId=${f.projectId}`, "GET", undefined, 403, "local");
  await f.request("/v1/research/runs?projectId=unrelated-project", "GET", undefined, 403, "agent");
  await f.request("/v1/research/runs", "POST", { ...f.researchInput(imported.source.id), projectId: "unrelated-project" }, 403, "agent");
  await f.request("/v1/research/runs", "POST", f.researchInput(imported.source.id), 403, "agent");
  await f.request("/v1/research/runs", "POST", f.researchInput(imported.source.id), 403, "native");
  assert.equal(f.gatewayCalls.length, 0, "Local-only evidence never reaches Gateway, including requests from the native client");
});

test("HTTP grant revocation aborts pending research and prevents publication", async t => {
  const f = await fixture(t), { grant, imported } = await f.importEvidence();
  f.blockModel();
  const run = await f.request("/v1/research/runs", "POST", f.researchInput(imported.source.id), 202);
  await f.pendingModel(run.id);
  await f.request(`/v1/grants/${grant.id}/revoke`, "POST", { expectedRevision: grant.revision });
  const stopped = await f.until(() => f.readRun(run.id), value => value.status === "failed");
  assert.equal(stopped.accounting, "unknown"); assert.equal(stopped.deliverableId, null);
  assert.equal(f.providerAborts, 1); assert.equal(f.gatewayCalls.length, 1);
  await f.request(`/v1/research/runs/${run.id}/result?projectId=${f.projectId}`, "GET", undefined, 409);
});

test("HTTP Stop all aborts research and invalidates an already reviewed voice proposal", async t => {
  const f = await fixture(t), { imported } = await f.importEvidence();
  const ready = await f.ready(await f.proposal());
  f.blockModel();
  const run = await f.request("/v1/research/runs", "POST", f.researchInput(imported.source.id), 202, "agent");
  await f.pendingModel(run.id);
  await f.request("/v1/stop", "POST", {});
  const stopped = await f.readRun(run.id);
  assert.ok(["cancelled", "failed"].includes(stopped.status));
  assert.equal(stopped.accounting, "unknown"); assert.equal(stopped.deliverableId, null);
  assert.equal(f.providerAborts, 1); assert.equal(f.gatewayCalls.length, 1);
  await f.request("/v1/assistant/native-events", "POST", f.nativeEvent(ready, { type: "utterance", readbackId: "research-readback",
    transcript: ready.challenge, captureStartedAt: new Date().toISOString() }), 409);
  assert.equal(f.client.session.responses.length, 0, "Stop all prevents the reviewed action from being submitted later");
  const state = await f.request("/v1/assistant/state");
  assert.equal(state.proposals.find((proposal: VoiceProposal) => proposal.id === ready.id).status, "invalidated");
});
