import { z } from "zod";
import { RelativePathSchema, type BudgetLimits, type Usage } from "../harness-contracts/domain.ts";

export const ToolArguments = {
  write_file: z.strictObject({ path: RelativePathSchema, content: z.string().max(262_144) }),
  read_file: z.strictObject({ path: RelativePathSchema }),
  run_check: z.strictObject({ command: z.string().min(1).max(8000) }),
  ask_question: z.strictObject({ prompt: z.string().trim().min(1).max(2000) }),
  final_answer: z.strictObject({ answer: z.string().max(4000) }),
};
export type ToolName = keyof typeof ToolArguments;
const CallSchema = z.object({ id: z.string().min(1).max(200), type: z.literal("function"),
  function: z.object({ name: z.enum(["write_file", "read_file", "run_check", "ask_question", "final_answer"]), arguments: z.string().max(350_000) }) });
const ResponseSchema = z.object({
  choices: z.array(z.object({ finish_reason: z.string().nullable(), message: z.object({
    role: z.literal("assistant"), content: z.string().max(65_536).nullable().optional(), tool_calls: z.array(CallSchema).length(1),
  }) })).length(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
});

export function emptyUsage(): Usage {
  return { steps: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, reservedTokens: 0, accounting: "measured", estimatedUsd: null };
}

export async function boundedJson(response: Response, maxBytes = 524_288): Promise<unknown> {
  if (!response.body) throw new Error("Gateway returned no body");
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > maxBytes) throw new Error("Gateway response size exceeded");
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export class Gateway {
  readonly model: string;
  readonly fetcher: typeof fetch;
  readonly key: string | undefined;
  private prices: { input: number; output: number } | undefined;
  constructor(model: string, fetcher: typeof fetch, key: string | undefined) {
    this.model = model; this.fetcher = fetcher; this.key = key;
  }

  private async pricing(signal: AbortSignal): Promise<{ input: number; output: number }> {
    if (this.prices) return this.prices;
    const response = await this.fetcher("https://ai-gateway.vercel.sh/v1/models", { signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Model pricing unavailable for estimated-dollar admission"); }
    const metadata = z.object({ data: z.array(z.object({ id: z.string(), pricing: z.unknown().optional() })) }).parse(await boundedJson(response, 8_000_000));
    const tiers = z.array(z.object({ cost: z.string() })).optional();
    const pricing = z.object({ input: z.string(), output: z.string(), input_tiers: tiers, output_tiers: tiers }).parse(metadata.data.find(model => model.id === this.model)?.pricing);
    const price = (base: string, values: { cost: string }[] | undefined) => {
      const rates = [base, ...(values ?? []).map(value => value.cost)].map(Number);
      if (rates.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Unsupported model pricing");
      return Math.max(...rates);
    };
    this.prices = { input: price(pricing.input, pricing.input_tiers), output: price(pricing.output, pricing.output_tiers) };
    return this.prices;
  }

  async generate(request: Record<string, unknown>, usage: Usage, limits: BudgetLimits,
    persist: () => Promise<void>, signal: AbortSignal, allowBatchRepair = true): Promise<{ message: object; call: { name: ToolName; arguments: Record<string, unknown> } }> {
    if (usage.accounting !== "measured" || usage.reservedTokens > 0) throw new Error("Token usage is uncertain; another model call is not safe");
    if (usage.modelCalls >= limits.maxModelCalls || usage.steps >= limits.maxSteps) throw new Error("Worker model/step budget exhausted");
    const parsed = z.strictObject({
      messages: z.array(z.record(z.string(), z.unknown())).min(1).max(250),
      tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.enum(["write_file", "read_file", "run_check", "ask_question", "final_answer"]) }).passthrough() })).length(5),
      tool_choice: z.literal("required"),
    }).parse(request);
    if (new Set(parsed.tools.map(tool => tool.function.name)).size !== 5) throw new Error("Controller tool set mismatch");
    const inputBound = Buffer.byteLength(JSON.stringify(parsed)) + parsed.messages.length * 256 + 1024;
    const remaining = limits.maxTokens - usage.inputTokens - usage.outputTokens;
    const outputCap = Math.min(limits.maxOutputTokensPerCall, remaining - inputBound);
    if (inputBound > 500_000 || outputCap < 64) throw new Error("Conservative prompt/output token reservation exceeds remaining node budget");
    const rates = limits.estimatedUsdLimit === null ? null : await this.pricing(signal);
    const priorEstimate = usage.estimatedUsd ?? 0;
    if (rates && priorEstimate + inputBound * rates.input + outputCap * rates.output > limits.estimatedUsdLimit!) {
      throw new Error("Conservative estimated-dollar admission limit exceeded (not a provider billing cap)");
    }
    usage.modelCalls++;
    usage.reservedTokens = inputBound + outputCap;
    usage.accounting = "partial";
    if (rates) usage.estimatedUsd = priorEstimate + inputBound * rates.input + outputCap * rates.output;
    await persist();
    signal.throwIfAborted();
    let raw: unknown;
    try {
      const response = await this.fetcher("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify({ ...parsed, model: this.model, max_tokens: outputCap, parallel_tool_calls: false, stream: false }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Gateway request failed (HTTP ${response.status})`); }
      raw = await boundedJson(response);
    } catch (error) {
      usage.reservedTokens = remaining;
      await persist();
      throw error;
    }
    const measured = z.object({ usage: z.object({ prompt_tokens: z.number().int().min(0).max(10_000_000), completion_tokens: z.number().int().min(0).max(1_000_000) }) }).safeParse(raw);
    if (measured.success) {
      usage.inputTokens += measured.data.usage.prompt_tokens;
      usage.outputTokens += measured.data.usage.completion_tokens;
      if (rates) usage.estimatedUsd = priorEstimate + measured.data.usage.prompt_tokens * rates.input + measured.data.usage.completion_tokens * rates.output;
      const valid = measured.data.usage.prompt_tokens <= inputBound && measured.data.usage.completion_tokens <= outputCap;
      usage.reservedTokens = valid ? 0 : Math.max(0, limits.maxTokens - usage.inputTokens - usage.outputTokens);
      usage.accounting = valid ? "measured" : "partial";
      await persist();
      if (!valid) throw new Error("Provider usage exceeded admitted reservation; execution halted");
    } else {
      usage.reservedTokens = remaining;
      usage.accounting = usage.inputTokens + usage.outputTokens ? "partial" : "unknown";
      await persist();
      throw new Error("Provider omitted trustworthy usage; execution halted with full remaining reservation");
    }
    const validated = ResponseSchema.safeParse(raw);
    if (!validated.success && allowBatchRepair && validated.error.issues.every(issue =>
      issue.code === "too_big" && issue.path.join(".") === "choices.0.message.tool_calls")) {
      // Some providers ignore parallel_tool_calls:false. No rejected call executes.
      return this.generate({ ...parsed, messages: [...parsed.messages, { role: "user",
        content: "The previous response contained multiple tool calls and was rejected. NONE executed. Return exactly ONE tool call, not a batch. Continue from the unchanged files." }] },
      usage, limits, persist, signal, false);
    }
    if (!validated.success) throw new Error(`Gateway response shape rejected: ${validated.error.issues.map(issue => `${issue.code} at ${issue.path.join(".")}`).join("; ").slice(0, 500)}`);
    const response = validated.data;
    if (response.choices[0].finish_reason !== "tool_calls" && response.choices[0].finish_reason !== "stop") throw new Error("Incomplete model response");
    const call = response.choices[0].message.tool_calls[0];
    const validatedArgs = ToolArguments[call.function.name].safeParse(JSON.parse(call.function.arguments));
    if (!validatedArgs.success) throw new Error(`Gateway ${call.function.name} arguments rejected: ${validatedArgs.error.issues.map(issue => `${issue.code} at ${issue.path.join(".")}`).join("; ").slice(0, 500)}`);
    const args = validatedArgs.data;
    return {
      message: { role: "assistant", content: response.choices[0].message.content ?? "", tool_calls: [{ ...call, function: { name: call.function.name, arguments: args } }] },
      call: { name: call.function.name, arguments: args },
    };
  }
}
