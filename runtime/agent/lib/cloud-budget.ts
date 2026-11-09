import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "ai";
import { isValidLocalToken } from "./local-auth.ts";
import { readBoundedJson } from "../../bridge/harness-interactions/gateway.ts";
import { CLOUD_MODEL_MAX_CALL_MS, CLOUD_MODEL_MAX_OUTPUT_TOKENS, CLOUD_MODEL_MAX_PROMPT_BYTES,
  ModelReservationInput, ModelReservationReply, ModelSettlementReply } from "./cloud-budget-contracts.ts";
import { z } from "zod";

export type BudgetedLanguageModel = ReturnType<ReturnType<typeof createGateway>>;
type CallOptions = Parameters<BudgetedLanguageModel["doGenerate"]>[0];
type Generated = Awaited<ReturnType<BudgetedLanguageModel["doGenerate"]>>;
type Streamed = Awaited<ReturnType<BudgetedLanguageModel["doStream"]>>;
type StreamPart = Streamed["stream"] extends ReadableStream<infer Part> ? Part : never;
export interface ModelBudgetTransport {
  reserve(input: z.infer<typeof ModelReservationInput>, signal: AbortSignal): Promise<z.infer<typeof ModelReservationReply>>;
  settle(input: { version: 1; callId: string; accounting: "unknown" } | {
    version: 1; callId: string; accounting: "measured"; inputTokens: number; outputTokens: number;
    modelId: string; serviceTier?: "priority" | "flex" | "default";
  }, signal: AbortSignal): Promise<unknown>;
}
/** Eve classifies an ordinary Error as recoverable and may retry it. Do not
 * attach provider errors/causes: a nested retryable flag overrides this status. */
export class ModelBudgetDenied extends Error {
  readonly statusCode = 403;
  readonly isRetryable = false;
  constructor() { super("Cloud model admission or accounting is unavailable. Inspect the original turn before retrying."); }
}
const SafeProviderOptions = z.strictObject({
  gateway: z.strictObject({ sessionId: z.string().max(256).optional() }).optional(),
  openai: z.strictObject({ safetyIdentifier: z.string().max(256).optional() }).optional(),
  anthropic: z.strictObject({ metadata: z.strictObject({ userId: z.string().max(256) }).optional() }).optional(),
});
function allowedOptions(options: CallOptions): { options: CallOptions; bytes: number } {
  // Eve supplies session/safety identifiers itself. These have no routing or
  // price effect; every other provider option (including fallback models) fails.
  if (!SafeProviderOptions.safeParse(options.providerOptions ?? {}).success || options.includeRawChunks ||
      options.tools?.some(tool => tool.type !== "function")) throw new ModelBudgetDenied();
  // No remotely expanded media or provider-hosted tools with unpriced charges.
  for (const message of options.prompt) {
    if (message.providerOptions && Object.keys(message.providerOptions).length) throw new ModelBudgetDenied();
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (!["text", "reasoning", "tool-call", "tool-result", "tool-approval-response"].includes(part.type) ||
          "providerOptions" in part && part.providerOptions && Object.keys(part.providerOptions).length) throw new ModelBudgetDenied();
      if (part.type === "tool-result" && !["text", "json", "error-text", "error-json", "execution-denied"].includes(part.output.type)) throw new ModelBudgetDenied();
    }
  }
  if (options.tools?.some(tool => "providerOptions" in tool && tool.providerOptions && Object.keys(tool.providerOptions).length)) throw new ModelBudgetDenied();
  const maxOutputTokens = Math.min(options.maxOutputTokens ?? CLOUD_MODEL_MAX_OUTPUT_TOKENS, CLOUD_MODEL_MAX_OUTPUT_TOKENS);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new ModelBudgetDenied();
  const bytes = Buffer.byteLength(JSON.stringify({ prompt: options.prompt, tools: options.tools, responseFormat: options.responseFormat }));
  if (bytes > CLOUD_MODEL_MAX_PROMPT_BYTES) throw new ModelBudgetDenied();
  // Attribution/trace headers are optional and cannot alter provider admission.
  return { options: { ...options, headers: undefined, maxOutputTokens, includeRawChunks: false }, bytes };
}
function observed(usage: Generated["usage"], modelId: string | undefined, metadata: Generated["providerMetadata"]) {
  const inputTokens = usage?.inputTokens?.total, outputTokens = usage?.outputTokens?.total;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens! < 0 || outputTokens! < 0 || !modelId) throw new ModelBudgetDenied();
  const tier = metadata?.openai?.serviceTier ?? metadata?.gateway?.serviceTier;
  const serviceTier: "priority" | "flex" | "default" | undefined = tier === "priority" || tier === "flex" || tier === "default" ? tier : undefined;
  return { inputTokens: inputTokens!, outputTokens: outputTokens!, modelId, serviceTier };
}
function bounded<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ModelBudgetDenied()); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** The provider interface, not dynamic selection or telemetry, is the boundary:
 * inherited compaction and delegated models execute these same methods. All
 * stream parts are held until durable accounting; tools cannot escape early. */
export function budgetCloudModel(model: BudgetedLanguageModel, transport: ModelBudgetTransport): BudgetedLanguageModel {
  let fenced = false;
  const execute = async <T>(raw: CallOptions, operation: (options: CallOptions) => Promise<T>, validate: (result: T) => ReturnType<typeof observed>): Promise<T> => {
    if (fenced) throw new ModelBudgetDenied();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CLOUD_MODEL_MAX_CALL_MS), ...(raw.abortSignal ? [raw.abortSignal] : [])]);
    let callId: string | undefined;
    try {
      signal.throwIfAborted(); const checked = allowedOptions(raw);
      callId = randomUUID();
      const reserved = await bounded(transport.reserve({ version: 1, callId, model: model.modelId,
        promptBytes: checked.bytes, maxOutputTokens: checked.options.maxOutputTokens! }, signal), signal);
      if (reserved.callId !== callId || reserved.maxOutputTokens !== checked.options.maxOutputTokens || Date.parse(reserved.expiresAt) <= Date.now()) throw new ModelBudgetDenied();
      signal.throwIfAborted();
      const result = await bounded(operation({ ...checked.options, abortSignal: signal }), signal);
      const usage = validate(result);
      await bounded(transport.settle({ version: 1, callId, accounting: "measured", ...usage }, signal), signal);
      signal.throwIfAborted(); return result;
    } catch {
      fenced = true; controller.abort();
      if (callId) { try { await transport.settle({ version: 1, callId, accounting: "unknown" }, AbortSignal.timeout(5_000)); } catch {} }
      throw new ModelBudgetDenied();
    }
  };
  return {
    specificationVersion: "v4", provider: model.provider, modelId: model.modelId, supportedUrls: {},
    doGenerate: options => execute(options, async checked => {
      const result = await model.doGenerate(checked);
      if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1_024) throw new ModelBudgetDenied();
      return result;
    }, result => observed(result.usage, result.response?.modelId, result.providerMetadata)),
    async doStream(options) {
      const buffered = await execute(options, async checked => {
        const result = await model.doStream(checked), reader = result.stream.getReader();
        const parts: StreamPart[] = []; let bytes = 0;
        try {
          while (true) {
            const item = await bounded(reader.read(), checked.abortSignal!); if (item.done) break;
            bytes += Buffer.byteLength(JSON.stringify(item.value));
            if (bytes > 512 * 1_024 || parts.length >= 16_384 || item.value.type === "error") throw new ModelBudgetDenied();
            parts.push(item.value);
          }
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        return { result, parts };
      }, ({ parts }) => {
        const finishes = parts.filter((part): part is Extract<StreamPart, { type: "finish" }> => part.type === "finish");
        const identities = parts.filter((part): part is Extract<StreamPart, { type: "response-metadata" }> => part.type === "response-metadata");
        if (finishes.length !== 1 || identities.length !== 1 || parts.at(-1)?.type !== "finish") throw new ModelBudgetDenied();
        return observed(finishes[0].usage, identities[0].modelId, finishes[0].providerMetadata);
      });
      return { ...buffered.result, stream: new ReadableStream({ start(controller) { for (const part of buffered.parts) controller.enqueue(part); controller.close(); } }) };
    },
  };
}

export function bridgeModelBudgetTransport(sessionId: string, fetcher: typeof fetch = fetch): ModelBudgetTransport {
  const request = async (operation: "reserve" | "settle", body: unknown, signal: AbortSignal) => {
    const token = process.env.JARVIS_LOCAL_TOKEN;
    if (!isValidLocalToken(token)) throw new ModelBudgetDenied();
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetcher(`http://127.0.0.1:39202/v1/model-budget/${operation}`, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${token}`, "x-jarvis-eve-session": sessionId, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      // Only retry a proven pre-admission binding race. Never retry a possibly
      // committed reservation or a provider operation after ambiguous failure.
      if (operation === "reserve" && response.status === 425 && attempt < 7) { await response.body?.cancel(); await delay(50 * (attempt + 1), undefined, { signal }); continue; }
      if (!response.ok) { await response.body?.cancel(); throw new ModelBudgetDenied(); }
      return readBoundedJson(response, signal, 16_384);
    }
    throw new ModelBudgetDenied();
  };
  return {
    reserve: async (body, signal) => ModelReservationReply.parse(await request("reserve", body, signal)),
    settle: async (body, signal) => ModelSettlementReply.parse(await request("settle", body, signal)),
  };
}
