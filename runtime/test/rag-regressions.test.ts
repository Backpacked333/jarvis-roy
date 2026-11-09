import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { KnowledgeService } from "../bridge/knowledge/index.ts";
import { embeddingKey, encodeVector, sharedEmbeddingProvider, type LocalEmbeddingProvider } from "../bridge/knowledge/embeddings.ts";
import { createContextAssembler } from "../bridge/context/index.ts";
import { passageParts } from "../bridge/knowledge/extract.ts";

async function imported(service: KnowledgeService, name: string, text: string) {
  const grant = service.createGrant({ projectId: "fixture", resourceId: name, resourceKind: "file", label: name,
    operations: ["read_document"], cloudAllowed: true, expiresAt: null });
  return service.importSource({ projectId: "fixture", resourceId: name, grantId: grant.id, filename: `${name}.md`, title: name,
    mediaType: "text/markdown", bytesBase64: Buffer.from(text).toString("base64") });
}
test("150 labeled deterministic retrieval fixtures resolve expected exact evidence; live E5 quality remains unrun", async t => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/retrieval-150.json", import.meta.url), "utf8")) as {
    liveEmbeddingQuality: string; sources: { id: string; text: string }[]; cases: { id: string; query: string; expectedSource: string }[];
  };
  assert.equal(fixture.liveEmbeddingQuality, "unrun"); assert.equal(fixture.cases.length, 150);
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-rag-150-"));
  const service = await KnowledgeService.open({ dataDirectory: directory, enabled: true });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  const ids = new Map<string, string>();
  for (const source of fixture.sources) ids.set(source.id, (await imported(service, source.id, source.text)).source.id);
  let passed = 0;
  for (const item of fixture.cases) {
    const result = await service.retrieveContext({ projectId: "fixture", query: item.query, purpose: "cloud", limit: 3 });
    const selected = result.matches.find(match => match.source.id === ids.get(item.expectedSource));
    assert(selected, item.id); assert.equal(service.readPassage(selected.passage.id, "fixture", "cloud").passage.text, selected.passage.text); passed++;
  }
  assert.equal(passed, 150);
});

test("sqlite-vec ranks authorized evidence beyond the previous 4096-vector prefix", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-native-vectors-"));
  const provider: LocalEmbeddingProvider = { identity: { id: "vector-fixture", version: "1", dimensions: 2, local: true }, async embed(texts) { return texts.map(() => [1, 0]); } };
  let service = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider });
  const base = await imported(service, "original", "A bounded source fixture."); service.close();
  const db = new DatabaseSync(path.join(directory, "knowledge", "knowledge.sqlite")); db.exec("PRAGMA foreign_keys=ON; BEGIN");
  const passage = db.prepare("INSERT INTO passages VALUES (?,?,?,?)"), vector = db.prepare("INSERT INTO passage_embeddings VALUES (?,?,?,?,?,?)");
  for (let index = 0; index < 4100; index++) {
    const id = `generated-${String(index).padStart(5, "0")}`, text = index === 4099 ? "The decisive relevant specimen." : "Unrelated filler.";
    const value = { ...base.passages[0], id, ordinal: index + 1, text };
    passage.run(id, base.source.id, "fixture", JSON.stringify(value));
    vector.run(id, embeddingKey(provider.identity), 2, createHash("sha256").update(text).digest("hex"), encodeVector(index === 4099 ? [1, 0] : [0, 1]), "2026-11-09T12:00:00.000Z");
  }
  db.exec("COMMIT"); db.close();
  service = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await service.retrieveContext({ projectId: "fixture", query: "semantic-only question", purpose: "cloud" });
  assert.equal(result.retrieval.vectorEngine, "sqlite_vec_exact");
  assert.equal(result.matches[0].passage.id, "generated-04099");
  assert.equal(result.retrieval.coverage.vectorScanLimited, false);
});

test("background indexing is resumable and shared query embeddings are deduplicated without document inference in turns", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-index-jobs-"));
  const calls: { texts: readonly string[]; purpose?: string }[] = [];
  const provider = sharedEmbeddingProvider({ identity: { id: "background-fixture", version: "1", dimensions: 2, local: true }, async embed(texts, options) {
    calls.push({ texts, purpose: options.purpose }); return texts.map(() => [1, 0]);
  } });
  let service = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider, backgroundIndexing: true });
  await imported(service, "pending", "An indexed background document.");
  service.queueIndexing("fixture", "pause"); service.close();
  service = await KnowledgeService.open({ dataDirectory: directory, enabled: true, embeddingProvider: provider, backgroundIndexing: true });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(service.indexingStatus("fixture").state, "paused");
  service.queueIndexing("fixture", "resume");
  for (let attempt = 0; attempt < 100 && service.indexingStatus("fixture").state !== "complete"; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.indexingStatus("fixture").state, "complete");
  const documents = calls.filter(call => call.purpose === "document").length;
  await Promise.all([service.retrieveContext({ projectId: "fixture", purpose: "cloud", query: "background document" }), service.retrieveContext({ projectId: "fixture", purpose: "cloud", query: "background document" })]);
  assert.equal(calls.filter(call => call.purpose === "document").length, documents);
  assert.equal(calls.filter(call => call.purpose === "query").length, 1);
});

test("format-aware sections and relevant spans preserve exact evidence near a long passage end", async () => {
  const markdown = passageParts([{ page: null, text: "# Methods\nFirst method.\n\n## Results\nA measurable result." }], { filename: "paper.md" });
  assert.equal(markdown.at(-1)!.locator.section, "Methods / Results");
  const code = passageParts([{ page: null, text: "def first():\n  return 1\n\ndef second():\n  return 2" }], { filename: "code.py" });
  assert.equal(code.at(-1)!.locator.symbol, "second");
  const text = "Introductory material. ".repeat(150) + "Critical lithium result: the measured capacity is 42 units.";
  const assembler = createContextAssembler({ authorizeScope() {}, providers: { source: {
    async retrieve() { return { candidates: [{ id: "passage", kind: "source", projectId: "project", revision: 1, title: "Long passage", text, score: 1,
      citations: [{ sourceVersionId: "source", passageId: "passage" }], provenance: { origin: "original_source", referenceId: "source", revision: 1 } }] }; }, authorize() { return true; },
  } } });
  const packet = await assembler.assemble({ scope: { projectId: "project", conversationId: null, taskId: null }, purpose: "cloud", query: "critical lithium capacity", currentTurn: { text: "Explain the result" } });
  const selected = packet.selections[0]; assert(selected.text.includes("42 units")); assert(selected.span);
  assert.equal(text.slice(selected.span.start, selected.span.end), selected.text);
});
