import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeService } from "../bridge/knowledge/index.ts";
import { ResearchService, StartResearchSchema } from "../bridge/research/index.ts";
import { ResearchStore } from "../bridge/research/store.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-research-"));
  const calls: { url: string; body?: any }[] = [];
  let alter: ((stage: number, body: any, response: any) => any) | undefined;
  let onCall: ((stage: number, signal: AbortSignal) => Promise<void> | void) | undefined;
  let modelCalls = 0;
  const fetcher = (async (url: any, init: any) => {
    const address = String(url), body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: address, body });
    if (address.endsWith("/models")) return Response.json({ data: [{ id: "fixture/model", type: "language", pricing: { input: "0.000001", output: "0.000002" } }] });
    if (address.startsWith("https://api.crossref.org/works")) return Response.json({ message: { items: [{ DOI: "10.1000/test", title: ["Energy result"], abstract: "The experiment measured twelve units." }] } });
    if (address.startsWith("https://export.arxiv.org")) return new Response('<feed><entry><id>https://arxiv.org/abs/2601.12345</id><title>Energy experiment</title><summary>The experiment measured twelve units.</summary></entry></feed>');
    assert.equal(address, "https://ai-gateway.vercel.sh/v1/chat/completions");
    const stage = ++modelCalls; await onCall?.(stage, init.signal); init.signal.throwIfAborted();
    const packet = JSON.parse(body.messages[1].content), item = packet.evidence[0];
    const content = stage === 1 ? { title: "Evidence brief", markdown: "A bounded synthesis of supplied evidence.",
      claims: [{ text: item.extraction === "metadata_only" ? "The abstract reports a measured result." : "The source reports a measured result.",
        status: "supported", citations: [{ passageId: item.passageId, quote: item.text.slice(0, 60) }] }], unresolved: ["External replication remains unverified."], checks: [] } :
      { verdict: "supported_with_limits", summary: "The quoted passage supports this bounded statement; no external replication was checked.", issues: [] };
    const response = { model: "fixture/model", usage: { prompt_tokens: 300, completion_tokens: 100 }, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }] };
    return Response.json(alter ? alter(stage, packet, response) : response);
  }) as typeof fetch;
  const knowledge = await KnowledgeService.open({ dataDirectory: directory, enabled: true, fetch: fetcher });
  const grant = knowledge.createGrant({ projectId: "project-1", resourceKind: "file", resourceId: "document-1", label: "Selected paper",
    operations: ["read_document"], cloudAllowed: true, expiresAt: null });
  const imported = await knowledge.importSource({ projectId: "project-1", grantId: grant.id, resourceId: "document-1", title: "Experiment",
    filename: "experiment.txt", mediaType: "text/plain", bytesBase64: Buffer.from("The experiment measured twelve units. A second independent replication has not been performed.").toString("base64") });
  const options = { dataDirectory: directory, knowledge, model: "fixture/model", fetch: fetcher, apiKey: "fixture-test-key", enabled: true };
  let service = await ResearchService.open(options);
  const input = () => ({ requestId: randomUUID(), projectId: "project-1", goal: "Explain the experiment", providers: [], sourceVersionIds: [imported.source.id] });
  return { directory, knowledge, grant, imported, calls, input, options, get service() { return service; },
    modelCalls: () => modelCalls, alter(value: typeof alter) { alter = value; }, onCall(value: typeof onCall) { onCall = value; },
    async reopen() { service = await ResearchService.open(options); },
    async cleanup() { await service.close(); knowledge.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("research performs separate synthesis and critique calls, verifies quotes and persists a scoped deliverable", async () => {
  const f = await fixture();
  try {
    const progress: string[] = []; f.service.subscribe(run => progress.push(run.status));
    const input = f.input(), started = await f.service.start(input); await f.service.wait(started.id);
    const completed = f.service.get(started.id, "project-1"), result = f.service.result(started.id, "project-1");
    assert.equal(completed.status, "completed"); assert.equal(completed.modelCalls, 2); assert.equal(f.modelCalls(), 2);
    assert.equal(completed.reservedTokens, 0); assert.equal(completed.accounting, "estimated");
    assert.equal(result.deliverable.citationCheck, "locators_and_quotes_verified");
    assert.equal(result.critique?.verdict, "supported_with_limits"); assert.match(result.reviewAuthority, /not_independent/);
    const requests = f.calls.filter(call => call.body); assert.match(requests[0].body.messages[0].content, /Produce a research draft/);
    assert.match(requests[1].body.messages[0].content, /Independently critique/);
    assert.equal(JSON.parse(requests[1].body.messages[1].content).draft.title, "Evidence brief");
    assert.ok(progress.indexOf("synthesizing") < progress.indexOf("critiquing"));
    assert.equal((await f.service.start(input)).id, started.id); assert.equal(f.modelCalls(), 2);
    assert.throws(() => f.service.result(started.id, "project-2"), /not found/);
  } finally { await f.cleanup(); }
});

test("critic disagreement demotes claims and preserves visible review limitations", async () => {
  const f = await fixture();
  try {
    f.alter((stage, _packet, response) => {
      if (stage === 2) response.choices[0].message.content = JSON.stringify({ verdict: "needs_revision", summary: "The scope overstates the evidence.",
        issues: [{ claimIndex: 0, severity: "unsupported", explanation: "Independent replication is missing." }] });
      return response;
    });
    const run = await f.service.start(f.input()); await f.service.wait(run.id);
    const result = f.service.result(run.id, "project-1");
    assert.equal(result.deliverable.claims[0].status, "unresolved"); assert.match(result.deliverable.markdown, /needs review/);
    assert.ok(result.deliverable.unresolved.includes("Independent replication is missing."));
  } finally { await f.cleanup(); }
});

test("fabricated citations fail before publication and are not substituted with model claims", async () => {
  const f = await fixture();
  try {
    f.alter((stage, _packet, response) => {
      if (stage === 1) { const draft = JSON.parse(response.choices[0].message.content); draft.claims[0].citations[0].quote = "A fabricated measurement"; response.choices[0].message.content = JSON.stringify(draft); }
      return response;
    });
    const run = await f.service.start(f.input()); await f.service.wait(run.id);
    assert.equal(f.service.get(run.id, "project-1").status, "failed"); assert.equal(f.modelCalls(), 1);
    assert.throws(() => f.service.result(run.id, "project-1"), /not complete/);
  } finally { await f.cleanup(); }
});

test("unknown usage and wrong returned model fence additional inference", async t => {
  for (const mode of ["usage", "model"] as const) await t.test(mode, async () => {
    const f = await fixture();
    try {
      f.alter((_stage, _packet, response) => { if (mode === "usage") delete response.usage; else response.model = "unexpected/model"; return response; });
      const run = await f.service.start(f.input()); await f.service.wait(run.id);
      const failed = f.service.get(run.id, "project-1");
      assert.equal(failed.status, "failed"); assert.equal(failed.accounting, "unknown"); assert.ok(failed.reservedTokens > 0); assert.equal(f.modelCalls(), 1);
    } finally { await f.cleanup(); }
  });
});

test("zero dollar admission makes no model call and Tavily requires explicit retrieval allowance", async () => {
  const f = await fixture();
  try {
    const run = await f.service.start({ ...f.input(), budget: { estimatedUsd: 0 } }); await f.service.wait(run.id);
    assert.equal(f.service.get(run.id, "project-1").status, "failed"); assert.equal(f.modelCalls(), 0);
    await assert.rejects(f.service.start({ ...f.input(), publicQuery: "experiment", providers: ["tavily"] }), /explicit cost allowance/);
    const accepted = StartResearchSchema.parse({ ...f.input(), providers: ["tavily"], tavilyAllowanceUsd: 1 });
    assert.equal(accepted.tavilyAllowanceUsd, 1); assert.equal(accepted.budget.estimatedUsd, 5);
  } finally { await f.cleanup(); }
});

test("only an explicit public query leaves the project for metadata retrieval", async () => {
  const f = await fixture();
  try {
    const run = await f.service.start({ ...f.input(), goal: "Analyze confidential_project_delta", publicQuery: "energy experiment", providers: ["crossref", "arxiv"], sourceVersionIds: [] });
    await f.service.wait(run.id);
    assert.equal(f.service.get(run.id, "project-1").status, "completed");
    const metadata = f.calls.filter(call => call.url.includes("crossref") || call.url.includes("arxiv"));
    assert.equal(metadata.length, 2); assert.ok(metadata.every(call => !call.url.includes("confidential_project_delta")));
    assert.equal(f.service.get(run.id, "project-1").retrievalAccounting, "local_and_public_metadata");
  } finally { await f.cleanup(); }
});

test("grant revocation aborts in-flight disclosure and prevents result access after completion", async t => {
  await t.test("in-flight", async () => {
    const f = await fixture();
    try {
      f.onCall((_stage, signal) => { f.knowledge.revokeGrant(f.grant.id, f.grant.revision); assert.equal(signal.aborted, true); });
      const run = await f.service.start(f.input()); await f.service.wait(run.id);
      assert.equal(f.service.get(run.id, "project-1").status, "failed"); assert.equal(f.modelCalls(), 1);
      assert.equal(f.service.get(run.id, "project-1").deliverableId, null);
    } finally { await f.cleanup(); }
  });
  await t.test("completed", async () => {
    const f = await fixture();
    try {
      const run = await f.service.start(f.input()); await f.service.wait(run.id);
      f.knowledge.revokeGrant(f.grant.id, f.grant.revision);
      assert.throws(() => f.service.result(run.id, "project-1"), /grant/);
    } finally { await f.cleanup(); }
  });
});

test("cancellation stops an actual pending model request without automatic retry", async () => {
  const f = await fixture();
  try {
    let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
    f.onCall(async (_stage, signal) => { entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); });
    const run = await f.service.start(f.input()); await pending;
    const cancelled = await f.service.cancel(run.id, "project-1");
    assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.accounting, "unknown"); assert.equal(f.modelCalls(), 1);
  } finally { await f.cleanup(); }
});

test("restart fences an interrupted persisted request and never replays charged work", async () => {
  const f = await fixture();
  try {
    const input = f.input(), run = await f.service.start(input); await f.service.wait(run.id); await f.service.close();
    const db = new DatabaseSync(join(f.directory, "research", "research.sqlite"));
    const row = db.prepare("SELECT body FROM runs WHERE id=?").get(run.id)!;
    const record = JSON.parse(String(row.body)); record.run.status = "synthesizing"; record.run.reservedTokens = 999; record.run.deliverableId = null;
    db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify(record), run.id); db.close();
    await f.reopen(); const restored = f.service.get(run.id, "project-1");
    assert.equal(restored.status, "interrupted"); assert.equal(restored.accounting, "unknown");
    assert.equal((await f.service.start(input)).id, run.id); assert.equal(f.modelCalls(), 2);
  } finally { await f.cleanup(); }
});

test("research HTTP contract enforces the parent-bound project identity", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.route("POST", new URL("http://127.0.0.1/v1/research/runs"), f.input(), { nativeAuthenticated: false, projectId: "other-project" }), /outside the active project/);
    const reply = await f.service.route("POST", new URL("http://127.0.0.1/v1/research/runs"), f.input(), { nativeAuthenticated: false, projectId: "project-1" });
    assert.equal(reply.status, 202); await f.service.cancelAll();
  } finally { await f.cleanup(); }
});

test("a reservation save fault admits no inference and exposes only the last committed record", async () => {
  const f = await fixture(), originalSave = ResearchStore.prototype.save;
  let attempts = 0;
  try {
    const emitted: string[] = []; f.service.subscribe(run => emitted.push(run.status));
    ResearchStore.prototype.save = function (record) {
      if (record.run.modelCalls === 1 && record.run.reservedTokens > 0) { attempts++; throw new Error("Injected reservation write failure"); }
      return originalSave.call(this, record);
    };
    const run = await f.service.start(f.input()); await f.service.wait(run.id);
    const committed = f.service.get(run.id, "project-1");
    assert.equal(attempts, 1); assert.equal(f.modelCalls(), 0);
    assert.equal(committed.status, "synthesizing"); assert.equal(committed.modelCalls, 0);
    assert.equal(committed.reservedTokens, 0); assert.equal(committed.estimatedModelUsd, 0);
    assert.equal(committed.accounting, "estimated"); assert.equal(committed.error, null);
    assert.ok(!emitted.includes("failed") && !emitted.includes("completed"));
    assert.deepEqual(await f.service.cancel(run.id, "project-1"), committed);
    ResearchStore.prototype.save = originalSave;
    await assert.rejects(f.service.start(f.input()), /persistence failed/);
    assert.equal(f.modelCalls(), 0);
    await f.service.close();
    const db = new DatabaseSync(join(f.directory, "research", "research.sqlite"));
    const stored = JSON.parse(String(db.prepare("SELECT body FROM runs WHERE id=?").get(run.id)!.body)); db.close();
    assert.deepEqual(stored.run, committed);
  } finally { ResearchStore.prototype.save = originalSave; await f.cleanup(); }
});

test("publication save failure preserves committed publishing state and permanently fences new work", async () => {
  const f = await fixture(), originalSave = ResearchStore.prototype.save;
  let publicationAttempts = 0;
  try {
    const emitted: string[] = []; f.service.subscribe(run => emitted.push(run.status));
    ResearchStore.prototype.save = function (record) {
      if (record.run.status === "completed") { publicationAttempts++; throw new Error("Injected completion write failure"); }
      return originalSave.call(this, record);
    };
    const input = f.input(), run = await f.service.start(input); await f.service.wait(run.id);
    const committed = f.service.get(run.id, "project-1");
    assert.equal(publicationAttempts, 1); assert.equal(f.modelCalls(), 2);
    assert.equal(committed.status, "publishing"); assert.equal(committed.deliverableId, null);
    assert.equal(committed.critiqueVerdict, null); assert.equal(committed.error, null);
    assert.equal(committed.modelCalls, 2); assert.equal(committed.reservedTokens, 0);
    assert.ok(!emitted.includes("completed") && !emitted.includes("failed"));
    assert.throws(() => f.service.result(run.id, "project-1"), /not complete/);
    ResearchStore.prototype.save = originalSave;
    await assert.rejects(f.service.start(input), /persistence failed/);
    await assert.rejects(f.service.start(f.input()), /persistence failed/);
    assert.equal(f.modelCalls(), 2);
    await f.service.close(); await f.reopen();
    assert.equal(f.service.get(run.id, "project-1").status, "interrupted");
    assert.equal((await f.service.start(input)).id, run.id); assert.equal(f.modelCalls(), 2);
  } finally { ResearchStore.prototype.save = originalSave; await f.cleanup(); }
});

test("failed restart reconciliation releases the database before another open", async () => {
  const f = await fixture(), originalSave = ResearchStore.prototype.save;
  try {
    const run = await f.service.start(f.input()); await f.service.wait(run.id); await f.service.close();
    const db = new DatabaseSync(join(f.directory, "research", "research.sqlite"));
    const record = JSON.parse(String(db.prepare("SELECT body FROM runs WHERE id=?").get(run.id)!.body));
    record.run.status = "synthesizing"; record.run.deliverableId = null; record.run.reservedTokens = 1;
    db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify(record), run.id); db.close();
    ResearchStore.prototype.save = function (value) {
      if (value.run.status === "interrupted") throw new Error("Injected reconciliation write failure");
      return originalSave.call(this, value);
    };
    await assert.rejects(f.reopen(), /persistence failed/);
    ResearchStore.prototype.save = originalSave;
    await f.reopen();
    assert.equal(f.service.get(run.id, "project-1").status, "interrupted");
    assert.equal(f.service.get(run.id, "project-1").accounting, "unknown");
  } finally { ResearchStore.prototype.save = originalSave; await f.cleanup(); }
});

test("a save failure aborts another active request without publishing its uncommitted cancellation", async () => {
  const f = await fixture(), originalSave = ResearchStore.prototype.save;
  let abortObserved = false;
  try {
    let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
    f.onCall(async (_stage, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
        abortObserved = true; reject(new Error("aborted after another run's save failure"));
      }, { once: true }));
    });
    const first = await f.service.start(f.input()); await pending;
    const firstCommitted = f.service.get(first.id, "project-1");
    ResearchStore.prototype.save = function (record) {
      if (record.run.id !== first.id && record.run.reservedTokens > 0) throw new Error("Injected concurrent reservation write failure");
      return originalSave.call(this, record);
    };
    const second = await f.service.start(f.input());
    await Promise.all([f.service.wait(first.id), f.service.wait(second.id)]);
    assert.equal(abortObserved, true); assert.equal(f.modelCalls(), 1);
    assert.deepEqual(f.service.get(first.id, "project-1"), firstCommitted);
    assert.equal(f.service.get(second.id, "project-1").modelCalls, 0);
    ResearchStore.prototype.save = originalSave;
    await assert.rejects(f.service.start(f.input()), /persistence failed/);
  } finally { ResearchStore.prototype.save = originalSave; await f.cleanup(); }
});
