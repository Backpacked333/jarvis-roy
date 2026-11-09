import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createContextRuntime } from "../bridge/context-runtime.ts";
import { ContextPacketSchema } from "../bridge/context/index.ts";
import { KnowledgeService } from "../bridge/knowledge/index.ts";
import { MemoryService, type MemoryInput } from "../bridge/memory/index.ts";
import { JarvisService } from "../bridge/service.ts";
import { createBridgeServer, shutdownBridge } from "../bridge/server.ts";
import { FakeDelivery, FakeEveClient, completedEvents } from "./helpers.ts";

const token = "context-integration-local-auth-token-32-chars";
const nativeToken = "context-integration-native-auth-token-32-chars";
const native = { nativeAuthenticated: true };
const preference = (patch: Partial<MemoryInput> = {}): MemoryInput => ({ kind: "preference", scope: { kind: "global" },
  text: "Use metric units for battery capacity reports.", provenance: { origin: "explicit_user", references: [] },
  confidence: 1, pinned: false, expiresAt: null, cloudAllowed: true, ...patch });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-context-integration-"));
  const client = new FakeEveClient(); client.session.initial = new FakeDelivery(completedEvents(), { status: "completed" });
  const service = await JarvisService.create({ client, dataDirectory: directory, model: "fixture/model" });
  const task = await service.createTask("Explain battery capacity in metric units", undefined, "project-a");
  await service.drain();
  const knowledge = await KnowledgeService.open({ dataDirectory: directory, enabled: true });
  const memory = await MemoryService.open({ dataDirectory: directory, enabled: true,
    resolveSource(ref, access) {
      try { const current = knowledge.readSource(ref.sourceVersionId, ref.projectId, access.purpose);
        return ref.projectId === access.projectId && !current.source.archived && (!ref.passageId || current.passages.some(p => p.id === ref.passageId));
      } catch { return false; }
    },
  });
  const context = createContextRuntime(service, knowledge, memory);
  const previous = { local: process.env.JARVIS_LOCAL_TOKEN, native: process.env.JARVIS_NATIVE_TOKEN };
  process.env.JARVIS_LOCAL_TOKEN = token; process.env.JARVIS_NATIVE_TOKEN = nativeToken;
  const server = createBridgeServer(service, "127.0.0.1", 0, undefined, { extensions: { knowledge, memory, context,
    async close() { await memory.close(); knowledge.close(); },
  } });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await shutdownBridge(server); await rm(directory, { recursive: true, force: true });
    if (previous.local === undefined) delete process.env.JARVIS_LOCAL_TOKEN; else process.env.JARVIS_LOCAL_TOKEN = previous.local;
    if (previous.native === undefined) delete process.env.JARVIS_NATIVE_TOKEN; else process.env.JARVIS_NATIVE_TOKEN = previous.native;
  });
  const request = async (path: string, body: unknown, role: "native" | "agent" | "unbound" = "agent", expected = 200) => {
    const response = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      ...(role === "native" ? { "x-jarvis-native-token": nativeToken } : { "x-jarvis-eve-session": role === "agent" ? client.session.id : "unknown-session" }) }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result as any;
  };
  const source = async (projectId = "project-a", cloudAllowed = true) => {
    const grant = knowledge.createGrant({ projectId, resourceKind: "file", resourceId: `selected-${projectId}-${cloudAllowed}`, label: "Battery study",
      operations: ["read_document"], cloudAllowed, expiresAt: null });
    const imported = await knowledge.importSource({ projectId, grantId: grant.id, resourceId: grant.resourceId, filename: "battery.md",
      title: "Battery evidence", mediaType: "text/markdown", bytesBase64: Buffer.from(`Battery capacity measurements for ${projectId}, cloud=${cloudAllowed}: 42 watt hours.`).toString("base64") });
    return { grant, ...imported };
  };
  return { service, task, knowledge, memory, context, request, source };
}

test("automatic context combines authorized project RAG and relevant approved memory with bounded citations", async t => {
  const f = await fixture(t); const allowed = await f.source(); await f.source("project-a", false); await f.source("project-b");
  const approved = await f.memory.create(preference(), native);
  await f.memory.create(preference({ text: "Battery private personal data", cloudAllowed: false }), native);
  await f.memory.create(preference({ scope: { kind: "project", projectId: "project-b" }, text: "Battery facts from other project" }), native);
  await f.memory.propose(preference({ text: "Battery unapproved proposal" }), native);
  const response = await f.request("/v1/context/current", {});
  const packet = ContextPacketSchema.parse(JSON.parse(response.content));
  assert.equal(packet.scope.projectId, "project-a");
  assert.equal(packet.scope.conversationId, f.task.conversationId);
  assert.ok(packet.selections.some(item => item.kind === "source" && item.citations[0].sourceVersionId === allowed.source.id));
  assert.ok(packet.selections.some(item => item.kind === "memory" && item.id === approved.id));
  assert.doesNotMatch(response.content, /cloud=false|private personal|other project|unapproved proposal|Preference saved/);
  assert.ok(packet.usage.estimatedTokens <= packet.usage.maxTokens);
  assert.equal(packet.usage.serializedBytes, Buffer.byteLength(response.content));
  f.knowledge.revokeGrant(allowed.grant.id, allowed.grant.revision);
  await f.memory.forget(approved.id, { expectedRevision: approved.revision }, native);
  const replacement = await f.request("/v1/context/current", {});
  assert.doesNotMatch(replacement.content, /42 watt|Use metric units/);
});

test("context scope comes from the admitted session; native preview and cloud-purpose boundaries remain separate", async t => {
  const f = await fixture(t); await f.source("project-a", false);
  await f.request("/v1/context/current", { projectId: "project-b" }, "agent", 400);
  await f.request("/v1/context/current", {}, "unbound", 425);
  const preview = { version: 1, projectId: "project-a", query: "battery", purpose: "local", maxTokens: 12_000 };
  await f.request("/v1/context/assemble", preview, "agent", 403);
  const local = await f.request("/v1/context/assemble", preview, "native");
  assert.ok(local.selections.some((item: any) => item.kind === "source"));
  const cloud = await f.request("/v1/context/assemble", { ...preview, purpose: "cloud" }, "native");
  assert.equal(cloud.selections.length, 0);
  await f.request("/v1/context/assemble", { ...preview, version: 2 }, "native", 400);
  await f.request("/v1/context/assemble", { ...preview, projectId: "project-b", conversationId: f.task.conversationId }, "native", 403);
});

test("conversation proposals bind project provenance and require exact native review before automatic recall", async t => {
  const f = await fixture(t); const source = await f.source();
  const proposal = await f.request("/v1/memory/propose-current", { scope: "project", kind: "fact", text: "Battery source reports capacity of 42 watt hours.",
    cloudAllowed: true, sources: [{ sourceVersionId: source.source.id, passageId: source.passages[0].id }] }, "agent", 201);
  assert.equal(proposal.status, "proposed"); assert.equal(proposal.scope.projectId, "project-a");
  assert.equal(proposal.provenance.origin, "inferred");
  assert.equal(proposal.provenance.references[0].conversationId, f.task.conversationId);
  const recall = await f.request("/v1/memory/recall-current", { query: "battery" });
  assert.equal(recall.matches.length, 0);
  await f.request(`/v1/memory/entries/${proposal.id}/approve`, { expectedRevision: proposal.revision, digest: proposal.digest }, "agent", 403);
  await f.request(`/v1/memory/entries/${proposal.id}/approve`, { expectedRevision: proposal.revision, digest: proposal.digest }, "native");
  assert.equal((await f.request("/v1/memory/recall-current", { query: "battery" })).matches.length, 1);
  f.knowledge.revokeGrant(source.grant.id, source.grant.revision);
  assert.equal((await f.request("/v1/memory/recall-current", { query: "battery" })).matches.length, 0);
});
