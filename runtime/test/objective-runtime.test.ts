import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObjectiveRuntime, objectiveAdapters } from "../bridge/objective-runtime.ts";
import { ObjectiveService, ObjectiveDispatchRejected } from "../bridge/objectives/index.ts";
import { KnowledgeService } from "../bridge/knowledge/index.ts";
import { ResearchService } from "../bridge/research/index.ts";
import { defaultRoomPolicy, type Plan, type Run, type Room } from "../bridge/harness-contracts/domain.ts";
import type { HarnessService } from "../bridge/harness-contracts/service.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-objective-runtime-")); let calls = 0, unknown = false;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture/model", type: "language", pricing: { input: "0.000001", output: "0.000002" } }] });
    calls++; const body = JSON.parse(String(init!.body)), input = JSON.parse(body.messages[1].content), evidence = input.evidence[0];
    const content = input.draft ? { verdict: "supported_with_limits", summary: "Quote is present in supplied evidence.", issues: [] } :
      { title: "Research result", markdown: "Bounded source-backed review.", claims: [{ text: "The source reports twelve units.", status: "supported", citations: [{ passageId: evidence.passageId, quote: "The experiment measured twelve units." }] }], unresolved: [], checks: [] };
    return Response.json({ model: "fixture/model", ...(unknown ? {} : { usage: { prompt_tokens: 100, completion_tokens: 100 } }),
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }] });
  }) as typeof fetch;
  const knowledge = await KnowledgeService.open({ dataDirectory: directory, enabled: true });
  const grant = knowledge.createGrant({ projectId: "project-a", resourceKind: "file", resourceId: "paper", label: "Paper", operations: ["read_document"], cloudAllowed: true, expiresAt: null });
  const imported = await knowledge.importSource({ projectId: "project-a", grantId: grant.id, resourceId: "paper", filename: "paper.txt", title: "Experiment", mediaType: "text/plain",
    bytesBase64: Buffer.from("The experiment measured twelve units.").toString("base64") });
  const research = await ResearchService.open({ dataDirectory: directory, enabled: true, knowledge, model: "fixture/model", fetch: fetcher, apiKey: "fixture-key" });
  const runtime = await createObjectiveRuntime({ dataDirectory: directory, enabled: true, research });
  t.after(async () => { await runtime.service.close(); await research.close(); knowledge.close(); await rm(directory, { recursive: true, force: true }); });
  const create = () => ({ version: 1, requestId: "work-one", projectId: "project-a", title: "Check paper", goal: "Review the experiment",
    steps: [{ id: "review", authority: "research", prompt: "Review the experiment", estimatedUsd: 1, maxWallTimeMs: 60_000,
      parameters: { sourceVersionIds: [imported.source.id] } }] });
  return { directory, knowledge, grant, research, runtime, create, calls: () => calls, unknown() { unknown = true; } };
}

test("owner objective route runs real research authority under reserved caps and persists observed completion", async t => {
  const f = await fixture(t), url = new URL("http://localhost/v1/objectives"), owner = { nativeAuthenticated: false, ownerAuthenticated: true };
  await assert.rejects(f.runtime.route("POST", url, f.create(), { nativeAuthenticated: false, projectId: "project-a" }), /owner/);
  const response = await f.runtime.route("POST", url, f.create(), owner); assert.equal(response!.status, 201);
  const id = (response!.body as { id: string }).id; assert.equal(f.calls(), 0);
  await f.runtime.service.dispatch(); await f.runtime.service.drain();
  const child = f.runtime.service.get(id, "project-a").attempts[0].child!; assert.equal(child.authority, "research");
  await f.research.wait((child as { runId: string }).runId); await f.runtime.service.reconcile();
  const completed = f.runtime.service.get(id, "project-a"); assert.equal(completed.status, "completed"); assert.equal(f.calls(), 2);
  assert.ok(completed.budget.spentUsd > 0 && completed.budget.spentUsd < 1); assert.equal(completed.budget.reservedUsd, 0);
  assert.equal(f.research.result((child as { runId: string }).runId, "project-a").deliverable.citationCheck, "locators_and_quotes_verified");
  const own = await f.runtime.route("GET", url, undefined, owner); assert.equal((own!.body as any).objectives.length, 1);
  await assert.rejects(f.runtime.route("GET", new URL(`http://localhost/v1/objectives/${id}?projectId=project-a`), undefined, { nativeAuthenticated: false, projectId: "other" }), /scope/);
  await f.runtime.service.close();
  const restarted = await ObjectiveService.open({ dataDirectory: f.directory, enabled: true, adapters: objectiveAdapters(f.research) });
  assert.equal(restarted.get(id, "project-a").status, "completed"); assert.equal(await restarted.dispatch(), 0); assert.equal(f.calls(), 2); await restarted.close();
});

test("revoked research access fails before dispatch without charging, while uncertain paid usage retains its reservation", async t => {
  await t.test("revoked", async t => {
    const f = await fixture(t); f.knowledge.revokeGrant(f.grant.id, f.grant.revision);
    const objective = await f.runtime.service.create(f.create()); await f.runtime.service.dispatch(); await f.runtime.service.drain();
    const stopped = f.runtime.service.get(objective.id, "project-a"); assert.equal(stopped.status, "failed");
    assert.equal(stopped.budget.spentUsd, 0); assert.equal(stopped.budget.reservedUsd, 0); assert.equal(f.calls(), 0);
  });
  await t.test("uncertain", async t => {
    const f = await fixture(t); f.unknown(); const objective = await f.runtime.service.create(f.create());
    await f.runtime.service.dispatch(); await f.runtime.service.drain(); const child = f.runtime.service.get(objective.id, "project-a").attempts[0].child!;
    await f.research.wait((child as { runId: string }).runId); await f.runtime.service.reconcile();
    const stopped = f.runtime.service.get(objective.id, "project-a"); assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.budget.reservedUsd, 1); assert.equal(f.calls(), 1); assert.equal(await f.runtime.service.dispatch(), 0);
  });
});

test("room adapter requires exact accepted plan and enforceable cost/time limits, never accepts a draft", async () => {
  const policy = defaultRoomPolicy(`sha256:${"1".repeat(64)}`); policy.runBudget.estimatedUsdLimit = 1; policy.runBudget.maxWallTimeMs = 60_000;
  const room = { id: "room-a", status: "active", policy } as Room;
  const plan = { id: "plan-a", roomId: room.id, status: "accepted", digest: "2".repeat(64), revision: 4, policyRevision: policy.revision,
    nodes: [{ limits: { estimatedUsdLimit: 1 } }] } as unknown as Plan;
  let starts = 0, accepts = 0;
  const run = { id: "run-a", roomId: room.id, planId: plan.id, planDigest: plan.digest, status: "running", cancelConfirmed: false,
    usage: { accounting: "measured", estimatedUsd: 0, reservedTokens: 0 }, revision: 1 } as Run;
  const harness = { async state() { return { ready: true, worker: { available: true }, rooms: [room], plans: [plan], runs: [run] }; },
    async startRun() { starts++; return run; }, async acceptPlan() { accepts++; throw new Error("Forbidden"); } } as unknown as HarnessService;
  const adapter = objectiveAdapters(undefined, harness)!.harness!;
  const request = { objectiveId: "objective-a", projectId: room.id, attemptId: "attempt-a", checkpoint: null, answers: [], step: {
    id: "build", authority: "harness" as const, prompt: "Build accepted plan", parameters: { roomId: room.id, planId: plan.id, expectedPlanRevision: plan.revision, planDigest: plan.digest! },
    estimatedUsd: 1, maxWallTimeMs: 60_000, dependsOn: [] } };
  const result = await adapter.dispatch(request, new AbortController().signal); assert.equal(result.ref.authority, "harness"); assert.equal(starts, 1); assert.equal(accepts, 0);
  plan.status = "draft"; await assert.rejects(adapter.dispatch(request, new AbortController().signal), ObjectiveDispatchRejected); assert.equal(starts, 1);
  plan.status = "accepted"; room.policy.runBudget.estimatedUsdLimit = null;
  await assert.rejects(adapter.dispatch(request, new AbortController().signal), ObjectiveDispatchRejected); assert.equal(starts, 1);
  room.policy.runBudget.estimatedUsdLimit = 1;
  await assert.rejects(adapter.dispatch({ ...request, projectId: "other" }, new AbortController().signal), ObjectiveDispatchRejected);
});
