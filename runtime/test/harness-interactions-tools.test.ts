import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HarnessStateSchema, type HarnessState } from "../bridge/harness-contracts/service.ts";
import type { Authoring } from "../bridge/harness-contracts/domain.ts";
import { AuthorToolInputSchema, authorPlanFromTool, roomStateFromTool, createLoopbackHarnessAgentPort, type HarnessAgentPort } from "../bridge/harness-interactions/agent-tools.ts";
import authorTool from "../agent/tools/harness_author_plan.ts";
import stateTool from "../agent/tools/harness_room_state.ts";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/harness-v1.json", import.meta.url), "utf8"));
function state(): HarnessState { return HarnessStateSchema.parse(structuredClone(fixture.state)); }
const context = () => ({ sessionId: "root-session", callId: "root-call", delegated: false, signal: new AbortController().signal });
const newRoomInput = () => ({ roomId: null, expectedRoomRevision: null, title: "Research desk", description: "Offline work", goal: "Build a unit-converter CLI and verify it" });
function service(data: HarnessState) {
  const calls: { method: string; input: any; roomId?: string }[] = [];
  const harness: HarnessAgentPort = {
    async state() { calls.push({ method: "state", input: null }); return structuredClone(data); },
    async createRoom(input) {
      calls.push({ method: "createRoom", input });
      return { ...data.rooms[0], id: "new-room", title: input.title, description: input.description, policy: input.policy };
    },
    async authorPlan(roomId, input) {
      calls.push({ method: "authorPlan", roomId, input });
      return { id: "new-authoring", roomId, requestId: input.requestId, revision: 1, policyRevision: 1, goal: input.goal,
        status: "authoring", planId: null, usage: { steps: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, reservedTokens: 0, accounting: "measured", estimatedUsd: null },
        createdAt: data.rooms[0].createdAt, updatedAt: data.rooms[0].updatedAt, error: null };
    },
  };
  return { harness, calls };
}

test("Eve tools are actual root-only defineTool exports with strict schemas and no execution/approval surface", () => {
  assert.equal(authorTool.availableInSubagents, false); assert.equal(stateTool.availableInSubagents, false);
  assert.equal(typeof authorTool.execute, "function"); assert.equal(typeof stateTool.execute, "function");
  for (const key of ["policy", "startRun", "approve", "tools", "permissions"]) {
    assert.equal(AuthorToolInputSchema.safeParse({ ...newRoomInput(), [key]: true }).success, false);
  }
});

test("natural-language root tool creates only default-policy room and requests authoring, never execution", async () => {
  const data = state(); const { harness, calls } = service(data);
  const result = await authorPlanFromTool(harness, newRoomInput(), context());
  assert.equal(result.status, "authoring"); assert.match(result.notice, /not execution/);
  assert.deepEqual(calls.map((item) => item.method), ["state", "createRoom", "authorPlan"]);
  assert.deepEqual(calls[1].input.policy, data.defaultPolicy);
  assert.equal(calls[2].input.goal, newRoomInput().goal);
  assert.equal(calls[2].roomId, "new-room"); assert.match(calls[2].input.requestId, /^[a-f0-9]{64}$/);
});

test("tool retries retain per-operation idempotency IDs, independent calls do not collide", async () => {
  const { harness, calls } = service(state());
  await authorPlanFromTool(harness, newRoomInput(), context());
  await authorPlanFromTool(harness, newRoomInput(), context());
  await authorPlanFromTool(harness, newRoomInput(), { ...context(), callId: "other-call" });
  const creates = calls.filter((call) => call.method === "createRoom");
  const authors = calls.filter((call) => call.method === "authorPlan");
  assert.equal(creates[0].input.requestId, creates[1].input.requestId);
  assert.equal(authors[0].input.requestId, authors[1].input.requestId);
  assert.notEqual(creates[0].input.requestId, authors[0].input.requestId);
  assert.notEqual(authors[0].input.requestId, authors[2].input.requestId);
});

test("existing room exact revision reaches kernel unchanged; nonexistent room never creates one implicitly", async () => {
  const data = state(); const { harness, calls } = service(data);
  const input = { roomId: data.rooms[0].id, expectedRoomRevision: 999, title: null, description: null, goal: "Write tests" };
  await authorPlanFromTool(harness, input, context());
  assert.equal(calls[1].input.expectedRoomRevision, 999); assert.equal(calls[1].method, "authorPlan");
  await assert.rejects(authorPlanFromTool(harness, { ...input, roomId: "unknown" }, context()), /Room not found/);
  assert.equal(calls.some((call) => call.method === "createRoom"), false);
});

test("delegated or aborted orchestration is refused before service access", async () => {
  const { harness, calls } = service(state()); const aborted = new AbortController(); aborted.abort();
  for (const ctx of [{ ...context(), delegated: true }, { ...context(), signal: aborted.signal }]) {
    await assert.rejects(authorPlanFromTool(harness, newRoomInput(), ctx));
    await assert.rejects(roomStateFromTool(harness, { roomId: null }, ctx));
  }
  assert.equal(calls.length, 0);
});

test("root room state excludes other rooms and exposes no approval choices", async () => {
  const data = state(); data.rooms.push({ ...data.rooms[0], id: "other-room", title: "Private other" });
  data.plans.push({ ...data.plans[0], id: "other-plan", roomId: "other-room", goal: "other-private-goal" });
  const { harness } = service(data);
  const scoped = await roomStateFromTool(harness, { roomId: data.rooms[0].id }, context());
  assert.equal("approvals" in scoped, false); assert.equal("pendingApprovalCount" in scoped, true);
  assert.doesNotMatch(JSON.stringify(scoped), /other-private-goal|other-plan|Private other/);
  const list = await roomStateFromTool(harness, { roomId: null }, context());
  assert.equal("plans" in list, false); assert.equal("rooms" in list ? list.rooms?.length : 0, 2);
  await assert.rejects(roomStateFromTool(harness, { roomId: "missing" }, context()), /not found/);
});

test("loopback delegation reuses frozen routes, fixed host, bearer headers, bounded deadline and no redirect", async () => {
  const data = state(); const { harness } = service(data);
  const authoring: Authoring = await harness.authorPlan(data.rooms[0].id, { requestId: "request", expectedRoomRevision: 1, goal: "Goal" });
  const prior = process.env.JARVIS_LOCAL_TOKEN; process.env.JARVIS_LOCAL_TOKEN = "x".repeat(40);
  try {
    const urls: string[] = [];
    const port = createLoopbackHarnessAgentPort(context().signal, async (url, init) => {
      urls.push(String(url)); assert.match(String(url), /^http:\/\/127\.0\.0\.1:39202\/v1\/harness\//);
      assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("Origin"), null);
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${"x".repeat(40)}`);
      assert.ok(init?.signal); assert.doesNotMatch(String(url), /token|secret/);
      if (String(url).endsWith("/state")) { assert.equal(init?.method, "GET"); return Response.json(data); }
      assert.equal(init?.method, "POST");
      return Response.json(String(url).endsWith("/author") ? authoring : data.rooms[0]);
    });
    await port.state(); await port.createRoom({ requestId: "request", title: "New", description: "", policy: data.defaultPolicy });
    await port.authorPlan(data.rooms[0].id, { requestId: "request", expectedRoomRevision: 1, goal: "Goal" });
    assert.equal(urls.length, 3);
    await assert.rejects(port.authorPlan("../approvals", { requestId: "request", expectedRoomRevision: 1, goal: "Goal" }));
  } finally { if (prior === undefined) delete process.env.JARVIS_LOCAL_TOKEN; else process.env.JARVIS_LOCAL_TOKEN = prior; }
});

test("loopback delegation rejects no-auth, unversioned state, and conflicts without leaking bridge response", async () => {
  const prior = process.env.JARVIS_LOCAL_TOKEN;
  try {
    delete process.env.JARVIS_LOCAL_TOKEN;
    await assert.rejects(createLoopbackHarnessAgentPort(context().signal, async () => { assert.fail(); }).state(), /unavailable/);
    process.env.JARVIS_LOCAL_TOKEN = "x".repeat(40);
    await assert.rejects(createLoopbackHarnessAgentPort(context().signal, async () => Response.json({ ...state(), version: 99 })).state());
    await assert.rejects(createLoopbackHarnessAgentPort(context().signal, async () => new Response("private detail", { status: 409 })).state(),
      (error: any) => /HTTP 409/.test(error.message) && !error.message.includes("private detail"));
  } finally { if (prior === undefined) delete process.env.JARVIS_LOCAL_TOKEN; else process.env.JARVIS_LOCAL_TOKEN = prior; }
});
