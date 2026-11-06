import assert from "node:assert/strict";
import test from "node:test";
import { defaultRoomPolicy } from "../bridge/harness-contracts/domain.ts";
import { createPlanAuthor } from "../bridge/harness-interactions/index.ts";

test("authorized live Gateway creates a validated specialist graph (one call, no tools or workers)", {
  skip: process.env.JARVIS_TEST_LIVE_AUTHORING !== "1", timeout: 35_000,
}, async () => {
  assert.ok(process.env.AI_GATEWAY_API_KEY, "AI_GATEWAY_API_KEY required for explicitly enabled live check");
  const at = new Date().toISOString();
  const policy = defaultRoomPolicy();
  policy.authoringBudget = { maxSteps: 1, maxModelCalls: 1, maxTokens: 6_000, maxOutputTokensPerCall: 1_600, maxWallTimeMs: 30_000, estimatedUsdLimit: null };
  const result = await createPlanAuthor({ model: process.env.JARVIS_MODEL || "openai/gpt-4.1-mini" }).author({
    room: { version: 1, id: "live-planning", title: "Offline arithmetic exercise", description: "Only draft a plan; execute nothing", status: "active", revision: 1, policy, createdAt: at, updatedAt: at },
    authoring: { id: "live-authoring", roomId: "live-planning", requestId: "live-request", revision: 1, policyRevision: 1,
      goal: "Draft a two-node plan: a builder writes a Python Celsius-to-Fahrenheit function with no dependencies; a tester consumes the builder artifacts, verifies freezing and boiling points using unittest, and writes a result report. Offline sandbox files only. No clarification is needed. Do not execute the plan.",
      status: "authoring", planId: null, usage: { steps: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, reservedTokens: 0, accounting: "measured", estimatedUsd: null },
      createdAt: at, updatedAt: at, error: null }, checkpoint: null, answer: null,
  }, { signal: new AbortController().signal });
  assert.equal(result.status, "completed", result.status === "failed" ? result.error : result.status);
  if (result.status !== "completed") return;
  assert.equal(result.usage.modelCalls, 1); assert.equal(result.draft.nodes.length, 2);
  assert.ok(result.draft.nodes.some((node) => node.role === "builder"));
  assert.ok(result.draft.nodes.some((node) => node.role === "tester" && node.inputFrom.length > 0));
  console.log(JSON.stringify({ liveAuthoring: "validated-draft-only", nodes: result.draft.nodes.length, usage: result.usage }));
});
