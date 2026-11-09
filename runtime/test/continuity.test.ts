import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ContinuityService } from "../bridge/continuity/index.ts";
import { createContextAssembler } from "../bridge/context/index.ts";

test("twenty projects retain five committed sessions each across restart without mixing scope or replaying effects", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-continuity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { dataDirectory: directory, enabled: true, authorizeReference: () => true };
  let service = await ContinuityService.open(config);
  for (let project = 0; project < 20; project++) for (let session = 0; session < 5; session++) {
    const input = { projectId: `project-${project}`, conversationId: `conversation-${project}-${session}`, taskId: `task-${project}-${session}`,
      eventId: `settled-${project}-${session}`, status: "completed" as const, goal: `Project ${project} session ${session}: review constraint ${project * 5 + session}`,
      occurredAt: `2026-11-0${session + 1}T12:00:00.000Z` };
    const episode = service.recordCommittedTask(input);
    assert.equal(service.recordCommittedTask(input).id, episode.id, "committed event delivery is idempotent");
  }
  service.updateWorkingSet("project-3", { expectedRevision: 0, pins: [{ kind: "source", id: "passage-3", revision: 2 }], goal: "Continue the reviewed draft" });
  service.close(); service = await ContinuityService.open(config);
  t.after(() => service.close());
  for (let project = 0; project < 20; project++) {
    const checkpoint = service.checkpoint(`project-${project}`, "cloud");
    assert.equal(checkpoint.episodes.length, 5);
    assert.equal(new Set(checkpoint.episodes.map(episode => episode.conversationId)).size, 5);
    assert(checkpoint.episodes.every(episode => episode.projectId === `project-${project}`));
    for (let session = 0; session < 5; session++) assert(checkpoint.text.includes(`constraint ${project * 5 + session}`));
    assert.equal(checkpoint.authority, "historical_reference_not_execution");
    assert(service.authorizeCheckpoint(checkpoint.id, checkpoint.revision, `project-${project}`, "cloud"));
  }
  assert.equal(service.getWorkingSet("project-3").pins[0].id, "passage-3");
  assert.throws(() => service.updateWorkingSet("project-3", { expectedRevision: 0, pins: [], goal: null }), /changed/);
  await assert.rejects(service.route("PUT", new URL("http://localhost/v1/continuity/working-set?projectId=project-3"), { expectedRevision: 1, pins: [], goal: null }, { nativeAuthenticated: false }), /native/);
});

test("project checkpoints reauthorize summary dependencies and context-use manifests persist no private text", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-continuity-authority-"));
  let permitted = true;
  const service = await ContinuityService.open({ dataDirectory: directory, enabled: true, authorizeReference: () => permitted });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  service.recordCommittedTask({ projectId: "project", conversationId: "old-session", taskId: "task", eventId: "first", status: "completed",
    goal: "Review source evidence", observedOutcome: "PRIVATE SUMMARY MUST NEVER ENTER A USAGE MANIFEST", outcomeAuthority: "unverified_summary", dependenciesComplete: true,
    references: [{ kind: "source", id: "passage", revision: 1, sourceVersionId: "source" }], occurredAt: "2026-11-09T12:00:00.000Z" });
  const checkpoint = service.checkpoint("project", "cloud");
  const assembler = createContextAssembler({ authorizeScope() {}, providers: { checkpoint: {
    async retrieve() { return { candidates: [{ id: checkpoint.id, kind: "checkpoint", projectId: "project", revision: checkpoint.revision, title: "Continuity", text: checkpoint.text,
      provenance: { origin: "project_checkpoint", referenceId: checkpoint.id, revision: checkpoint.revision } }] }; },
    authorize: candidate => service.authorizeCheckpoint(candidate.id, candidate.revision, "project", "cloud"),
  } } });
  const packet = await assembler.assemble({ scope: { projectId: "project", conversationId: "new-session", taskId: "new-task" }, purpose: "cloud", query: "source evidence", currentTurn: { text: "Continue" } });
  const manifest = service.recordContextUse(packet);
  assert.equal(manifest.selections.length, 1);
  assert(!JSON.stringify(manifest).includes("PRIVATE SUMMARY"));
  assert(!JSON.stringify(manifest).includes("Continue"));
  assert.equal(service.readManifest(manifest.id, "project", "cloud").selections[0].available, true);
  permitted = false;
  assert.equal(service.readManifest(manifest.id, "project", "cloud").selections[0].available, false);
  assert.equal(service.checkpoint("project", "cloud").episodes.length, 0);
  assert.throws(() => assembler.revalidate(packet), /permission/);
  assert.throws(() => service.readManifest(manifest.id, "other-project", "cloud"), /not found/);
});
