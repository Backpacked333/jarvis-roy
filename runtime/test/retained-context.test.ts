import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createRetainedContextProviders } from "../bridge/retained-context.ts";
import { createContextAssembler } from "../bridge/context/index.ts";
const text = "Retained fatigue evidence is limited to this approved snapshot.";
const snapshot = { version: 1, kind: "source", id: "selected-source", revision: 2, sha256: createHash("sha256").update(text).digest("hex"),
  text, grantId: "grant", grantRevision: 3, projectId: "project", deviceId: "device", syncedAt: "2026-11-09T12:00:00.000Z" };
const request = { scope: { projectId: "project", conversationId: "conversation", taskId: "task" }, purpose: "cloud", query: "fatigue evidence", currentTurn: { text: "Review fatigue" } };
test("retained snapshots require exact project/digest and a fresh authoritative grant check at final disclosure", async () => {
  let allowed = true, checks = 0;
  const fetcher = (async (input, init) => {
    assert.equal(new Headers(init?.headers).get("x-jarvis-cloud-runtime-token"), "private-runtime-token-at-least-32-characters");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body)); assert.equal(body.projectId, "project"); assert.equal(body.processor, "context");
    if (String(input).endsWith("/authorize")) { checks++; assert.equal(body.references[0].grantRevision, 3); return Response.json({ authorized: allowed }); }
    return Response.json({ version: 1, snapshots: [snapshot] });
  }) as typeof fetch;
  const providers = createRetainedContextProviders({ runtimeToken: "private-runtime-token-at-least-32-characters", fetch: fetcher });
  const assembler = createContextAssembler({ providers, authorizeScope() {} });
  const packet = await assembler.assemble(request);
  assert.equal(packet.selections.length, 1); assert.equal(packet.selections[0].provenance.origin, "retained_snapshot");
  assert.equal(packet.selections[0].retention!.sha256, snapshot.sha256); assert(checks >= 1);
  allowed = false;
  await assert.rejects(assembler.revalidateAsync(packet), /permission changed/);
  await assert.rejects(assembler.assemble(request), /permission changed/);
});
test("retained broker outages produce explicit missing context while mixed projects and wrong digests fail closed", async () => {
  const unavailable = createContextAssembler({ authorizeScope() {}, providers: createRetainedContextProviders({ runtimeToken: "private-runtime-token-at-least-32-characters", fetch: (async () => new Response("", { status: 503 })) as typeof fetch }) });
  const missing = await unavailable.assemble(request);
  assert.equal(missing.selections.length, 0); assert(missing.retrieval.every(channel => channel.mode === "unavailable"));
  for (const bad of [{ ...snapshot, projectId: "foreign" }, { ...snapshot, text: "tampered text" }]) {
    const assembler = createContextAssembler({ authorizeScope() {}, providers: createRetainedContextProviders({ runtimeToken: "private-runtime-token-at-least-32-characters", fetch: (async () => Response.json({ version: 1, snapshots: [bad] })) as typeof fetch }) });
    await assert.rejects(assembler.assemble(request), /scope or digest/);
  }
});
