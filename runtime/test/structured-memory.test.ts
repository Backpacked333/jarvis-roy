import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { deleteMemory, listMemories, rememberPreference } from "../agent/lib/memory.ts";
import { MemoryService, MemoryStore, type MemoryInput, type MemoryOptions } from "../bridge/memory/index.ts";
import type { LocalEmbeddingProvider } from "../bridge/knowledge/embeddings.ts";

const native = { nativeAuthenticated: true };
const agent = { nativeAuthenticated: false, projectId: "project-1" };
const input = (patch: Partial<MemoryInput> = {}): MemoryInput => ({
  kind: "preference", scope: { kind: "global" }, text: "Prefer concise research reports",
  provenance: { origin: "explicit_user", references: [] }, confidence: 1, pinned: false,
  expiresAt: null, cloudAllowed: true, ...patch,
});
const query = (patch: Record<string, unknown> = {}) => ({ query: "research", projectId: "project-1", purpose: "cloud", limit: 10, ...patch });
async function fixture(options: Partial<MemoryOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-structured-memory-"));
  let clock = Date.parse("2026-11-09T12:00:00.000Z");
  const config = { dataDirectory: directory, enabled: true, now: () => new Date(clock), ...options };
  let service = await MemoryService.open(config);
  return { directory, get service() { return service; }, advance(ms: number) { clock += ms; },
    async restart() { await service.close(); service = await MemoryService.open(config); },
    async cleanup() { await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("memory proposals need native approval of exact revision and digest; edits and replay cannot approve", async () => {
  const f = await fixture();
  try {
    let proposed = await f.service.propose(input(), agent);
    assert.equal(proposed.status, "proposed"); assert.equal(proposed.provenance.origin, "inferred");
    assert.equal((await f.service.recall(query(), agent)).matches.length, 0);
    await assert.rejects(f.service.create(input(), agent), /native/);
    await assert.rejects(f.service.approve(proposed.id, { expectedRevision: proposed.revision, digest: proposed.digest }, agent), /native/);
    await assert.rejects(f.service.approve(proposed.id, { expectedRevision: proposed.revision, digest: "0".repeat(64) }, native), /digest/);
    const original = proposed;
    proposed = await f.service.update(proposed.id, { expectedRevision: proposed.revision, input: input({ text: "Prefer detailed research reports" }) }, native);
    await assert.rejects(f.service.approve(proposed.id, { expectedRevision: original.revision, digest: original.digest }, native), /changed/);
    const results = await Promise.allSettled([1, 2].map(() => f.service.approve(proposed.id, { expectedRevision: proposed.revision, digest: proposed.digest }, native)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await f.service.recall(query(), agent)).matches[0].entry.text, "Prefer detailed research reports");
    await f.restart(); assert.equal((await f.service.recall(query(), agent)).matches.length, 1);
    const active = await f.service.inspect(proposed.id, native);
    const edited = await f.service.update(active.id, { expectedRevision: active.revision, input: input({ pinned: true }) }, native);
    assert.equal(edited.status, "proposed"); assert.equal((await f.service.recall(query(), agent)).matches.length, 0);
  } finally { await f.cleanup(); }
});

test("memory recall enforces exact project, cloud consent, expiry and live source grants", async () => {
  let permitted = true; const observed: string[] = [];
  const f = await fixture({ resolveSource(ref, access) { observed.push(`${ref.sourceVersionId}:${access.purpose}`); return permitted; } });
  try {
    const global = await f.service.create(input(), native);
    const privateMemory = await f.service.create(input({ cloudAllowed: false }), native);
    await f.service.create(input({ scope: { kind: "project", projectId: "project-2" } }), native);
    const sourced = await f.service.create(input({ kind: "fact", scope: { kind: "project", projectId: "project-1" }, provenance: { origin: "inferred", references: [{ type: "knowledge", projectId: "project-1", sourceVersionId: "source-v1", passageId: "passage-1" }] } }), native);
    const expired = await f.service.create(input({ expiresAt: "2026-11-09T12:00:01.000Z" }), native);
    f.advance(1001);
    const found = (await f.service.recall(query(), agent)).matches.map(item => item.entry.id);
    assert.deepEqual(new Set(found), new Set([global.id, sourced.id])); assert.ok(observed.includes("source-v1:cloud"));
    assert.equal(f.service.authorize(privateMemory, { projectId: "project-1", purpose: "cloud" }), false);
    assert.equal(f.service.authorize(expired, { projectId: "project-1", purpose: "local" }), false);
    assert.equal((await f.service.recall(query({ purpose: "local" }), native)).matches.length, 3);
    permitted = false;
    assert.equal(f.service.authorize(sourced, { projectId: "project-1", purpose: "cloud" }), false);
    assert.deepEqual((await f.service.recall(query(), agent)).matches.map(item => item.entry.id), [global.id]);
    await assert.rejects(f.service.recall(query({ purpose: "local" }), agent), /exact project and cloud/);
    await assert.rejects(f.service.recall(query({ projectId: "project-2" }), agent), /exact project/);
    await assert.rejects(f.service.recall(query(), { nativeAuthenticated: false }), /exact project/);
    await assert.rejects(f.service.propose(input({ scope: { kind: "project", projectId: "project-2" } }), agent), /another project/);
    await assert.rejects(f.service.create(input({ provenance: { origin: "explicit_user", references: [{ type: "knowledge", projectId: "project-1", sourceVersionId: "source-v1" }] } }), native), /exact project scope/);
  } finally { await f.cleanup(); }
  const noResolver = await fixture();
  try {
    await noResolver.service.create(input({ scope: { kind: "project", projectId: "project-1" }, provenance: { origin: "inferred", references: [{ type: "knowledge", projectId: "project-1", sourceVersionId: "source-v1" }] } }), native);
    assert.equal((await noResolver.service.recall(query(), agent)).matches.length, 0);
  } finally { await noResolver.cleanup(); }
});

test("ranking explains relevance, respects limits, and never includes inactive records", async () => {
  const f = await fixture();
  try {
    await f.service.create(input({ text: "Research reports should use tables" }), native);
    const pinned = await f.service.create(input({ text: "Research reports should use charts", pinned: true }), native);
    await f.service.create(input({ text: "Favorite meal is pasta", kind: "fact", pinned: true }), native);
    const archived = await f.service.create(input(), native);
    await f.service.archive(archived.id, { expectedRevision: archived.revision }, native);
    const found = await f.service.recall(query({ limit: 1 }), agent);
    assert.equal(found.matches[0].entry.id, pinned.id); assert.ok(found.matches[0].reasons.includes("Pinned memory"));
    const oldDecision = await f.service.create(input({ kind: "decision", text: "Research uses approach A" }), native);
    const replacement = await f.service.create(input({ kind: "decision", text: "Research uses approach B" }), native);
    const superseded = await f.service.supersede(oldDecision.id, { expectedRevision: oldDecision.revision, replacementId: replacement.id, replacementRevision: replacement.revision }, native);
    assert.equal(superseded.status, "superseded"); assert.equal(superseded.supersededBy, replacement.id);
    assert.equal((await f.service.recall(query(), agent)).matches.some(item => item.entry.id === oldDecision.id), false);
    assert.equal((await f.service.export(null, native)).entries.length, 6);
    await assert.rejects(f.service.export(null, agent), /native/);
  } finally { await f.cleanup(); }
});

test("legacy approved files are backed up privately; edits need approval and forgetting cannot resurrect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-memory-migration-"));
  const legacy = await rememberPreference("Research reports should be concise", undefined, directory);
  const changed: string[] = [];
  let service = await MemoryService.open({ dataDirectory: directory, enabled: true, onLegacyChanged(id) { changed.push(id); } });
  try {
    const imported = (await service.list(null, native)).entries[0];
    assert.equal(imported.id, legacy.id); assert.equal(imported.status, "active"); assert.equal(imported.cloudAllowed, true);
    const backup = join(directory, "memory", "legacy-migration-v1.backup.json");
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "memory", "memory.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "memory"))).mode & 0o777, 0o700);
    assert.match(await readFile(backup, "utf8"), /Research reports/);
    await writeFile(join(directory, "memories", `${legacy.id}.json`), JSON.stringify({ ...legacy, text: "Research changed outside the service" }));
    assert.equal((await service.recall(query(), agent)).matches.length, 0);
    const edited = await service.inspect(legacy.id, native); assert.equal(edited.status, "proposed");
    await assert.rejects(service.approve(legacy.id, { expectedRevision: imported.revision, digest: imported.digest }, native), /changed/);
    const approved = await service.approve(legacy.id, { expectedRevision: edited.revision, digest: edited.digest }, native);
    assert.equal((await listMemories(directory)).length, 0); assert.equal((await service.recall(query(), agent)).matches.length, 1);
    await service.forget(legacy.id, { expectedRevision: approved.revision }, native);
    assert.ok(changed.includes(legacy.id)); assert.doesNotMatch(await readFile(backup, "utf8"), /Research/);
    await writeFile(join(directory, "memories", `${legacy.id}.json`), JSON.stringify(legacy));
    await service.close(); service = await MemoryService.open({ dataDirectory: directory, enabled: true });
    assert.equal((await service.list(null, native)).entries.length, 0); assert.equal((await listMemories(directory)).length, 0);
    await service.close();
    const db = new DatabaseSync(join(directory, "memory", "memory.sqlite"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_search").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n, 0); db.close();
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("deleting a legacy file removes its mirror and stale restored copies stay forgotten", async () => {
  const f = await fixture();
  try {
    const legacy = await rememberPreference("Research uses citations", undefined, f.directory);
    assert.equal((await f.service.recall(query(), agent)).matches.length, 1);
    await deleteMemory(legacy.id, f.directory);
    assert.equal((await f.service.recall(query(), agent)).matches.length, 0);
    await writeFile(join(f.directory, "memories", `${legacy.id}.json`), JSON.stringify(legacy));
    await f.restart(); assert.equal((await f.service.recall(query(), agent)).matches.length, 0);
    const second = await rememberPreference("Research uses experiments", undefined, f.directory);
    await f.service.forgetLegacy(second.id, native);
    assert.equal((await listMemories(f.directory)).length, 0);
  } finally { await f.cleanup(); }
});

test("credential-like content and unknown fields are refused and default-off memory has no store", async () => {
  const f = await fixture();
  try {
    for (const text of ["api_key=pretend-value", "password: hidden", "Bearer abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----"]) {
      await assert.rejects(f.service.create(input({ text }), native), /Credentials/);
      await assert.rejects(f.service.propose(input({ text }), agent), /Credentials/);
    }
    await assert.rejects(f.service.create({ ...input(), status: "active" }, native), /Unrecognized/);
    await assert.rejects(f.service.create(input({ expiresAt: "2020-01-01T00:00:00.000Z" }), native), /future/);
  } finally { await f.cleanup(); }
  const disabled = await fixture({ enabled: false });
  try {
    assert.deepEqual((await disabled.service.route("GET", new URL("http://local/v1/memory/status"), null, native))?.body, { version: 1, enabled: false });
    await assert.rejects(disabled.service.create(input(), native), /disabled/);
    await assert.rejects(stat(join(disabled.directory, "memory")), /ENOENT/);
  } finally { await disabled.cleanup(); }
});

test("failed durable save does not publish approval or searchable content", async () => {
  const f = await fixture(); const save = MemoryStore.prototype.save;
  try {
    const proposed = await f.service.propose(input(), agent);
    MemoryStore.prototype.save = function(entry) { save.call(this, entry); throw new Error("injected persistence failure"); };
    await assert.rejects(f.service.approve(proposed.id, { expectedRevision: proposed.revision, digest: proposed.digest }, native), /injected/);
    MemoryStore.prototype.save = save;
    assert.equal((await f.service.inspect(proposed.id, native)).status, "proposed");
    assert.equal((await f.service.recall(query(), agent)).matches.length, 0);
    await f.restart(); assert.equal((await f.service.inspect(proposed.id, native)).digest, proposed.digest);
  } finally { MemoryStore.prototype.save = save; await f.cleanup(); }
});

test("memory routes preserve native authority and bound revision review", async () => {
  const f = await fixture(); const url = (path: string) => new URL(`http://local/v1/memory/${path}`);
  try {
    const proposal = (await f.service.route("POST", url("proposals"), input(), agent))!.body as { id: string; revision: number; digest: string };
    await assert.rejects(f.service.route("GET", url("entries"), null, agent), /native/);
    await assert.rejects(f.service.route("POST", url(`entries/${proposal.id}/approve`), { expectedRevision: proposal.revision, digest: proposal.digest }, agent), /native/);
    assert.equal((await f.service.route("POST", url(`entries/${proposal.id}/approve`), { expectedRevision: proposal.revision, digest: proposal.digest }, native))!.status, 200);
    assert.equal(((await f.service.route("POST", url("recall"), query(), agent))!.body as { matches: unknown[] }).matches.length, 1);
    assert.equal(await f.service.route("GET", new URL("http://local/unrelated"), null, native), null);
  } finally { await f.cleanup(); }
});

test("legacy whitespace is canonicalized before digest and final authorization detects external changes", async () => {
  const f = await fixture();
  try {
    const legacy = await rememberPreference("  Research reports should be concise  ", undefined, f.directory);
    const entry = (await f.service.recall(query(), agent)).matches[0].entry;
    assert.equal(entry.text, "Research reports should be concise");
    assert.equal(f.service.authorize(entry, { projectId: "project-1", purpose: "cloud" }), true);
    await writeFile(join(f.directory, "memories", `${legacy.id}.json`), JSON.stringify({ ...legacy, text: "  Research reports changed  " }));
    assert.equal(f.service.authorize(entry, { projectId: "project-1", purpose: "cloud" }), false);
    const edited = await f.service.inspect(legacy.id, native);
    const approved = await f.service.approve(edited.id, { expectedRevision: edited.revision, digest: edited.digest }, native);
    assert.equal(approved.text, "Research reports changed");
    assert.equal(f.service.authorize(approved, { projectId: "project-1", purpose: "cloud" }), true);
    const second = await rememberPreference("Research checks citations", undefined, f.directory);
    const captured = (await f.service.list(null, native)).entries.find(item => item.id === second.id)!;
    await deleteMemory(second.id, f.directory);
    assert.equal(f.service.authorize(captured, { projectId: "project-1", purpose: "cloud" }), false);
  } finally { await f.cleanup(); }
});

test("local semantic memory recall finds paraphrases, persists cache, and never embeds unauthorized entries", async () => {
  const batches: string[][] = [];
  const provider: LocalEmbeddingProvider = { identity: { id: "deterministic-test-model", version: "1", dimensions: 2, local: true },
    async embed(texts) { batches.push([...texts]); return texts.map(text => /research|briefing/i.test(text) ? [1, 0] : [0, 1]); } };
  const f = await fixture({ embeddingProvider: provider });
  try {
    const relevant = await f.service.create(input(), native);
    await f.service.create(input({ text: "Favorite fruit is orange", kind: "fact" }), native);
    await f.service.create(input({ text: "Private research detail", cloudAllowed: false }), native);
    await f.service.create(input({ text: "Other project research", scope: { kind: "project", projectId: "project-2" } }), native);
    const first = await f.service.recall(query({ query: "briefing" }), agent);
    assert.deepEqual(first.matches.map(item => item.entry.id), [relevant.id]);
    assert.equal(first.retrieval.mode, "hybrid"); assert.equal(first.retrieval.vectorStatus, "ready");
    assert.ok(first.matches[0].reasons.some(reason => reason.includes("Local semantic similarity")));
    assert.equal(batches.flat().some(text => /Private|Other project/.test(text)), false);
    batches.length = 0;
    await f.service.recall(query({ query: "briefing" }), agent);
    assert.deepEqual(batches, [["briefing"]]);
    await f.restart(); batches.length = 0;
    await f.service.recall(query({ query: "briefing" }), agent);
    assert.deepEqual(batches, [["briefing"]]);
    await f.service.forget(relevant.id, { expectedRevision: relevant.revision }, native);
    assert.equal((await f.service.recall(query({ query: "briefing" }), agent)).matches.length, 0);
    await f.service.close();
    const db = new DatabaseSync(join(f.directory, "memory", "memory.sqlite"));
    assert.equal(db.prepare("SELECT entry_id FROM memory_vectors WHERE entry_id=?").get(relevant.id), undefined); db.close();
  } finally { await f.cleanup(); }
});

test("busy or invalid local embeddings report lexical fallback and stopwords do not create accidental matches", async () => {
  const provider: LocalEmbeddingProvider = { identity: { id: "test-busy-model", version: "1", dimensions: 2, local: true }, async embed() { throw new Error("helper busy"); } };
  const f = await fixture({ embeddingProvider: provider });
  try {
    const relevant = await f.service.create(input(), native);
    const standing = await f.service.create(input({ text: "Use metric units", pinned: true }), native);
    await f.service.create(input({ kind: "person", text: "The doctor is Alex", pinned: true }), native);
    const found = await f.service.recall(query({ query: "Please show me the research" }), agent);
    assert.deepEqual(new Set(found.matches.map(item => item.entry.id)), new Set([relevant.id, standing.id]));
    assert.equal(found.retrieval.mode, "lexical"); assert.equal(found.retrieval.vectorStatus, "failed");
    assert.ok(found.retrieval.warnings.some(warning => warning.includes("busy")));
    const general = await f.service.recall(query({ query: "the please" }), agent);
    assert.deepEqual(general.matches.map(item => item.entry.id), [standing.id]);
    assert.ok(general.matches[0].reasons.includes("Pinned preference or routine selected as standing context"));
  } finally { await f.cleanup(); }
});

test("Stop and native edits abort pending local embedding reads before they return stale memory", async () => {
  let entered!: () => void; let started = new Promise<void>(resolve => { entered = resolve; });
  const provider: LocalEmbeddingProvider = { identity: { id: "test-wait-model", version: "1", dimensions: 2, local: true },
    async embed(_texts, { signal }) { entered(); return new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); }); } };
  const f = await fixture({ embeddingProvider: provider });
  try {
    const entry = await f.service.create(input(), native);
    const read = f.service.recall(query(), agent); const rejected = assert.rejects(read, /stopped/);
    await started; f.service.cancelReads(); await rejected;
    started = new Promise<void>(resolve => { entered = resolve; });
    const second = f.service.recall(query(), agent); const rejectedAgain = assert.rejects(second, /stopped/);
    await started;
    const edited = await f.service.update(entry.id, { expectedRevision: entry.revision, input: input({ cloudAllowed: false }) }, native);
    await rejectedAgain; assert.equal(edited.status, "proposed");
    assert.equal(f.service.authorize(entry, { projectId: "project-1", purpose: "cloud" }), false);
  } finally { await f.cleanup(); }
});

test("source revocation during local embedding work prevents cached or returned source memory", async () => {
  let permitted = true;
  const provider: LocalEmbeddingProvider = { identity: { id: "test-revocation-model", version: "1", dimensions: 2, local: true },
    async embed(texts) { permitted = false; return texts.map(() => [1, 0]); } };
  const f = await fixture({ embeddingProvider: provider, resolveSource: () => permitted });
  try {
    const source = await f.service.create(input({ scope: { kind: "project", projectId: "project-1" }, provenance: { origin: "inferred", references: [{ type: "knowledge", projectId: "project-1", sourceVersionId: "source-1" }] } }), native);
    assert.equal((await f.service.recall(query(), agent)).matches.length, 0);
    await f.service.close(); const db = new DatabaseSync(join(f.directory, "memory", "memory.sqlite"));
    assert.equal(db.prepare("SELECT entry_id FROM memory_vectors WHERE entry_id=?").get(source.id), undefined); db.close();
  } finally { await f.cleanup(); }
});

test("SQLite v1 migration preserves entries and writes a private pre-migration backup", async () => {
  const f = await fixture();
  try {
    const entry = await f.service.create(input(), native); await f.service.close();
    const db = new DatabaseSync(join(f.directory, "memory", "memory.sqlite"));
    db.exec("DROP TABLE memory_vectors; DROP TABLE entry_history; DROP TABLE entities; DROP TABLE memory_conflicts; PRAGMA user_version=1;"); db.close();
    await f.restart(); assert.equal((await f.service.inspect(entry.id, native)).text, entry.text);
    const backups = (await readdir(join(f.directory, "memory"))).filter(name => name.startsWith("schema-v1-"));
    assert.equal(backups.length, 1);
    const file = join(f.directory, "memory", backups[0]); assert.equal((await stat(file)).mode & 0o777, 0o600);
    const backup = new DatabaseSync(file, { readOnly: true });
    assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(JSON.parse(String(backup.prepare("SELECT body FROM entries WHERE id=?").get(entry.id)?.body)).text, entry.text); backup.close();
  } finally { await f.cleanup(); }
});
