import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ObjectiveService, type ChildObservation, type ObjectiveAdapter, type ObjectiveDispatch } from "../bridge/objectives/index.ts";
import { ObjectiveStore } from "../bridge/objectives/store.ts";

const step = (id = "collect", dependsOn: string[] = [], estimatedUsd = 1) => ({ id, authority: "research", prompt: "Review the evidence", dependsOn, estimatedUsd, maxWallTimeMs: 60_000 });
const input = (requestId = "request-one", steps = [step()]) => ({ version: 1, requestId, projectId: "project-a", title: "Evidence review", goal: "Review the available evidence", steps });
const observation = (dispatch: ObjectiveDispatch, status: ChildObservation["status"] = "completed", estimatedUsd: number | null = .25): ChildObservation => ({
  ref: { authority: "research", projectId: dispatch.projectId, runId: dispatch.attemptId }, status,
  accounting: estimatedUsd === null ? "unknown" : "measured", estimatedUsd, cancelConfirmed: status === "cancelled", detail: null,
});
class FixtureAdapter implements ObjectiveAdapter {
  calls: ObjectiveDispatch[] = []; values = new Map<string, ChildObservation>(); cancels = 0;
  status: ChildObservation["status"] = "completed"; cost: number | null = .25;
  async dispatch(value: ObjectiveDispatch) { this.calls.push(value); const result = observation(value, this.status, this.cost); this.values.set(value.attemptId, result); return result; }
  async inspect(ref: ChildObservation["ref"]) { return structuredClone(this.values.get("runId" in ref ? ref.runId : "")!); }
  async cancel(ref: ChildObservation["ref"]): Promise<ChildObservation> { this.cancels++; return { ...await this.inspect(ref), status: "cancelled", cancelConfirmed: true }; }
}
async function fixture(t: TestContext, store?: ObjectiveStore) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-objective-test-"));
  let clock = new Date("2026-01-01T00:00:00.000Z"); const adapter = new FixtureAdapter();
  const options = { dataDirectory: directory, enabled: true, adapters: { research: adapter }, now: () => clock, ...(store ? { store } : {}) };
  let service = await ObjectiveService.open(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, adapter, get service() { return service; }, time(value: string) { clock = new Date(value); },
    async reopen() { await service.close(); service = await ObjectiveService.open({ ...options, store: undefined }); } };
}

test("objectives durably deduplicate requests, enforce project/CAS and publish only observed metadata", async t => {
  const f = await fixture(t), events: unknown[] = []; f.service.subscribe(event => events.push(event)); f.service.subscribe(() => { throw new Error("UI listener"); });
  const first = await f.service.create(input()), same = await f.service.create(input());
  assert.equal(first.id, same.id); assert.equal(events.length, 1);
  assert.equal(first.deadlineAt, "2026-01-08T00:00:00.000Z");
  await assert.rejects(f.service.create({ ...input(), goal: "Different goal" }), /reused/);
  assert.throws(() => f.service.get(first.id, "project-b"), /not found/);
  const results = await Promise.allSettled([f.service.pause(first.id, { expectedRevision: 1 }, "project-a"), f.service.revise(first.id, { expectedRevision: 1, title: "Changed" }, "project-a")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(events.length, 2); assert.doesNotMatch(JSON.stringify(events), /Review the evidence|parameters|goal/);
  const info = await stat(join(f.directory, "objectives", "objectives.sqlite")); assert.equal(info.mode & 0o077, 0);
  await f.reopen(); assert.equal(f.service.get(first.id, "project-a").status, "paused");
});

test("scheduler reserves before dispatch, runs at most two children and observes prerequisites", async t => {
  const f = await fixture(t); f.adapter.status = "running";
  const objective = await f.service.create(input("graph", [step("a"), step("b"), step("c", ["a"])]));
  assert.equal(await f.service.dispatch(), 2); await f.service.drain();
  assert.equal(f.adapter.calls.length, 2); assert.equal(f.service.readiness().activeWorkers, 2);
  for (const call of f.adapter.calls) assert.equal(f.service.get(objective.id, "project-a").attempts.some(attempt => attempt.id === call.attemptId), true);
  assert.equal(await f.service.dispatch(), 0);
  const first = f.adapter.calls[0]; f.adapter.values.set(first.attemptId, observation(first));
  await f.service.reconcile(); assert.equal(await f.service.dispatch(), 1); await f.service.drain();
  assert.equal(f.adapter.calls.at(-1)!.step.id, "c");
  assert.equal(f.service.get(objective.id, "project-a").budget.reservedUsd, 2);
  await assert.rejects(f.service.revise(objective.id, { expectedRevision: f.service.get(objective.id, "project-a").revision, steps: [step("a", [], 2)] }, "project-a"), /immutable/);
});

test("stored wake times, pause and empty plans do not invoke an adapter", async t => {
  const f = await fixture(t);
  const future = await f.service.create({ ...input(), wakeAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(await f.service.dispatch(), 0); assert.equal(f.adapter.calls.length, 0);
  await f.service.create(input("empty", []));
  await f.service.pause(future.id, { expectedRevision: future.revision }, "project-a");
  f.time("2026-01-02T01:00:00.000Z"); assert.equal(await f.service.dispatch(), 0);
  await f.service.resume(future.id, { expectedRevision: f.service.get(future.id, "project-a").revision }, "project-a");
  assert.equal(await f.service.dispatch(), 1); await f.service.drain();
  assert.equal(f.service.get(future.id, "project-a").status, "completed");
});

test("global scheduler Stop survives restart and explicit recovery permits only fresh work", async t => {
  const f = await fixture(t), prior = await f.service.create(input("before-stop"));
  await f.service.stop(); assert.equal(f.service.get(prior.id, "project-a").status, "cancelled");
  await f.reopen(); f.service.startLoop(100);
  assert.equal(f.service.readiness().stopped, true);
  const fresh = await f.service.create(input("fresh-work")); assert.equal(await f.service.dispatch(), 0); assert.equal(f.adapter.calls.length, 0);
  await f.service.resumeScheduler(); await f.service.dispatch(); await f.service.drain();
  assert.equal(f.adapter.calls.length, 1); assert.equal(f.adapter.calls[0].objectiveId, fresh.id);
  assert.equal(f.service.get(prior.id, "project-a").status, "cancelled"); assert.equal(f.service.readiness().stopped, false);
  await f.service.stop(); await f.reopen(); assert.equal(f.service.readiness().stopped, true);
});

test("cloud Stop preserves paused goals and exact cancelled children without reviving old work", async t => {
  const f = await fixture(t); f.adapter.status = "running";
  const active = await f.service.create(input("active-goal")); await f.service.dispatch(); await f.service.drain();
  const pending = await f.service.create(input("future-goal"));
  await f.service.pauseAll();
  const paused = f.service.get(active.id, "project-a");
  assert.equal(paused.status, "paused"); assert.equal(paused.pauseRequested, true); assert.equal(paused.attempts[0].status, "cancelled");
  assert.equal(paused.attempts[0].cancelConfirmed, true); assert.equal(paused.goal, active.goal);
  await f.reopen(); assert.equal(f.service.readiness().stopped, true); assert.equal(f.service.get(active.id, "project-a").status, "paused");
  await f.service.resumeScheduler();
  await assert.rejects(f.service.resume(active.id, { expectedRevision: f.service.get(active.id, "project-a").revision }, "project-a"), /fresh objective.*reviewed plan/);
  await f.service.resume(pending.id, { expectedRevision: f.service.get(pending.id, "project-a").revision }, "project-a");
  await f.service.dispatch(); await f.service.drain();
  assert.equal(f.adapter.calls.length, 2); assert.equal(f.adapter.calls[1].objectiveId, pending.id);
  assert.equal(f.service.get(active.id, "project-a").status, "paused");
});

test("objective and UTC daily/monthly caps include unknown reservations and immutable settlements", async t => {
  const f = await fixture(t); const objective = await f.service.create(input("budget", []));
  const a = await f.service.reserve({ requestId: "a", objectiveId: objective.id, projectId: "project-a", authority: "research", estimatedUsd: 5 });
  await f.service.settle(a.id, { accounting: "unknown", estimatedUsd: null });
  await assert.rejects(f.service.reserve({ requestId: "b", objectiveId: objective.id, projectId: "project-a", authority: "research", estimatedUsd: .000001 }), /objective/);
  const b = await f.service.reserve({ requestId: "c", projectId: "project-a", authority: "phone", estimatedUsd: 5 });
  await assert.rejects(f.service.reserve({ requestId: "d", projectId: "project-a", authority: "phone", estimatedUsd: .01 }), /Daily/);
  await f.service.settle(b.id, { accounting: "measured", estimatedUsd: 0 });
  await assert.rejects(f.service.settle(b.id, { accounting: "measured", estimatedUsd: 1 }), /rewritten/);
  await f.service.reserve({ requestId: "e", projectId: "project-a", authority: "phone", estimatedUsd: 5 });
  for (let day = 2; day <= 30; day++) {
    f.time(`2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`);
    for (let i = 0; i < 2; i++) await f.service.reserve({ requestId: `day-${day}-${i}`, projectId: "project-a", authority: "phone", estimatedUsd: 5 });
  }
  f.time("2026-01-31T00:00:00.000Z");
  assert.equal(f.service.readiness().monthlyCommittedUsd, 300);
  await assert.rejects(f.service.reserve({ requestId: "over-month", projectId: "project-a", authority: "phone", estimatedUsd: .01 }), /monthly/);
  const controlPoll = await f.service.reserve({ requestId: "free-control-poll", projectId: "project-a", authority: "integration:telegramRequestUsd", estimatedUsd: 0 });
  await f.service.settle(controlPoll.id, { accounting: "measured", estimatedUsd: 0 });
  assert.equal(f.service.readiness().monthlyCommittedUsd, 300, "Verified zero-cost control remains available to receive Stop at exhausted caps");
  f.time("2026-02-01T00:00:00.000Z"); await f.service.reserve({ requestId: "next-month", projectId: "project-a", authority: "phone", estimatedUsd: 1 });
  assert.equal(f.service.readiness().monthlyCommittedUsd, 1);
  await assert.rejects(f.service.reserve({ requestId: "still-old-objective", objectiveId: objective.id, projectId: "project-a", authority: "research", estimatedUsd: .01 }), /objective/);
});

test("restart observes exact retained children and never blindly repeats dispatch", async t => {
  const f = await fixture(t); f.adapter.status = "running";
  const objective = await f.service.create(input()); await f.service.dispatch(); await f.service.drain();
  const call = f.adapter.calls[0]; f.adapter.values.set(call.attemptId, observation(call, "unknown", null));
  await f.reopen();
  assert.equal(f.service.get(objective.id, "project-a").status, "interrupted");
  assert.equal(await f.service.dispatch(), 0); assert.equal(f.adapter.calls.length, 1);
  f.adapter.values.set(call.attemptId, observation(call)); await f.service.reconcile();
  assert.equal(f.service.get(objective.id, "project-a").status, "completed");
  assert.equal(f.service.get(objective.id, "project-a").budget.spentUsd, .25);
  assert.equal(f.service.readiness().activeWorkers, 0);
});

test("lost paid dispatch receipt retains its slot and reservation across restart", async t => {
  const f = await fixture(t); f.adapter.dispatch = async () => { throw new Error("connection lost after paid request"); };
  const objective = await f.service.create(input()); await f.service.dispatch(); await f.service.drain();
  assert.equal(f.service.get(objective.id, "project-a").attempts[0].child, null);
  assert.equal(f.service.readiness().unknownReservations, 1); await f.reopen();
  assert.equal(await f.service.dispatch(), 0); assert.equal(f.service.readiness().activeWorkers, 1);
  await assert.rejects(f.service.resume(objective.id, { expectedRevision: f.service.get(objective.id, "project-a").revision }, "project-a"), /unknown/);
});

test("question answers bind objective revision, question identity, expiry and durable inbox", async t => {
  const f = await fixture(t); const objective = await f.service.create(input());
  const waiting = await f.service.ask(objective.id, { id: "q-one", revision: 1, prompt: "Which comparison?", expiresAt: "2026-01-03T00:00:00.000Z" }, "project-a", objective.revision);
  assert.equal(await f.service.dispatch(), 0);
  await assert.rejects(f.service.answer(objective.id, { expectedRevision: waiting.revision, questionId: "wrong", questionRevision: 1, answer: "First" }, "project-a"), /binding/);
  const answer = { expectedRevision: waiting.revision, questionId: "q-one", questionRevision: 1, answer: "Compare the first source" };
  await f.service.answer(objective.id, answer, "project-a"); await assert.rejects(f.service.answer(objective.id, answer, "project-a"), /revision/);
  await f.reopen(); await f.service.dispatch(); await f.service.drain();
  assert.equal(f.adapter.calls[0].answers[0].answer, answer.answer);
});

test("failed durable writes publish no event, no memory mutation and no child dispatch", async t => {
  class FailingStore extends ObjectiveStore { fail = false; override save(value: Parameters<ObjectiveStore["save"]>[0]) { if (this.fail) throw new Error("disk full"); super.save(value); } }
  const store = new FailingStore(), f = await fixture(t, store), events: unknown[] = [];
  const objective = await f.service.create(input()); f.service.subscribe(event => events.push(event)); store.fail = true;
  await assert.rejects(f.service.dispatch(), /persistence/);
  assert.equal(f.adapter.calls.length, 0); assert.equal(events.length, 0);
  assert.equal(f.service.get(objective.id, "project-a").attempts.length, 0);
  assert.equal(f.service.readiness().ready, false); store.fail = false;
  await f.reopen(); assert.equal(f.service.get(objective.id, "project-a").attempts.length, 0);
});

test("Stop preserves cancellation intent when observation is uncertain and late success cannot restart work", async t => {
  const f = await fixture(t); f.adapter.status = "running"; const objective = await f.service.create(input());
  await f.service.dispatch(); await f.service.drain();
  f.adapter.cancel = async ref => ({ ...await f.adapter.inspect(ref), status: "unknown", accounting: "unknown", estimatedUsd: null });
  await assert.rejects(f.service.stop(objective.id, { expectedRevision: f.service.get(objective.id, "project-a").revision }, "project-a"), /unconfirmed/);
  assert.equal(f.service.get(objective.id, "project-a").cancelRequested, true);
  f.adapter.cancel = async ref => ({ ...await f.adapter.inspect(ref), status: "cancelled", cancelConfirmed: true, accounting: "measured", estimatedUsd: .25 });
  await f.service.reconcile(); assert.equal(f.service.get(objective.id, "project-a").status, "cancelled");
  assert.equal(await f.service.dispatch(), 0); assert.equal(f.service.readiness().activeWorkers, 0);
});

test("horizon expiry does not extend child budgets and checkpoint references preserve authority", async t => {
  const f = await fixture(t); f.adapter.status = "running"; const objective = await f.service.create(input());
  await assert.rejects(f.service.create({ ...input("too-long"), deadlineAt: "2026-01-09T00:00:00.000Z" }), /seven days/);
  await assert.rejects(f.service.create(input("cycle", [step("a", ["b"]), step("b", ["a"])])), /cycle/);
  await f.service.dispatch(); await f.service.drain();
  const checkpoint = { version: 1, id: "checkpoint-1", objectiveId: objective.id, projectId: "project-a", createdAt: "2026-01-01T00:00:00.000Z", summary: "Observed evidence", childRefs: [f.service.get(objective.id, "project-a").attempts[0].child], artifactRefs: [] };
  await f.service.checkpoint(objective.id, checkpoint, "project-a");
  await assert.rejects(f.service.checkpoint(objective.id, { ...checkpoint, projectId: "other" }, "project-a"), /references/);
  f.time("2026-01-01T00:02:00.000Z"); await f.service.reconcile(); assert.equal(f.adapter.cancels, 1);
  assert.equal(f.service.get(objective.id, "project-a").attempts[0].status, "cancelled");
});

test("unsupported persisted schemas fail closed without erasing prior data", async t => {
  const f = await fixture(t); await f.service.create(input()); await f.service.close();
  const database = new DatabaseSync(join(f.directory, "objectives", "objectives.sqlite")); database.exec("PRAGMA user_version=9"); database.close();
  await assert.rejects(ObjectiveService.open({ dataDirectory: f.directory, enabled: true }), /Unsupported/);
  const verify = new DatabaseSync(join(f.directory, "objectives", "objectives.sqlite")); assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM snapshot").get()!.count, 1); verify.close();
});
