import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { z } from "zod";
import { generateText, streamText } from "ai";
import type { DynamicModelContext } from "eve";
import { budgetCloudModel, bridgeModelBudgetTransport, ModelBudgetDenied, type BudgetedLanguageModel, type ModelBudgetTransport } from "../agent/lib/cloud-budget.ts";
import { selectModel } from "../agent/lib/model.ts";
import { ModelBudgetRuntime, ModelBudgetStore } from "../bridge/model-budget-runtime.ts";
import { ObjectiveService } from "../bridge/objectives/index.ts";
import { classifyModelCallError } from "../node_modules/eve/dist/src/harness/model-call/errors.js";
import { searchWeb, readWebpages } from "../agent/lib/web-research.ts";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import { FakeEveClient } from "./helpers.ts";

const modelId = "openai/test-model";
const usage = (input = 100, output = 10) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } });
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Solve the problem." }] }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function provider(overrides: Partial<BudgetedLanguageModel> = {}): BudgetedLanguageModel {
  return { specificationVersion: "v4", provider: "gateway", modelId, supportedUrls: {},
    async doGenerate() { return { content: [{ type: "text", text: "Answer" }], finishReason: { unified: "stop", raw: "stop" }, usage: usage(), response: { modelId }, warnings: [] }; },
    async doStream() { return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "response-metadata", modelId });
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: "Answer" });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() }); controller.close();
    } }) }; }, ...overrides };
}
async function fixture(options: { store?: ModelBudgetStore; rates?: { input: string; output: string }; now?: () => Date; canAdmit?: (id: string) => boolean; service?: Pick<JarvisService, "contextForEveSession"> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-model-budget-"));
  const objectives = await ObjectiveService.open({ dataDirectory: directory, enabled: true });
  const service = { contextForEveSession: (id: string) => id === "root-session" ? { taskId: "task-1", projectId: "project-1", conversationId: "conversation-1" } : undefined };
  const runtimeOptions = { dataDirectory: directory, objectives, service, model: modelId, enabled: true, ...options,
    fetch: (async () => Response.json({ data: [{ id: modelId, type: "language", pricing: options.rates ?? { input: "0.00001", output: "0.00002" } }] })) as typeof fetch };
  const runtime = await ModelBudgetRuntime.open(runtimeOptions);
  const transport: ModelBudgetTransport = {
    reserve: (input) => runtime.reserve(input, "root-session"),
    settle: (input) => runtime.settle(input, "root-session"),
  };
  return { directory, runtime, objectives, runtimeOptions, transport,
    async close() { await runtime.close(); await objectives.close(); await rm(directory, { recursive: true, force: true }); } };
}
const reserveInput = (callId: string) => ({ version: 1, callId, model: modelId, promptBytes: 100, maxOutputTokens: 100 });
const measured = (callId: string, inputTokens = 100, outputTokens = 10, responseModel = modelId) => ({ version: 1, callId, accounting: "measured", inputTokens, outputTokens, modelId: responseModel });

test("actual AI SDK generate/stream use durable shared accounting without changing the model", async () => {
  const f = await fixture(); try {
    const model = budgetCloudModel(provider(), f.transport);
    assert.equal((await generateText({ model, prompt: "Explain." })).text, "Answer");
    assert.equal(await streamText({ model, prompt: "Summarize the conversation." }).text, "Answer");
    assert.equal(f.runtime.readiness().ready, true);
    assert.equal(f.objectives.readiness().dailyCommittedUsd, 0.0024);
  } finally { await f.close(); }
});

test("streamed tool calls cannot escape before the finish and durable usage settlement", async () => {
  const f = await fixture(); try {
    const providerFinish = deferred<void>(), settleEntered = deferred<void>(), settlement = deferred<void>();
    let released = false, providerCalls = 0;
    const model = budgetCloudModel(provider({ async doStream() {
      providerCalls++;
      return { stream: new ReadableStream({ async start(controller) {
        controller.enqueue({ type: "response-metadata", modelId });
        controller.enqueue({ type: "tool-call", toolCallId: "call", toolName: "perform_effect", input: "{}" });
        await providerFinish.promise;
        controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() }); controller.close();
      } }) };
    } }), { ...f.transport, async settle(input, signal) {
      if (input.accounting === "measured") { settleEntered.resolve(); await settlement.promise; }
      return f.transport.settle(input, signal);
    } });
    const result = Promise.resolve(model.doStream({ prompt })).then(value => { released = true; return value; });
    while (!providerCalls) await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false); assert.ok(f.objectives.readiness().dailyCommittedUsd > 0.01);
    providerFinish.resolve(); await settleEntered.promise; assert.equal(released, false);
    settlement.resolve(); const stream = (await result).stream;
    const parts = []; for await (const part of stream) parts.push(part);
    assert.equal(parts.filter(part => part.type === "tool-call").length, 1);
    assert.equal(f.objectives.readiness().dailyCommittedUsd, 0.0012);
  } finally { await f.close(); }
});

test("unknown model identity releases no output, retains reservation and fences fresh wrappers", async () => {
  const f = await fixture(); try {
    let calls = 0;
    const bad = provider({ async doGenerate(options) { calls++; const answer = await provider().doGenerate(options); return { ...answer, response: { modelId: "expensive/unpriced" } }; } });
    await assert.rejects(async () => budgetCloudModel(bad, f.transport).doGenerate({ prompt }), ModelBudgetDenied);
    assert.equal(f.runtime.readiness().unknownAccounting, true);
    await assert.rejects(async () => budgetCloudModel(bad, f.transport).doGenerate({ prompt }), ModelBudgetDenied);
    assert.equal(calls, 1); assert.ok(f.objectives.readiness().dailyCommittedUsd > 0.01);
  } finally { await f.close(); }
});

test("the actual AI SDK never executes buffered tool calls when accounting fails", async () => {
  const f = await fixture(); try {
    let executions = 0;
    const model = budgetCloudModel(provider({ async doStream() { return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "response-metadata", modelId: "unknown/model" });
      controller.enqueue({ type: "tool-call", toolCallId: "call", toolName: "perform_effect", input: "{}" });
      controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() }); controller.close();
    } }) }; } }), f.transport);
    const result = streamText({ model, prompt: "Act.", onError() {}, tools: {
      perform_effect: { inputSchema: z.object({}), execute: async () => { executions++; return "effect"; } },
    } });
    await assert.rejects(async () => result.text); assert.equal(executions, 0); assert.equal(f.runtime.readiness().ready, false);
  } finally { await f.close(); }
});

test("cancelling an admitted hanging stream keeps accounting unknown and releases no tools", async () => {
  const f = await fixture(); try {
    const started = deferred<void>(), controller = new AbortController();
    const model = budgetCloudModel(provider({ async doStream() { started.resolve(); return {
      stream: new ReadableStream({ start(stream) { stream.enqueue({ type: "tool-call", toolName: "effect", toolCallId: "call", input: "{}" }); } }),
    }; } }), f.transport);
    const operation = Promise.resolve(model.doStream({ prompt, abortSignal: controller.signal }));
    await started.promise; controller.abort(); await assert.rejects(operation, ModelBudgetDenied);
    assert.equal(f.runtime.readiness().unknownAccounting, true); assert.ok(f.objectives.readiness().dailyCommittedUsd > 0);
  } finally { await f.close(); }
});

test("missing finish/usage and retryable provider failures become terminal 403 with no retryable cause", async () => {
  for (const mode of ["missing_usage", "retryable", "missing_finish"] as const) {
    const f = await fixture(); try {
      let calls = 0;
      const model = budgetCloudModel(provider({
        async doGenerate(options) { calls++; if (mode === "retryable") throw Object.assign(new Error("secret provider body"), { statusCode: 503, isRetryable: true });
          const answer = await provider().doGenerate(options); return { ...answer, usage: usage(undefined as unknown as number) }; },
        async doStream() { calls++; return { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "tool-call", toolName: "effect", toolCallId: "call", input: "{}" }); controller.close(); } }) }; },
      }), f.transport);
      // Explicit undefined is preserved here, unlike usage()'s default.
      if (mode === "missing_usage") {
        const raw = provider(); raw.doGenerate = async () => { calls++; return { content: [], warnings: [], finishReason: { unified: "stop", raw: "stop" }, usage: { ...usage(), inputTokens: { ...usage().inputTokens, total: undefined } }, response: { modelId } }; };
        await assert.rejects(async () => budgetCloudModel(raw, f.transport).doGenerate({ prompt }), ModelBudgetDenied);
      } else await assert.rejects(async () => mode === "missing_finish" ? model.doStream({ prompt }) : model.doGenerate({ prompt }), error => {
        assert.equal((error as ModelBudgetDenied).statusCode, 403); assert.equal((error as Error).cause, undefined);
        assert.equal(classifyModelCallError(error), "terminal");
        assert.ok(!(error as Error).message.includes("secret")); return true;
      });
      assert.equal(calls, 1); assert.equal(f.runtime.readiness().ready, false);
    } finally { await f.close(); }
  }
});

test("unknown calls stay fenced across real SQLite restart without replay", async () => {
  const f = await fixture(); try {
    await f.runtime.reserve(reserveInput("inflight"), "root-session"); await f.runtime.close();
    const recovered = await ModelBudgetRuntime.open(f.runtimeOptions);
    try {
      assert.equal(recovered.readiness().unknownAccounting, true);
      await assert.rejects(recovered.reserve(reserveInput("new"), "root-session"));
      await assert.rejects(recovered.settle(measured("inflight"), "root-session"));
      assert.ok(f.objectives.readiness().dailyCommittedUsd > 0);
    } finally { await recovered.close(); }
  } finally { await f.close(); }
});

test("reservation and final publication disk failures never expose provider output or fictional state", async () => {
  for (const failAt of [1, 2, 3]) {
    const store = new ModelBudgetStore(), original = store.save.bind(store); let saves = 0;
    store.save = value => { if (++saves === failAt) throw new Error("disk failure"); original(value); };
    const f = await fixture({ store }); let providerCalls = 0;
    try {
      const model = budgetCloudModel(provider({ async doGenerate(options) { providerCalls++; return provider().doGenerate(options); } }), f.transport);
      await assert.rejects(async () => model.doGenerate({ prompt }), ModelBudgetDenied);
      assert.equal(providerCalls, failAt === 3 ? 1 : 0); assert.equal(f.runtime.readiness().reason, "persistence_failed");
      await assert.rejects(f.runtime.reserve(reserveInput("later"), "root-session"));
      if (failAt === 1) assert.equal(f.objectives.readiness().dailyCommittedUsd, 0);
      await f.runtime.close();
      const recovered = await ModelBudgetRuntime.open({ ...f.runtimeOptions, store: new ModelBudgetStore() });
      assert.equal(recovered.readiness().ready, failAt === 1); await recovered.close();
    } finally { await f.close(); }
  }
});

test("session/project authority, replay, exact model and post-Stop observations fail closed", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.runtime.reserve(reserveInput("wrong-session"), "forged"), /binding/);
    await assert.rejects(f.runtime.reserve({ ...reserveInput("forged-project"), projectId: "project-2" }, "root-session"));
    await assert.rejects(f.runtime.reserve({ ...reserveInput("model-change"), model: "unknown/model" }, "root-session"));
    await f.runtime.reserve(reserveInput("one"), "root-session");
    await assert.rejects(f.runtime.reserve(reserveInput("one"), "root-session"), /replayed/);
    await assert.rejects(f.runtime.settle(measured("one"), "forged"));
    f.runtime.stop(); await assert.rejects(f.runtime.reserve(reserveInput("two"), "root-session"));
    await f.runtime.settle(measured("one", 100, 10, "test-model"), "root-session");
    assert.equal(f.runtime.readiness().ready, false); f.runtime.resume(); assert.equal(f.runtime.readiness().ready, true);
    await assert.rejects(f.runtime.settle(measured("one", 500), "root-session"), /rewritten/);
  } finally { await f.close(); }
});

test("per-turn five dollar budget shares global daily/monthly accounting", async () => {
  const f = await fixture({ rates: { input: "0.0003", output: "0" } }); try {
    const input = { ...reserveInput("first"), promptBytes: 1, maxOutputTokens: 1 };
    await f.runtime.reserve(input, "root-session"); await f.runtime.settle(measured("first", 8_194, 0), "root-session");
    await f.runtime.reserve({ ...input, callId: "second" }, "root-session"); await f.runtime.settle(measured("second", 8_194, 0), "root-session");
    await assert.rejects(f.runtime.reserve({ ...input, callId: "third" }, "root-session"), /five dollars/);
    assert.ok(f.objectives.readiness().dailyCommittedUsd > 4.9);
  } finally { await f.close(); }
  const global = await fixture(); try {
    await global.objectives.reserve({ requestId: "other-1", projectId: "other", estimatedUsd: 5, authority: "research" });
    await global.objectives.reserve({ requestId: "other-2", projectId: "other", estimatedUsd: 5, authority: "research" });
    await assert.rejects(global.runtime.reserve(reserveInput("daily-over"), "root-session"), /Daily or monthly/);
  } finally { await global.close(); }
});

test("usage over-bound is durably charged and fences later admissions", async () => {
  const f = await fixture(); try {
    const reserve = await f.runtime.reserve(reserveInput("over"), "root-session");
    await assert.rejects(f.runtime.settle(measured("over", reserve.maxInputTokens + 1), "root-session"), /exceeded/);
    assert.equal(f.runtime.readiness().unknownAccounting, true);
    assert.ok(f.objectives.readiness().dailyCommittedUsd > 0.08);
  } finally { await f.close(); }
});

test("expired reservations and the cumulative turn deadline block new inference", async () => {
  let now = new Date(); const f = await fixture({ now: () => now }); try {
    await f.runtime.reserve(reserveInput("active"), "root-session"); now = new Date(now.getTime() + 120_001);
    assert.equal(f.runtime.readiness().unknownAccounting, true);
    await assert.rejects(f.runtime.reserve(reserveInput("expired"), "root-session"));
  } finally { await f.close(); }
  now = new Date(); const completed = await fixture({ now: () => now }); try {
    await completed.runtime.reserve(reserveInput("done"), "root-session");
    await completed.runtime.settle(measured("done"), "root-session"); now = new Date(now.getTime() + 30 * 60_000);
    await assert.rejects(completed.runtime.reserve(reserveInput("late"), "root-session"), /time/);
  } finally { await completed.close(); }
});

test("unpriced media/provider tools/fallbacks are refused before any reservation or inference", async () => {
  const f = await fixture(); try {
    let calls = 0, reservations = 0;
    const transport = { ...f.transport, reserve: (...args: Parameters<ModelBudgetTransport["reserve"]>) => { reservations++; return f.transport.reserve(...args); } };
    const badInputs = [
      { prompt, providerOptions: { gateway: { models: ["unknown/model"] } } },
      { prompt, tools: [{ type: "provider", id: "web_search", name: "search", args: {} }] },
      { prompt: [{ role: "user", content: [{ type: "file", data: new URL("https://example.com/huge.pdf"), mediaType: "application/pdf" }] }] },
      { prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(100_000) }] }] },
    ];
    for (const input of badInputs) await assert.rejects(async () => budgetCloudModel(provider({ async doGenerate(options) { calls++; return provider().doGenerate(options); } }), transport)
      .doGenerate(input as Parameters<BudgetedLanguageModel["doGenerate"]>[0]), ModelBudgetDenied);
    assert.equal(calls, 0); assert.equal(reservations, 0);
  } finally { await f.close(); }
});

test("automatic cloud model selection preserves configured model and delegated root accounting; compaction has no bypass", async () => {
  const previous = process.env.JARVIS_RUNTIME_PROFILE, previousModel = process.env.JARVIS_MODEL, previousKey = process.env.AI_GATEWAY_API_KEY;
  try {
    process.env.JARVIS_RUNTIME_PROFILE = "cloud"; process.env.JARVIS_MODEL = modelId;
    const root = { session: { id: "root-session" }, turn: { id: "turn" } } as DynamicModelContext;
    delete process.env.AI_GATEWAY_API_KEY; assert.throws(() => selectModel(root), ModelBudgetDenied);
    process.env.AI_GATEWAY_API_KEY = "fixture-provider-key-never-transmitted";
    const delegated = { ...root, session: { id: "analyst-session", parent: { rootSessionId: "root-session" } } } as DynamicModelContext;
    for (const context of [root, delegated]) {
      const selected = selectModel(context); assert.notEqual(typeof selected, "string");
      if (typeof selected === "string") throw new Error("Cloud selected an unbounded model string");
      assert.equal(selected.model.modelId, modelId); assert.equal(selected.modelContextWindowTokens, 16_384);
      await assert.rejects(async () => selected.model.doGenerate({ prompt, providerOptions: { gateway: { models: ["bypass/model"] } } }), ModelBudgetDenied);
    }
    const agent = await import("../agent/agent.ts"), analyst = await import("../agent/subagents/analyst/agent.ts");
    assert.ok(agent.default); assert.ok(analyst.default);
    // Guard pinned Eve's compaction inheritance and our shared model selection.
    // This source contract complements public SDK execution above; no paid Eve run.
    const rootSource = await readFile(new URL("../agent/agent.ts", import.meta.url), "utf8");
    const analystSource = await readFile(new URL("../agent/subagents/analyst/agent.ts", import.meta.url), "utf8");
    assert.match(rootSource, /model: modelSelection/); assert.match(analystSource, /model: modelSelection/);
    assert.doesNotMatch(rootSource, /compaction:\s*\{[^}]*model:/);
    process.env.JARVIS_RUNTIME_PROFILE = "macos"; assert.equal(selectModel(root), modelId);
  } finally {
    if (previous === undefined) delete process.env.JARVIS_RUNTIME_PROFILE; else process.env.JARVIS_RUNTIME_PROFILE = previous;
    if (previousModel === undefined) delete process.env.JARVIS_MODEL; else process.env.JARVIS_MODEL = previousModel;
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previousKey;
  }
});

test("actual Tavily library entry points cannot bypass the cloud ledger even with credentials", async () => {
  const previous = process.env.JARVIS_RUNTIME_PROFILE; let network = 0;
  try {
    process.env.JARVIS_RUNTIME_PROFILE = "cloud";
    const dependencies = { apiKey: "provided-fixture-key", fetch: (async () => { network++; return Response.json({ results: [] }); }) as typeof fetch };
    await assert.rejects(searchWeb({ query: "public research" }, undefined, dependencies), /budgeted research objective/);
    await assert.rejects(readWebpages({ urls: ["https://example.com"] }, undefined, dependencies), /budgeted research objective/);
    assert.equal(network, 0);
  } finally { if (previous === undefined) delete process.env.JARVIS_RUNTIME_PROFILE; else process.env.JARVIS_RUNTIME_PROFILE = previous; }
});

test("real HTTP bridge authenticates model reservations and derives project from its admitted Eve task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-budget-http-")), client = new FakeEveClient();
  const service = await JarvisService.create({ client, dataDirectory: directory, model: modelId });
  const f = await fixture({ service });
  const previous = process.env.JARVIS_LOCAL_TOKEN;
  const token = "model-budget-http-local-authentication-credential"; process.env.JARVIS_LOCAL_TOKEN = token;
  const server = createBridgeServer(service, "127.0.0.1", 0, undefined, { extensions: { modelBudget: f.runtime } });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const conversation = await service.createConversation("Accounting test", "project-http");
    await service.createTask("A bounded cloud turn", conversation.id, "project-http");
    for (let i = 0; i < 50 && !service.contextForEveSession(client.session.id); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.contextForEveSession(client.session.id)?.projectId, "project-http");
    const path = `${base}/v1/model-budget/reserve`;
    const noAuth = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reserveInput("no-auth")) });
    assert.equal(noAuth.status, 401); await noAuth.body?.cancel();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-jarvis-eve-session": client.session.id };
    const foreignOrigin = await fetch(path, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: JSON.stringify(reserveInput("origin")) });
    assert.equal(foreignOrigin.status, 403); await foreignOrigin.body?.cancel();
    const unknownSession = await fetch(path, { method: "POST", headers: { ...headers, "x-jarvis-eve-session": "unbound" }, body: JSON.stringify(reserveInput("unbound")) });
    assert.equal(unknownSession.status, 425); await unknownSession.body?.cancel();
    const forged = await fetch(path, { method: "POST", headers, body: JSON.stringify({ ...reserveInput("project-injection"), projectId: "other" }) });
    assert.equal(forged.status, 400); await forged.body?.cancel();
    const transport = bridgeModelBudgetTransport(client.session.id, ((input, init) => fetch(String(input).replace("http://127.0.0.1:39202", base), init)) as typeof fetch);
    assert.equal((await generateText({ model: budgetCloudModel(provider(), transport), prompt: "Explain." })).text, "Answer");
    assert.equal(f.objectives.readiness().dailyCommittedUsd, 0.0012);
  } finally {
    await shutdownBridge(server); await f.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.JARVIS_LOCAL_TOKEN; else process.env.JARVIS_LOCAL_TOKEN = previous;
  }
});
