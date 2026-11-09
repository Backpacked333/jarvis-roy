import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayPrices, matchesPricedModel } from "../bridge/gateway-pricing.ts";
import { Gateway, emptyUsage } from "../bridge/harness-worker/gateway.ts";
import { defaultRoomPolicy, type Usage } from "../bridge/harness-contracts/domain.ts";

const model = "fixture/model";
const base = { input: "0.000001", output: "0.000002" };
const catalog = (pricing: unknown = base, id = model) => ({ data: [{ id, type: "language", pricing }] });
const request = {
  messages: [{ role: "user", content: "Review the supplied evidence" }], tool_choice: "required",
  tools: ["write_file", "read_file", "run_check", "ask_question", "final_answer"].map(name => ({ type: "function", function: { name } })),
};
const limits = { ...defaultRoomPolicy().runBudget, estimatedUsdLimit: 1 };
const signal = () => new AbortController().signal;
const completion = (identity: object = { model }) => ({ ...identity,
  usage: { prompt_tokens: 10, completion_tokens: 20 },
  choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [
    { id: "done", type: "function", function: { name: "final_answer", arguments: '{"answer":"Reviewed"}' } },
  ] } }],
});

test("shared prices conservatively cover service, regional, cache and context variants", () => {
  assert.deepEqual(gatewayPrices(catalog({ ...base,
    input_tiers: [{ cost: "0.000003", min: 0 }], output_tiers: [{ cost: "0.000004" }],
    input_cache_write_tiers: [{ cost: "0.000009" }],
    service_tiers: { priority: { input: "0.000005", output: "0.000006" } },
    regional: { us: { input: "0.000002", output: "0.000010" } },
    fast: { input: "0.000007", output: "0.000008" },
  }), model), { input: 0.000009, output: 0.000010 });
});

test("shared prices reject absent, ambiguous, non-language and unsupported rates", () => {
  for (const input of ["", " ", "NaN", "Infinity", "-1", "1e-999", "2", "0x01"]) {
    assert.throws(() => gatewayPrices(catalog({ ...base, input }), model));
  }
  for (const pricing of [null, { ...base, varies_by_provider: true }, { ...base, request: "0.01" },
    { ...base, service_tiers: { priority: { ...base, unknown_fee: "1" } } }]) {
    assert.throws(() => gatewayPrices(catalog(pricing), model));
  }
  const row = catalog().data[0];
  for (const data of [[], [row, row], [{ ...row, type: "embedding" }]]) {
    assert.throws(() => gatewayPrices({ data }, model));
  }
  assert.deepEqual(gatewayPrices(catalog({ input: "0", output: "0e-12" }), model), { input: 0, output: 0 });
});

test("shared identity check permits only exact models and documented OpenAI fast priority mapping", () => {
  assert.equal(matchesPricedModel(model, { model }), true);
  assert.equal(matchesPricedModel("openai/gpt-6-sol-fast", { model: "openai/gpt-6-sol", service_tier: "priority" }), true);
  for (const identity of [{}, { model: "other/model" }, { model: "openai/gpt-6-sol" },
    { model: "openai/gpt-6-sol", service_tier: "default" }, { model: "gpt-6-sol", service_tier: "priority" }]) {
    assert.equal(matchesPricedModel("openai/gpt-6-sol-fast", identity), false);
  }
  assert.equal(matchesPricedModel("other/model-fast", { model: "other/model", service_tier: "priority" }), false);
});

test("worker refuses zero or unknown prior dollar budgets before any network request", async () => {
  const gateway = new Gateway(model, async () => { assert.fail("must not request catalog or inference"); }, undefined);
  await assert.rejects(gateway.generate(request, emptyUsage(), { ...limits, estimatedUsdLimit: 0 }, async () => {}, signal()), /estimated-dollar/);
  for (const usage of [{ ...emptyUsage(), modelCalls: 1 }, { ...emptyUsage(), inputTokens: 10 }]) {
    await assert.rejects(gateway.generate(request, usage, limits, async () => {}, signal()), /cost is uncertain/);
  }
});

test("worker rejects unknown pricing shapes before dispatch and includes supported rate variants", async () => {
  let modelCalls = 0;
  for (const pricing of [{ ...base, unknown_fee: "1" }, { ...base, varies_by_provider: true },
    { ...base, input: "" }, { ...base, input_cache_write: "0.5" }]) {
    const usage = emptyUsage();
    const gateway = new Gateway(model, async url => {
      if (String(url).endsWith("/models")) return Response.json(catalog(pricing));
      modelCalls++; return Response.json(completion());
    }, undefined);
    await assert.rejects(gateway.generate(request, usage, limits, async () => {}, signal()), /pricing|estimated-dollar/);
    assert.deepEqual(usage, emptyUsage());
  }
  assert.equal(modelCalls, 0);
});

test("worker model mismatch persists unknown cost and cannot dispatch again or repair tool batches", async () => {
  for (const identity of [{}, { model: "other/model" }]) {
    const usage = emptyUsage(), writes: Usage[] = [];
    let calls = 0;
    const gateway = new Gateway(model, async url => {
      if (String(url).endsWith("/models")) return Response.json(catalog());
      calls++; return Response.json(completion(identity));
    }, undefined);
    await assert.rejects(gateway.generate(request, usage, limits, async () => { writes.push(structuredClone(usage)); }, signal()), /unpriced or unidentified/);
    assert.equal(usage.accounting, "unknown");
    assert.equal(usage.estimatedUsd, null);
    assert.equal(usage.reservedTokens, limits.maxTokens);
    assert.equal(writes.at(-1)?.accounting, "unknown");
    await assert.rejects(gateway.generate(request, usage, limits, async () => {}, signal()), /uncertain/);
    assert.equal(calls, 1);
  }
});

test("worker accepts the priced fast model alias and refreshes admission rates between calls", async () => {
  const fast = "openai/gpt-6-sol-fast";
  let catalogs = 0;
  const usage = emptyUsage();
  const gateway = new Gateway(fast, async url => {
    if (String(url).endsWith("/models")) {
      catalogs++;
      return Response.json(catalog({ input: catalogs === 1 ? "0.000001" : "0.000003", output: "0.000002" }, fast));
    }
    return Response.json(completion({ model: "openai/gpt-6-sol", service_tier: "priority" }));
  }, undefined);
  await gateway.generate(request, usage, limits, async () => {}, signal());
  assert.ok(Math.abs(usage.estimatedUsd! - 0.00005) < 1e-12);
  await gateway.generate(request, usage, limits, async () => {}, signal());
  assert.equal(catalogs, 2);
  assert.ok(Math.abs(usage.estimatedUsd! - 0.00012) < 1e-12);
  assert.equal(usage.accounting, "measured");
});

test("worker retains conservative cost and remaining tokens when a dispatched request fails", async () => {
  const usage = emptyUsage();
  const gateway = new Gateway(model, async url => {
    if (String(url).endsWith("/models")) return Response.json(catalog());
    throw new Error("transport failed");
  }, undefined);
  await assert.rejects(gateway.generate(request, usage, limits, async () => {}, signal()), /transport failed/);
  assert.equal(usage.accounting, "unknown");
  assert.equal(usage.modelCalls, 1);
  assert.equal(usage.reservedTokens, limits.maxTokens);
  assert.ok(usage.estimatedUsd! > 0);
});
