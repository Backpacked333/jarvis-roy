import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryService } from "../bridge/memory/index.ts";
const native = { nativeAuthenticated: true };
test("temporal assertions distinguish duplicate people, preserve reviewed history and resolve current versus historical facts", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-temporal-"));
  let service = await MemoryService.open({ dataDirectory: directory, enabled: true });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const entities: { id: string }[] = [];
  for (let index = 0; index < 2; index++) entities.push((await service.route("POST", new URL("http://localhost/v1/memory/entities"), { scope: { kind: "project", projectId: "project" }, label: "Alex", aliases: [] }, native))!.body as { id: string });
  assert.notEqual(entities[0].id, entities[1].id, "duplicate labels never merge identities");
  const make = (value: string, from: string, entity = entities[0].id) => ({ kind: "fact", scope: { kind: "project", projectId: "project" }, text: `Alex research city is ${value}`,
    provenance: { origin: "explicit_user", references: [] }, confidence: 1, pinned: false, expiresAt: null, cloudAllowed: true,
    assertion: { entityId: entity, property: "city", value, validFrom: from, validTo: null, observedAt: "2026-11-09T12:00:00.000Z" } });
  const older = await service.create(make("Paris", "2025-01-01T00:00:00.000Z"), native);
  const newer = await service.create(make("Berlin", "2026-01-01T00:00:00.000Z"), native);
  const conflicts = (await service.route("GET", new URL("http://localhost/v1/memory/conflicts?projectId=project"), undefined, native))!.body as { conflicts: unknown[] };
  assert.equal(conflicts.conflicts.length, 1);
  await service.supersede(older.id, { expectedRevision: older.revision, replacementId: newer.id, replacementRevision: newer.revision }, native);
  const access = { query: "Alex research city", projectId: "project", purpose: "cloud", limit: 10 };
  assert.deepEqual((await service.recall(access, native)).matches.map(match => match.entry.id), [newer.id]);
  assert.deepEqual((await service.recall({ ...access, asOf: "2025-06-01T00:00:00.000Z" }, native)).matches.map(match => match.entry.id), [older.id]);
  await service.close(); service = await MemoryService.open({ dataDirectory: directory, enabled: true });
  const history = (await service.route("GET", new URL(`http://localhost/v1/memory/entries/${older.id}/history`), undefined, native))!.body as { revisions: { revision: number }[] };
  assert.equal(history.revisions.length, 2);
  const corrected = await service.update(newer.id, { expectedRevision: newer.revision, input: make("Madrid", "2026-01-01T00:00:00.000Z") }, native);
  assert.equal((await service.recall(access, native)).matches.length, 0, "disputed prior fact is excluded while correction awaits review");
  await service.approve(corrected.id, { expectedRevision: corrected.revision, digest: corrected.digest }, native);
  assert.equal((await service.recall(access, native)).matches[0].entry.assertion!.value, "Madrid");
  const current = await service.inspect(older.id, native);
  await service.forget(current.id, { expectedRevision: current.revision }, native);
  await assert.rejects(service.route("GET", new URL(`http://localhost/v1/memory/entries/${older.id}/history`), undefined, native), /not found/);
});
