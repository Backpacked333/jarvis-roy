import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { KnowledgeService } from "../bridge/knowledge/index.ts";
import { MemoryService } from "../bridge/memory/index.ts";
import { ContinuityService } from "../bridge/continuity/index.ts";
import { createContextRuntime } from "../bridge/context-runtime.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-audit-batch-"));
  const service = await KnowledgeService.open({ dataDirectory: directory, enabled: true });
  const grants = [], passages = [];
  for (const projectId of ["project-a", "project-b"]) {
    const grant = service.createGrant({ projectId, resourceKind: "file", resourceId: projectId, label: projectId, operations: ["read_document"], cloudAllowed: true, expiresAt: null });
    const imported = await service.importSource({ projectId, grantId: grant.id, resourceId: projectId, filename: "source.txt", title: projectId, mediaType: "text/plain", bytesBase64: Buffer.from(`Private ${projectId} fixture text.`).toString("base64") });
    grants.push(grant); passages.push(imported.passages[0]);
  }
  const db = (service as unknown as { connection: DatabaseSync }).connection;
  return { directory, service, db, grants, passages, async close() { service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("audit batches durably retain every exact read event and final synchronous authorization", async t => {
  const f = await fixture(); t.after(() => f.close());
  const before = Number(f.db.prepare("SELECT COUNT(*) AS total FROM access_log WHERE operation='passage_read'").get()!.total);
  const result = await f.service.withReadAuditBatch(async () => {
    f.service.readPassage(f.passages[0].id, "project-a", "cloud");
    await Promise.resolve(); return f.service.readPassage(f.passages[1].id, "project-b", "local");
  }, () => { f.service.readPassage(f.passages[1].id, "project-b", "local"); });
  assert.equal(result.source.projectId, "project-b");
  const rows = f.db.prepare("SELECT project_id,resource_id,purpose FROM access_log WHERE operation='passage_read' ORDER BY sequence").all();
  assert.equal(rows.length, before + 3);
  assert.deepEqual(rows.slice(-3).map(row => [row.project_id, row.resource_id, row.purpose]), [
    ["project-a", f.passages[0].id, "cloud"], ["project-b", f.passages[1].id, "local"], ["project-b", f.passages[1].id, "local"],
  ]);
  const read = f.service.withReadAuditBatchSync(() => f.service.readPassage(f.passages[0].id, "project-a", "cloud"));
  assert.equal(read.passage.id, f.passages[0].id);
  assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS total FROM access_log WHERE operation='passage_read'").get()!.total), before + 4);
});

test("a suspended batch holds no transaction and cannot return data after grant revocation", async t => {
  const f = await fixture(); t.after(() => f.close());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const pending = f.service.withReadAuditBatch(async () => {
    const data = f.service.readPassage(f.passages[0].id, "project-a", "cloud"); entered(); await gate; return data;
  }, () => { f.service.readPassage(f.passages[0].id, "project-a", "cloud"); });
  await started; assert.equal(f.db.isTransaction, false);
  const other = await f.service.withReadAuditBatch(async () => f.service.readPassage(f.passages[1].id, "project-b", "cloud"), () => {});
  assert.equal(other.source.projectId, "project-b");
  f.service.revokeGrant(f.grants[0].id, f.grants[0].revision); release();
  await assert.rejects(pending, /outside the current source grant/);
  assert.equal(f.db.isTransaction, false);
});

test("audit commit failures block asynchronous assembly and the synchronous disclosure boundary", async t => {
  const f = await fixture(); t.after(() => f.close());
  f.db.exec("CREATE TRIGGER deny_read_audit BEFORE INSERT ON access_log WHEN NEW.operation='passage_read' BEGIN SELECT RAISE(ABORT,'fixture audit disk failure'); END;");
  await assert.rejects(f.service.withReadAuditBatch(async () => f.service.readPassage(f.passages[0].id, "project-a", "cloud"), () => {}), /fixture audit disk failure/);
  assert.throws(() => f.service.withReadAuditBatchSync(() => f.service.readPassage(f.passages[0].id, "project-a", "cloud")), /fixture audit disk failure/);
  assert.equal(f.db.isTransaction, false);
});

test("detached work after an audit batch closes uses immediate durable auditing", async t => {
  const f = await fixture(); t.after(() => f.close());
  let release!: () => void, late!: Promise<unknown>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await f.service.withReadAuditBatch(async () => {
    late = gate.then(() => f.service.readPassage(f.passages[0].id, "project-a", "cloud"));
    return f.service.readPassage(f.passages[1].id, "project-b", "cloud");
  }, () => {});
  f.db.exec("CREATE TRIGGER deny_read_audit BEFORE INSERT ON access_log WHEN NEW.operation='passage_read' BEGIN SELECT RAISE(ABORT,'fixture audit disk failure'); END;");
  release(); await assert.rejects(late, /fixture audit disk failure/);
});

test("a failed audit commit cannot create a supplied-context manifest", async t => {
  const f = await fixture();
  const memory = await MemoryService.open({ dataDirectory: f.directory, enabled: false });
  const continuity = await ContinuityService.open({ dataDirectory: f.directory, enabled: true, authorizeReference: () => true });
  t.after(async () => { continuity.close(); await memory.close(); await f.close(); });
  const runtime = createContextRuntime({ contextSnapshot: () => ({ currentTurn: "Private fixture text", messages: [], actions: [] }) } as never, f.service, memory, continuity);
  const scope = { projectId: "project-a", conversationId: "conversation", taskId: "task" };
  f.db.exec("CREATE TRIGGER deny_read_audit BEFORE INSERT ON access_log WHEN NEW.operation='passage_read' BEGIN SELECT RAISE(ABORT,'fixture audit disk failure'); END;");
  await assert.rejects(runtime.current(scope), /fixture audit disk failure/);
  assert.equal(continuity.manifestsForTask(scope.taskId, scope.projectId).manifests.length, 0);
  f.db.exec("DROP TRIGGER deny_read_audit");
  await runtime.current(scope);
  assert.equal(continuity.manifestsForTask(scope.taskId, scope.projectId).manifests.length, 1);
});

test("nested read batches share outer durability without holding a transaction across awaits", async t => {
  const f = await fixture(); t.after(() => f.close());
  const before = Number(f.db.prepare("SELECT COUNT(*) AS total FROM access_log WHERE operation='passage_read'").get()!.total);
  await f.service.withReadAuditBatch(async () => {
    await f.service.withReadAuditBatch(async () => f.service.readPassage(f.passages[0].id, "project-a", "cloud"), () => {});
    f.service.withReadAuditBatchSync(() => f.service.readPassage(f.passages[1].id, "project-b", "local"));
    assert.equal(f.db.isTransaction, false);
    assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS total FROM access_log WHERE operation='passage_read'").get()!.total), before);
  }, () => {});
  assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS total FROM access_log WHERE operation='passage_read'").get()!.total), before + 2);
});
