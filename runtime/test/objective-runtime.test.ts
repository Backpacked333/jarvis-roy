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
import { objectiveResearchGoal } from "../bridge/objectives/continuation.ts";
import type { ObjectiveDispatch } from "../bridge/objectives/contracts.ts";
import type { ObjectiveDeliverable } from "../bridge/objectives/deliverable.ts";

async function fixture(t: TestContext, harness?: HarnessService) {
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
  const runtime = await createObjectiveRuntime({ dataDirectory: directory, enabled: true, research, harness });
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

test("research continuation preserves exact current goal and answered question binding without replaying unlineaged summaries", () => {
  const input: ObjectiveDispatch = { objectiveId: "objective", projectId: "project-a", attemptId: "attempt", step: {
    id: "review", authority: "research", prompt: "Compare the twelve-unit finding", dependsOn: [], parameters: {}, estimatedUsd: 1, maxWallTimeMs: 60_000 },
    answers: [{ id: "answer", objectiveId: "objective", questionId: "question", questionRevision: 3, questionPrompt: "Which baseline?", answer: "Use 2024.", at: "2026-11-09T00:00:00.000Z" }],
    predecessors: [{ authority: "research", projectId: "project-a", runId: "prior" }],
    checkpoint: { version: 1, id: "checkpoint", objectiveId: "objective", projectId: "project-a", createdAt: "2026-11-09T00:00:00.000Z",
      summary: "PRIVATE REVOKED SOURCE PROSE", verification: "unverified_summary", childRefs: [], artifactRefs: [{ id: "artifact", digest: "b".repeat(64) }] } };
  const goal = objectiveResearchGoal(input);
  assert.ok(goal.startsWith(input.step.prompt + "\n\n")); assert.ok(goal.length <= 8_000);
  assert.match(goal, /Which baseline\?/); assert.match(goal, /Use 2024/); assert.match(goal, /"questionRevision":3/);
  assert.match(goal, /"runId":"prior"/); assert.match(goal, /"id":"artifact"/); assert.match(goal, /unverified_summary/);
  assert.ok(!goal.includes(input.checkpoint!.summary));
  assert.throws(() => objectiveResearchGoal({ ...input, step: { ...input.step, prompt: "x".repeat(8_001) } }), ObjectiveDispatchRejected);
  assert.throws(() => objectiveResearchGoal({ ...input, step: { ...input.step, prompt: "x".repeat(7_999) } }), ObjectiveDispatchRejected);
});

test("research then accepted worker then review produces a scoped current-access deliverable with real authority references", async t => {
  const image = `sha256:${"1".repeat(64)}`, policy = defaultRoomPolicy(image); policy.runBudget.estimatedUsdLimit = 1; policy.runBudget.maxWallTimeMs = 50_000;
  const room = { id: "project-a", status: "active", policy } as Room;
  const plan = { id: "plan-a", roomId: room.id, status: "accepted", digest: "2".repeat(64), revision: 4, policyRevision: policy.revision,
    nodes: [{ limits: { estimatedUsdLimit: 1 } }] } as unknown as Plan;
  const workerRun = { id: "run-a", roomId: room.id, planId: plan.id, planRevision: plan.revision, planDigest: plan.digest, policy, status: "completed", cancelConfirmed: false,
    nodes: [{ nodeId: "calculate", artifactIds: ["artifact-a"] }], usage: { accounting: "measured", estimatedUsd: 0.01, reservedTokens: 0 }, revision: 2 } as unknown as Run;
  const artifact = { version: 1, id: "artifact-a", roomId: room.id, runId: workerRun.id, nodeId: "calculate", attemptId: "worker-attempt", planDigest: plan.digest,
    digest: "a".repeat(64), createdAt: "2026-11-09T00:00:00.000Z", files: [{ path: "calculation.txt", sha256: "b".repeat(64), bytes: 2, mediaType: "text/plain" }],
    inputDigests: [], verification: "passed", verificationSummary: `exit=0; output-sha256=${"c".repeat(64)}; command=python calculation.py` };
  let starts = 0;
  const harness = { async state() { return { ready: true, worker: { available: true }, rooms: [room], plans: [plan], runs: starts ? [workerRun] : [], artifacts: [artifact] }; },
    async startRun() { starts++; return workerRun; } } as unknown as HarnessService;
  const f = await fixture(t, harness), input = f.create(), review = input.steps[0];
  const objective = await f.runtime.service.create({ ...input, steps: [review,
    { id: "calc", authority: "harness", prompt: "Run the accepted calculation", estimatedUsd: 1, maxWallTimeMs: 60_000, dependsOn: [review.id],
      parameters: { roomId: room.id, planId: plan.id, expectedPlanRevision: plan.revision, planDigest: plan.digest } },
    { ...review, id: "final", dependsOn: ["calc"], prompt: "Review the exact predecessor results and limits" }] });
  for (let step = 0; step < 3; step++) {
    assert.equal(await f.runtime.service.dispatch(), 1); await f.runtime.service.drain();
    const current = f.runtime.service.get(objective.id, "project-a"), child = current.attempts.at(-1)!.child!;
    assert.ok(child, `Step ${step}: ${JSON.stringify(current.attempts.at(-1))}`);
    if (child.authority === "research") await f.research.wait(child.runId);
    await f.runtime.service.reconcile();
    if (step === 0) {
      const settled = f.runtime.service.get(objective.id, "project-a");
      const question = await f.runtime.service.ask(objective.id, { id: "baseline", revision: 1, prompt: "Which baseline?", expiresAt: new Date(Date.now() + 60_000).toISOString() }, "project-a", settled.revision);
      await f.runtime.service.answer(objective.id, { expectedRevision: question.revision, questionId: "baseline", questionRevision: 1, answer: "Use 2024." }, "project-a");
    }
  }
  const completed = f.runtime.service.get(objective.id, "project-a"); assert.equal(completed.status, "completed"); assert.equal(starts, 1); assert.equal(f.calls(), 4);
  const final = completed.attempts.at(-1)!.child!; assert.equal(final.authority, "research");
  if (final.authority === "research") { const goal = f.research.get(final.runId, "project-a").goal; assert.match(goal, /Which baseline/); assert.match(goal, /Use 2024/); assert.match(goal, /"runId":"run-a"/); }
  const url = new URL(`http://localhost/v1/objectives/${objective.id}/deliverable?projectId=project-a`);
  await assert.rejects(f.runtime.route("GET", url, undefined, { nativeAuthenticated: false, projectId: "project-a" }), /owner/);
  const packet = (await f.runtime.route("GET", url, undefined, { nativeAuthenticated: true }))!.body as ObjectiveDeliverable;
  assert.equal(packet.research.length, 2); assert.equal(packet.workers.length, 1); assert.equal(packet.workers[0].imageDigest, image);
  assert.equal(packet.workers[0].artifacts[0].verificationSummary, artifact.verificationSummary); assert.match(packet.workers[0].artifacts[0].contentPath, /artifact-a\/content$/);
  assert.match(packet.verification, /research_claims_and_model_critique_require_review/); assert.ok(packet.budget.bytes <= packet.budget.maxBytes);
  f.knowledge.revokeGrant(f.grant.id, f.grant.revision);
  const revoked = await f.runtime.deliverable(objective.id, "project-a"); assert.equal(revoked.research.length, 0); assert.equal(revoked.workers.length, 1);
  assert.equal(revoked.unavailable.filter(value => value.reason === "access_unavailable").length, 2);
  assert.ok(!JSON.stringify(revoked).includes("The source reports twelve units"));
  assert.ok(f.runtime.service.readiness().sequence > 0);
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
