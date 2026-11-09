import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KnowledgeService, type GrantInput } from "../bridge/knowledge/index.ts";
import { deleteMemory, rememberPreference } from "../agent/lib/memory.ts";
import { createKnowledgeAgentPort } from "../bridge/knowledge/agent-tools.ts";

const native = { nativeAuthenticated: true }, model = { nativeAuthenticated: false };
const url = (route: string) => new URL(`http://127.0.0.1:39202${route}`);
const grantInput = (overrides: Partial<GrantInput> = {}): GrantInput => ({ projectId: "project-a", resourceKind: "file", resourceId: "picked-file-1", label: "Selected research paper", operations: ["read_document"], cloudAllowed: true, expiresAt: null, ...overrides });
const upload = (grantId: string, content = "First line\nQuantum evidence supports this observation.\nThird line", extra = {}) => ({ projectId: "project-a", grantId, resourceId: "picked-file-1", filename: "paper.md", title: "Paper", mediaType: "text/markdown", bytesBase64: Buffer.from(content).toString("base64"), ...extra });
async function fixture(t: { after: (callback: () => Promise<void>) => void }, options: Partial<Parameters<typeof KnowledgeService.open>[0]> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-knowledge-"));
  const service = await KnowledgeService.open({ dataDirectory: directory, enabled: true, ...options });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service };
}

test("knowledge defaults off and native-only operations cannot be invoked by a model token", async t => {
  const { service } = await fixture(t);
  const disabled = await KnowledgeService.open({ dataDirectory: "/unused", enabled: false });
  assert.equal((await disabled.route("GET", url("/v1/knowledge/status"), undefined, model))?.status, 200);
  await assert.rejects(disabled.route("POST", url("/v1/knowledge/search"), {}, model), /disabled/);
  for (const [method, route, body] of [
    ["POST", "/v1/grants", grantInput()], ["GET", "/v1/grants?projectId=project-a", undefined],
    ["POST", "/v1/knowledge/import", upload("x")], ["GET", "/v1/knowledge/export?projectId=project-a", undefined],
    ["POST", "/v1/knowledge/search", { projectId: "project-a", query: "paper", purpose: "local" }],
    ["GET", "/v1/knowledge/sources?projectId=project-a&purpose=local", undefined],
  ] as const) await assert.rejects(service.route(method, url(route), body, model), /trusted native/);
});

test("source originals, passage locators, versions, archive and FTS survive restart", async t => {
  const { directory, service } = await fixture(t);
  const grant = service.createGrant(grantInput());
  const first = await service.importSource(upload(grant.id));
  assert.equal(first.passages[0].locator.lineStart, 1);
  assert.equal(first.passages[0].locator.lineEnd, 3);
  const result = service.search({ projectId: "project-a", query: "quantum", purpose: "cloud" });
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].source.id, first.source.id);
  const second = await service.importSource(upload(grant.id, "Revised quantum evidence", { sourceId: first.source.sourceId }));
  assert.equal(second.source.revision, 2);
  assert.equal(service.search({ projectId: "project-a", query: "quantum", purpose: "cloud" }).matches[0].source.id, second.source.id);
  assert.equal(service.readSource(first.source.id, "project-a", "cloud").source.revision, 1);
  service.archiveSource(second.source.id, "project-a", true);
  assert.equal(service.search({ projectId: "project-a", query: "quantum", purpose: "cloud" }).matches.length, 0);
  assert.equal(service.search({ projectId: "project-a", query: "quantum", purpose: "cloud", includeArchived: true }).matches.length, 1);
  service.archiveSource(second.source.id, "project-a", false);
  service.close();
  const restored = await KnowledgeService.open({ dataDirectory: directory, enabled: true });
  t.after(async () => restored.close());
  assert.equal(restored.listSources("project-a").length, 1);
  const exported = await restored.exportProject("project-a");
  assert.equal(exported.sources.length, 2);
  assert.equal(Buffer.from(exported.sources[1].bytesBase64, "base64").toString(), "Revised quantum evidence");
  assert.equal(exported.sources[1].source.sha256, createHash("sha256").update("Revised quantum evidence").digest("hex"));
});

test("project scope, source scope and cloud-use permission are independent and fail closed", async t => {
  const { service } = await fixture(t);
  const grant = service.createGrant(grantInput({ cloudAllowed: false }));
  const { source } = await service.importSource(upload(grant.id));
  assert.equal(service.search({ projectId: "project-a", query: "quantum", purpose: "local" }).matches.length, 1);
  assert.equal(service.search({ projectId: "project-a", query: "quantum", purpose: "cloud" }).matches.length, 0);
  assert.equal(service.search({ projectId: "project-b", query: "quantum", purpose: "local" }).matches.length, 0);
  assert.throws(() => service.readSource(source.id, "project-a", "cloud"), /cloud disclosure/);
  assert.throws(() => service.readSource(source.id, "project-b", "local"), /not found/);
  await assert.rejects(service.importSource(upload(grant.id, "text", { resourceId: "another-file" })), /outside/);
  await assert.rejects(service.importSource(upload(grant.id, "text", { projectId: "project-b" })), /outside/);
  assert.throws(() => service.requireGrant({ grantId: grant.id, projectId: "project-a", resourceId: "picked-file-1", operation: "read_mail", purpose: "local" }), /outside/);
});

test("revocation aborts active reads and prevents a queued result from reaching cloud", async t => {
  const { service } = await fixture(t); const grant = service.createGrant(grantInput());
  let finish!: (value: string) => void, observed: AbortSignal | undefined;
  const pending = service.withGrant({ grantId: grant.id, projectId: "project-a", resourceId: "picked-file-1", operation: "read_document", purpose: "cloud" }, async signal => {
    observed = signal; return new Promise<string>(resolve => { finish = resolve; });
  });
  service.revokeGrant(grant.id, 1); assert.equal(observed?.aborted, true); finish("private result");
  await assert.rejects(pending);
  assert.throws(() => service.revokeGrant(grant.id, 1), /changed/);
});

test("Stop all aborts current reads without revoking a user's persistent grant", async t => {
  const { service } = await fixture(t); const grant = service.createGrant(grantInput());
  let finish!: () => void;
  const input = { grantId: grant.id, projectId: "project-a", resourceId: "picked-file-1", operation: "read_document" as const, purpose: "cloud" as const };
  const pending = service.withGrant(input, async () => { await new Promise<void>(resolve => { finish = resolve; }); return "late private text"; });
  service.cancelReads(); finish(); await assert.rejects(pending);
  assert.equal(service.requireGrant(input).revokedAt, null);
  assert.equal(await service.withGrant(input, async () => "fresh explicitly requested read"), "fresh explicitly requested read");
});

test("grant expiry is enforced at disclosure and cannot be extended through model data", async t => {
  let now = new Date("2026-01-01T00:00:00Z");
  const { service } = await fixture(t, { now: () => now });
  const grant = service.createGrant(grantInput({ expiresAt: "2026-01-01T00:01:00Z" }));
  const { source } = await service.importSource(upload(grant.id));
  now = new Date("2026-01-01T00:02:00Z");
  assert.throws(() => service.readSource(source.id, "project-a", "cloud"), /outside/);
  assert.equal(service.listSources("project-a", "local").length, 0);
  assert.throws(() => service.createGrant(grantInput({ expiresAt: "2025-01-01T00:01:00Z" })), /future/);
});

test("native grant revisions can change cloud consent without widening source scope", async t => {
  const { service } = await fixture(t); const grant = service.createGrant(grantInput({ cloudAllowed: false }));
  const imported = await service.importSource(upload(grant.id));
  const endpoint = url(`/v1/grants/${grant.id}`);
  await assert.rejects(service.route("PATCH", endpoint, { expectedRevision: 1, cloudAllowed: true }, model), /trusted native/);
  const changed = await service.route("PATCH", endpoint, { expectedRevision: 1, cloudAllowed: true }, native);
  assert.equal((changed?.body as { revision: number }).revision, 2);
  assert.equal(service.readSource(imported.source.id, "project-a", "cloud").source.id, imported.source.id);
  assert.throws(() => service.updateGrant(grant.id, 1, { cloudAllowed: false }), /changed/);
  await assert.rejects(service.route("PATCH", endpoint, { expectedRevision: 2, resourceId: "broader-source" }, native));
  service.updateGrant(grant.id, 2, { cloudAllowed: false });
  assert.throws(() => service.readSource(imported.source.id, "project-a", "cloud"), /outside/);
  service.revokeGrant(grant.id, 3);
  assert.throws(() => service.updateGrant(grant.id, 4, { cloudAllowed: true }), /revoked/);
});

test("PDF import preserves page identity and refuses unsupported or malformed input", async t => {
  const { service } = await fixture(t, { extractPdf: async () => [{ text: "First page evidence", page: 1 }, { text: "Second page finding", page: 2 }] });
  const grant = service.createGrant(grantInput());
  const pdf = await service.importSource(upload(grant.id, "%PDF-fixture", { filename: "paper.pdf", mediaType: "application/pdf" }));
  assert.equal(pdf.source.extraction, "pdf_text"); assert.deepEqual(pdf.passages.map(item => item.locator.page), [1, 2]);
  await assert.rejects(service.importSource(upload(grant.id, "not a pdf", { filename: "bad.pdf", mediaType: "application/pdf" })), /not a PDF/);
  await assert.rejects(service.importSource(upload(grant.id, "binary", { filename: "a.exe", mediaType: "application/octet-stream" })), /Unsupported/);
  await assert.rejects(service.importSource(upload(grant.id, "text", { filename: "../paper.md" })));
  await assert.rejects(service.importSource(upload(grant.id, "text", { bytesBase64: "not base64" })), /Invalid/);
  await assert.rejects(service.importSource(upload(grant.id, "password: fixture-secret")), /credential/);
  const nativePdf = await service.importSource(upload(grant.id, "%PDF-native-fixture", { filename: "native.pdf", mediaType: "application/pdf", nativePDFPages: ["PDFKit page one", "PDFKit page two"] }));
  assert.deepEqual(nativePdf.passages.map(passage => passage.text), ["PDFKit page one", "PDFKit page two"]);
});

test("revocation while a PDF extractor runs prevents source publication", async t => {
  let release!: () => void;
  const { service } = await fixture(t, { extractPdf: async () => { await new Promise<void>(resolve => { release = resolve; }); return [{ text: "private", page: 1 }]; } });
  const grant = service.createGrant(grantInput());
  const pending = service.importSource(upload(grant.id, "%PDF-fixture", { filename: "paper.pdf", mediaType: "application/pdf" }));
  service.revokeGrant(grant.id, 1); release();
  await assert.rejects(pending); assert.equal(service.listSources("project-a", "local").length, 0);
});

test("scholarly retrieval uses fixed providers and clearly labels metadata-only evidence", async t => {
  const requests: string[] = [];
  const { service } = await fixture(t, { fetch: (async (input, init) => {
    const endpoint = String(input); requests.push(endpoint); assert.equal(init?.redirect, "error");
    if (endpoint.startsWith("https://api.crossref.org/works?")) return Response.json({ message: { items: [{ DOI: "10.1234/example", title: ["A paper"], abstract: "<p>A small abstract.</p>" }] } });
    assert.ok(endpoint.startsWith("https://export.arxiv.org/api/query?"));
    return new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.00001</id><title>Another paper</title><summary>Quantum abstract</summary></entry></feed>');
  }) as typeof fetch });
  for (const provider of ["crossref", "arxiv"] as const) {
    const result = await service.retrieve({ projectId: "project-a", provider, query: "quantum", maxResults: 1 });
    assert.equal(result.sources.length, 1); assert.equal(result.sources[0].source.extraction, "metadata_only");
    assert.equal(result.usage.estimatedUsd, null); assert.equal(result.usage.accounting, "provider_cost_unavailable");
    assert.match(result.sources[0].passages[0].text, /full text was not retrieved/);
  }
  assert.equal(requests.length, 2); assert.equal(service.listSources("project-b").length, 0);
});

test("deliverables verify exact citations and preserve the distinction between reported checks and proof", async t => {
  const { service } = await fixture(t); const grant = service.createGrant(grantInput());
  const source = await service.importSource(upload(grant.id));
  const input = { projectId: "project-a", title: "Research brief", markdown: "A cited brief.", claims: [{ text: "Quantum observation", status: "supported" as const, citations: [{ passageId: source.passages[0].id, quote: "Quantum evidence supports this observation." }] }], unresolved: ["Needs independent replication"], checks: [{ description: "Reported computation", result: "passed" as const, artifactId: null }] };
  const result = service.createDeliverable(input);
  assert.equal(result.citationCheck, "locators_and_quotes_verified"); assert.equal(result.critique, "requires_review");
  assert.equal(result.checkAuthority, "reported_not_independently_verified");
  assert.throws(() => service.createDeliverable({ ...input, projectId: "project-b" }), /does not belong/);
  assert.throws(() => service.createDeliverable({ ...input, claims: [{ ...input.claims[0], citations: [{ passageId: source.passages[0].id, quote: "fabricated quote" }] }] }), /does not match/);
  assert.throws(() => service.createDeliverable({ ...input, claims: [{ ...input.claims[0], citations: [] }] }), /requires a source/);
  service.revokeGrant(grant.id, 1);
  assert.throws(() => service.readDeliverable(result.id, "project-a", "cloud"), /outside/);
});

test("source deletion removes FTS and unreferenced bytes, export rejects tampered source blobs", async t => {
  const { directory, service } = await fixture(t); const grant = service.createGrant(grantInput());
  const first = await service.importSource(upload(grant.id));
  const file = path.join(directory, "knowledge", "blobs", first.source.sha256);
  await writeFile(file, "tampered"); await assert.rejects(service.exportProject("project-a"), /integrity/);
  await service.deleteSource(first.source.id, "project-a");
  assert.equal(service.search({ projectId: "project-a", query: "quantum", purpose: "cloud" }).matches.length, 0);
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("knowledge rejects symlink databases and keeps existing preference migration backed up", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-knowledge-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = await rememberPreference("Prefer concise technical explanations", undefined, directory);
  const service = await KnowledgeService.open({ dataDirectory: directory, enabled: true });
  const result = await service.route("GET", url("/v1/knowledge/preferences"), undefined, native);
  assert.equal((result!.body as { preferences: { id: string }[] }).preferences[0].id, legacy.id);
  const backup = JSON.parse(await readFile(path.join(directory, "knowledge", "legacy-preferences-v1.backup.json"), "utf8"));
  assert.equal(backup.records[0].id, legacy.id);
  assert.equal(JSON.parse(await readFile(path.join(directory, "memories", `${legacy.id}.json`), "utf8")).id, legacy.id);
  await deleteMemory(legacy.id, directory);
  service.deletePreference(legacy.id);
  assert.equal(((await service.route("GET", url("/v1/knowledge/preferences"), undefined, native))!.body as { preferences: unknown[] }).preferences.length, 0);
  service.close();
  await rm(path.join(directory, "knowledge", "knowledge.sqlite"));
  await symlink(path.join(directory, "memories", `${legacy.id}.json`), path.join(directory, "knowledge", "knowledge.sqlite"));
  await assert.rejects(KnowledgeService.open({ dataDirectory: directory, enabled: true }), /Unsafe knowledge/);
});

test("personal preference index follows approved memory additions, corrections and deletion while knowledge is disabled", async t => {
  let now = new Date("2026-11-08T10:00:00.000Z");
  const { directory, service } = await fixture(t, { now: () => now });
  const preferences = async (store: KnowledgeService) => ((await store.route("GET", url("/v1/knowledge/preferences"), undefined, native))!.body as {
    preferences: { id: string; text: string; importedAt: string }[];
  }).preferences;
  const first = await rememberPreference("Prefer concise explanations", undefined, directory);
  const indexed = await preferences(service);
  assert.deepEqual(indexed.map(entry => entry.id), [first.id]);
  now = new Date("2026-11-08T11:00:00.000Z");
  await writeFile(path.join(directory, "memories", `${first.id}.json`), JSON.stringify({ ...first, text: "Prefer detailed calculations" }));
  const corrected = await preferences(service);
  assert.equal(corrected[0].text, "Prefer detailed calculations");
  assert.equal(corrected[0].importedAt, indexed[0].importedAt, "corrections preserve index provenance");
  const backupFile = path.join(directory, "knowledge", "legacy-preferences-v1.backup.json");
  const originalBackup = await readFile(backupFile, "utf8");
  service.close();
  const disabled = await KnowledgeService.open({ dataDirectory: directory, enabled: false });
  await deleteMemory(first.id, directory);
  disabled.deletePreference(first.id);
  const second = await rememberPreference("Use metric units", undefined, directory);
  disabled.close();
  const restored = await KnowledgeService.open({ dataDirectory: directory, enabled: true, now: () => now });
  t.after(async () => restored.close());
  assert.deepEqual((await preferences(restored)).map(entry => ({ id: entry.id, text: entry.text })), [second]);
  assert.equal(await readFile(backupFile, "utf8"), originalBackup, "reconciliation does not rewrite the migration backup");
  await assert.rejects(restored.route("GET", url("/v1/knowledge/preferences"), undefined, model), /trusted native/);
});

test("agent knowledge transport always binds the Eve session and cloud purpose without native authority", async t => {
  const original = process.env.JARVIS_LOCAL_TOKEN;
  process.env.JARVIS_LOCAL_TOKEN = "knowledge-fixture-local-token-with-32-characters";
  t.after(async () => { if (original === undefined) delete process.env.JARVIS_LOCAL_TOKEN; else process.env.JARVIS_LOCAL_TOKEN = original; });
  let calls = 0;
  const fetcher = (async (input, init) => {
    calls++; assert.equal(String(input), "http://127.0.0.1:39202/v1/knowledge/context");
    const headers = new Headers(init?.headers); assert.equal(headers.get("x-jarvis-eve-session"), "eve-current"); assert.equal(headers.get("x-jarvis-native-token"), null);
    assert.equal(JSON.parse(String(init?.body)).purpose, "cloud"); assert.equal(init?.redirect, "error");
    assert.equal(JSON.parse(String(init?.body)).indexBudget, 8); assert.equal(JSON.parse(String(init?.body)).maxPerSource, 2);
    return Response.json({ matches: [], contentTrust: "untrusted" });
  }) as typeof fetch;
  const context = { sessionId: "eve-current", delegated: false, signal: new AbortController().signal };
  await createKnowledgeAgentPort(context, fetcher).search({ projectId: "project-a", query: "evidence", limit: 4 });
  await assert.rejects(createKnowledgeAgentPort({ ...context, delegated: true }, fetcher).search({ projectId: "project-a", query: "evidence", limit: 4 }), /root assistant/);
  assert.equal(calls, 1);
});
