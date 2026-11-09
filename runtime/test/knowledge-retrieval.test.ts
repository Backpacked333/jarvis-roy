import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { KnowledgeService, type LocalEmbeddingProvider } from "../bridge/knowledge/index.ts";

const query = { projectId: "alpha", query: "What transport runs on gasoline?", purpose: "cloud" as const };
const native = { nativeAuthenticated: true }, model = { nativeAuthenticated: false };
const endpoint = (name: string) => new URL(`http://127.0.0.1:39202/v1/knowledge/${name}`);
function provider(version = "fixture-1", calls: string[][] = []): LocalEmbeddingProvider {
  return { identity: { id: "local-test-semantic", version, dimensions: 3, local: true },
    async embed(texts) {
      calls.push([...texts]);
      return texts.map(text => /automobile|vehicle|gasoline|transport|sedan/i.test(text) ? [1, 0, 0] : /cardiac|heart|myocardial/i.test(text) ? [0, 1, 0] : [0, 0, 1]);
    } };
}
async function fixture(t: TestContext, embeddingProvider?: LocalEmbeddingProvider) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-local-retrieval-"));
  const service = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service };
}
async function importText(service: KnowledgeService, text: string, options: { projectId?: string; cloud?: boolean; resourceId?: string } = {}) {
  const projectId = options.projectId ?? "alpha", resourceId = options.resourceId ?? crypto.randomUUID();
  const grant = service.createGrant({ projectId, resourceId, resourceKind: "file", label: "Fixture source", cloudAllowed: options.cloud ?? true, expiresAt: null, operations: ["read_document"] });
  const input = { projectId, grantId: grant.id, resourceId, filename: "fixture.md", title: "Fixture source", mediaType: "text/markdown", bytesBase64: Buffer.from(text).toString("base64") };
  const imported = await service.importSource(input);
  return { ...imported, grant, input };
}

test("lexical retrieval handles spoken framing and missing query words without requiring every token", async t => {
  const { service } = await fixture(t);
  const relevant = await importText(service, "Repeated fatigue loading reduces endurance. Cracks propagate under cyclic stress.");
  await importText(service, "Seasonal rainfall changes river water levels.");
  const result = service.search({ ...query, query: "What did the paper say about fatigue and endurance after cycling?" });
  assert.equal(result.matches[0].source.id, relevant.source.id);
  assert.deepEqual(result.matches[0].explanation.lanes, ["lexical"]);
  assert.deepEqual(result.matches[0].explanation.matchedTerms, ["fatigue", "endurance"]);
  const context = await service.retrieveContext({ ...query, query: "Explain fatigue endurance" });
  assert.equal(context.retrieval.mode, "lexical"); assert.equal(context.retrieval.vectorStatus, "unavailable");
  assert.equal(context.matches[0].explanation.queryCoverage, 1);
});

test("local semantic fixtures retrieve synonyms, fuse lanes deterministically and retain source diversity", async t => {
  const { service } = await fixture(t, provider());
  const automobile = await importText(service, "An automobile uses an internal combustion engine.");
  await importText(service, "Cardiac tissue responds to reduced oxygen.");
  assert.equal(service.search(query).matches.length, 0, "fixture genuinely lacks lexical overlap");
  const indexed = await service.indexEmbeddings({ projectId: "alpha" });
  assert.equal(indexed.indexed, 2); assert.equal(indexed.remaining, 0);
  const semantic = await service.retrieveContext(query);
  assert.equal(semantic.matches[0].source.id, automobile.source.id);
  assert.deepEqual(semantic.matches[0].explanation.lanes, ["vector"]);
  assert.equal(semantic.matches[0].explanation.queryCoverage, 0);
  assert.equal(semantic.matches[0].explanation.cosine, 1);
  await importText(service, Array.from({ length: 4 }, () => "Automobile vehicle propulsion. ".repeat(130)).join("\n"));
  const second = await importText(service, "A sedan is an automobile vehicle.");
  const hybrid = await service.retrieveContext({ ...query, query: "automobile vehicle", indexBudget: 64, maxPerSource: 1, limit: 10 });
  assert(hybrid.matches.some(match => match.source.id === second.source.id));
  assert(hybrid.matches.some(match => match.explanation.lanes.length === 2));
  assert.equal(new Set(hybrid.matches.map(match => match.source.sourceId)).size, hybrid.matches.length);
  const repeated = await service.retrieveContext({ ...query, query: "automobile vehicle", maxPerSource: 1, limit: 10 });
  assert.deepEqual(repeated.matches, hybrid.matches, "ranking and explanations repeat exactly for the same cache");
});

test("vector caches survive restart but incompatible local models require bounded reindexing", async t => {
  const calls: string[][] = [], { service, directory } = await fixture(t, provider("first", calls));
  await importText(service, "An automobile uses an internal combustion engine.");
  await service.indexEmbeddings({ projectId: "alpha" });
  assert.equal(calls.length, 1);
  service.close();
  const restored = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider("first", calls) });
  assert.equal((await restored.indexEmbeddings({ projectId: "alpha" })).indexed, 0);
  assert.equal(calls.length, 1, "cached passages do not call the embedding provider again");
  assert.equal((await restored.retrieveContext(query)).matches.length, 1);
  restored.close();
  const changed = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider("second", calls) });
  t.after(() => changed.close());
  const missing = await changed.retrieveContext(query);
  assert.equal(missing.matches.length, 0); assert.equal(missing.retrieval.coverage.pendingPassages, 1);
  assert.equal((await changed.retrieveContext({ ...query, indexBudget: 1 })).matches.length, 1);
});

test("project, cloud permission, latest revision and archive filters constrain both ranking lanes", async t => {
  const { service } = await fixture(t, provider());
  const first = await importText(service, "An automobile has an engine.");
  const localOnly = await importText(service, "A sedan is a vehicle.", { cloud: false });
  await importText(service, "Another automobile belongs to another project.", { projectId: "beta" });
  await service.indexEmbeddings({ projectId: "alpha" }); await service.indexEmbeddings({ projectId: "beta" });
  let result = await service.retrieveContext(query);
  assert.deepEqual(result.matches.map(match => match.source.id), [first.source.id]);
  assert.equal(result.retrieval.coverage.eligiblePassages, 1, "coverage does not count undisclosed private sources");
  assert.equal((await service.retrieveContext({ ...query, purpose: "local" })).matches.length, 2);
  const next = await service.importSource({ ...first.input, sourceId: first.source.sourceId, bytesBase64: Buffer.from("Cardiac tissue differs from engine mechanics.").toString("base64") });
  result = await service.retrieveContext({ ...query, indexBudget: 1 });
  assert.equal(result.matches.length, 0, "obsolete semantic vectors cannot recall superseded versions");
  service.archiveSource(next.source.id, "alpha", true);
  assert.equal((await service.retrieveContext({ ...query, query: "cardiac tissue" })).matches.length, 0);
  assert.equal((await service.retrieveContext({ ...query, query: "cardiac tissue", includeArchived: true })).matches[0].source.id, next.source.id);
  await service.deleteSource(localOnly.source.id, "alpha");
  assert.equal((await service.retrieveContext({ ...query, purpose: "local" })).retrieval.coverage.eligiblePassages, 0);
});

test("grant revocation during query embedding prevents cached passages from reaching cloud", async t => {
  const base = provider(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => entered = resolve);
  const embeddingProvider: LocalEmbeddingProvider = { identity: base.identity, async embed(texts, options) {
    if (texts[0] === query.query) { entered(); await new Promise<void>(resolve => release = resolve); }
    return base.embed(texts, options);
  } };
  const { service } = await fixture(t, embeddingProvider);
  const imported = await importText(service, "An automobile has an engine.");
  await service.indexEmbeddings({ projectId: "alpha" });
  const pending = service.retrieveContext(query);
  await started; service.revokeGrant(imported.grant.id, imported.grant.revision); release();
  const result = await pending;
  assert.deepEqual(result.matches, []); assert.equal(result.retrieval.coverage.eligiblePassages, 0);
});

test("revocation and Stop all abort local indexing even if a provider ignores cancellation", async t => {
  let entered!: () => void, release!: () => void;
  let block = true;
  const started = new Promise<void>(resolve => entered = resolve), base = provider();
  const { service } = await fixture(t, { identity: base.identity, async embed(texts, options) {
    if (block) { block = false; entered(); await new Promise<void>(resolve => release = resolve); }
    return base.embed(texts, options);
  } });
  const imported = await importText(service, "An automobile has an engine.");
  const pending = service.indexEmbeddings({ projectId: "alpha" });
  const rejected = assert.rejects(pending, /revoked/);
  await started; service.revokeGrant(imported.grant.id, imported.grant.revision); await rejected; release();
  assert.equal((await service.retrieveContext({ ...query, purpose: "local" })).matches.length, 0);
  // A distinct service fixture verifies query-only cancellation without revoking a grant.
  let queryStarted!: () => void;
  const waiting = new Promise<void>(resolve => queryStarted = resolve);
  const other = await fixture(t, { identity: base.identity, async embed() { queryStarted(); return new Promise(() => {}); } });
  const read = other.service.retrieveContext(query), stopped = assert.rejects(read, /stopped/);
  await waiting; other.service.cancelReads(); await stopped;
});

test("batch bounds and native-only index controls are enforced without cloud embedding fallback", async t => {
  const calls: string[][] = [], { service } = await fixture(t, provider("bounded", calls));
  await importText(service, Array.from({ length: 20 }, () => "汽".repeat(3999)).join("\n"));
  const indexed = await service.indexEmbeddings({ projectId: "alpha", limit: 7 });
  assert.equal(indexed.indexed, 7); assert(indexed.remaining > 0);
  assert(calls.length >= 2);
  for (const batch of calls) { assert(batch.length <= 16); assert(batch.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= 64 * 1024); }
  await assert.rejects(service.route("POST", endpoint("index"), { projectId: "alpha" }, model), /trusted native/);
  await assert.rejects(service.route("POST", endpoint("context"), { ...query, purpose: "local" }, model), /trusted native/);
  assert.equal((await service.route("POST", endpoint("context"), query, model))!.status, 200);
  await assert.rejects(service.indexEmbeddings({ projectId: "alpha", limit: 257 }));
});

test("invalid vectors and mid-call model changes fail to lexical evidence without publishing mixed cache", async t => {
  const invalid = provider(); invalid.embed = async texts => texts.map(() => [Number.NaN, 0, 1]);
  const { service } = await fixture(t, invalid);
  await importText(service, "Automobile mechanics are documented.");
  const result = await service.retrieveContext({ ...query, query: "automobile mechanics", indexBudget: 1 });
  assert.equal(result.retrieval.vectorStatus, "failed"); assert.equal(result.retrieval.coverage.indexedPassages, 0);
  assert.equal(result.matches[0].explanation.lanes[0], "lexical");
  const changing = provider();
  changing.embed = async texts => { changing.identity.version = "mutated"; return texts.map(() => [1, 0, 0]); };
  const second = await fixture(t, changing); await importText(second.service, "Automobile mechanics are documented.");
  await assert.rejects(second.service.indexEmbeddings({ projectId: "alpha" }), /model changed/);
  assert.equal((await second.service.retrieveContext({ ...query, query: "automobile" })).retrieval.coverage.indexedPassages, 0);
});

test("schema migration backs up version one before adding derived embeddings and refuses unsafe backup paths", async t => {
  const { directory, service } = await fixture(t);
  const imported = await importText(service, "Preserved automobile evidence.");
  service.close();
  const database = path.join(directory, "knowledge", "knowledge.sqlite"), backup = path.join(directory, "knowledge", "knowledge-v1.before-embeddings.sqlite");
  let db = new DatabaseSync(database); db.exec("DROP TABLE passage_embeddings; DROP TABLE index_jobs; PRAGMA user_version=1;"); db.close();
  const restored = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider() });
  assert.equal(restored.readSource(imported.source.id, "alpha", "cloud").source.id, imported.source.id);
  assert((await readFile(backup)).length > 0);
  db = new DatabaseSync(backup); assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1); db.close();
  restored.close();
  db = new DatabaseSync(database); db.exec("DROP TABLE passage_embeddings; DROP TABLE index_jobs; PRAGMA user_version=1;"); db.close();
  await rm(backup); await symlink(database, backup);
  await assert.rejects(KnowledgeService.open({ dataDirectory: directory, enabled: true }), /Unsafe knowledge migration backup/);
});

test("exact pinned passage reads reject foreign, revoked, superseded and archived evidence", async t => {
  const { service } = await fixture(t);
  const imported = await importText(service, "A precise passage that need not match the current question.");
  const id = imported.passages[0].id;
  assert.equal(service.readPassage(id, "alpha", "cloud").passage.text, imported.passages[0].text);
  assert.throws(() => service.readPassage(id, "beta", "cloud"), /not found/);
  const revised = await service.importSource({ ...imported.input, sourceId: imported.source.sourceId, bytesBase64: Buffer.from("An updated precise passage.").toString("base64") });
  assert.throws(() => service.readPassage(id, "alpha", "cloud"), /superseded/);
  service.archiveSource(revised.source.id, "alpha", true);
  assert.throws(() => service.readPassage(revised.passages[0].id, "alpha", "cloud"), /archived/);
  service.archiveSource(revised.source.id, "alpha", false);
  service.revokeGrant(imported.grant.id, imported.grant.revision);
  assert.throws(() => service.readPassage(revised.passages[0].id, "alpha", "cloud"), /outside/);
});

test("corrupt vector cache is omitted and evicted so explicit bounded indexing repairs it", async t => {
  const { service, directory } = await fixture(t, provider());
  await importText(service, "An automobile has an engine.");
  await service.indexEmbeddings({ projectId: "alpha" }); service.close();
  const db = new DatabaseSync(path.join(directory, "knowledge", "knowledge.sqlite"));
  db.prepare("UPDATE passage_embeddings SET vector=?").run(Buffer.from([0])); db.close();
  const restored = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider() });
  t.after(() => restored.close());
  const omitted = await restored.retrieveContext(query);
  assert.equal(omitted.matches.length, 0); assert.equal(omitted.retrieval.coverage.pendingPassages, 1);
  assert(omitted.retrieval.warnings.some(warning => warning.includes("invalid cached")));
  assert.equal((await restored.indexEmbeddings({ projectId: "alpha" })).indexed, 1);
  assert.equal((await restored.retrieveContext(query)).matches.length, 1);
});

test("inaccessible recent sources cannot crowd permitted older evidence out of the bounded source window", async t => {
  const { service, directory } = await fixture(t);
  const allowed = await importText(service, "Fatigue endurance evidence remains accessible.");
  const denied = await importText(service, "Private local-only notes.", { cloud: false });
  service.close();
  const db = new DatabaseSync(path.join(directory, "knowledge", "knowledge.sqlite"));
  const insert = db.prepare("INSERT INTO sources(id,project_id,source_id,revision,record,archived) VALUES (?,?,?,?,?,0)");
  db.exec("BEGIN");
  for (let index = 0; index < 2001; index++) {
    const id = `local-only-${index}`, source = { ...denied.source, id, sourceId: id };
    insert.run(id, "alpha", id, 1, JSON.stringify(source));
  }
  db.exec("COMMIT"); db.close();
  const restored = await KnowledgeService.open({ dataDirectory: directory, enabled: true });
  t.after(() => restored.close());
  const result = await restored.retrieveContext({ ...query, query: "fatigue endurance" });
  assert.deepEqual(result.matches.map(match => match.source.id), [allowed.source.id]);
  assert.equal(result.retrieval.coverage.eligiblePassages, 1);
  assert.equal(result.retrieval.coverage.sourceScanLimited, false, "coverage exposes only the permitted source window");
});
