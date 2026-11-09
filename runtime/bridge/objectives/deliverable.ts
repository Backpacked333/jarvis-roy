import { BridgeError } from "../errors.ts";
import type { ResearchService } from "../research/index.ts";
import type { HarnessService } from "../harness-contracts/service.ts";
import type { ArtifactManifest, Run } from "../harness-contracts/domain.ts";
import type { ObjectiveService } from "./index.ts";
import type { ChildRunRef, Objective } from "./contracts.ts";

export interface ObjectiveDeliverable {
  version: 1;
  objective: Pick<Objective, "id" | "projectId" | "title" | "revision" | "status">;
  checkpoint: { id: string; verification: "unverified_summary"; childRefs: ChildRunRef[];
    artifactRefs: { id: string; digest: string }[]; summaryStatus: "withheld_source_lineage_cannot_be_revalidated" } | null;
  research: { attemptId: string; stepId: string; ref: ChildRunRef; result: ReturnType<ResearchService["result"]> }[];
  workers: { attemptId: string; stepId: string; ref: ChildRunRef; run: Pick<Run, "id" | "revision" | "status" | "planId" | "planRevision" | "planDigest" | "nodes" | "usage">;
    imageDigest: string | null; artifacts: (ArtifactManifest & { contentPath: string })[]; omittedArtifacts: number }[];
  unavailable: { attemptId: string; stepId: string; ref: ChildRunRef; reason: "authority_unavailable" | "not_complete_or_binding_changed" | "access_unavailable" | "response_budget" }[];
  budget: { maxBytes: number; bytes: number; omittedEntries: number };
  verification: "research_claims_and_model_critique_require_review_worker_checks_only_establish_recorded_command_outcomes";
}

/** A read-only join of exact child authorities. No new execution, model call or
 * inference upgrades a completed task into a verified claim. */
export async function objectiveDeliverable(service: ObjectiveService, id: string, projectId: string,
  research?: ResearchService, harness?: HarnessService): Promise<ObjectiveDeliverable> {
  const objective = service.get(id, projectId), maxBytes = 512_000;
  const packet: ObjectiveDeliverable = {
    version: 1, objective: { id, projectId, title: objective.title, revision: objective.revision, status: objective.status },
    checkpoint: objective.checkpoint ? { id: objective.checkpoint.id, verification: "unverified_summary", childRefs: objective.checkpoint.childRefs,
      artifactRefs: objective.checkpoint.artifactRefs, summaryStatus: "withheld_source_lineage_cannot_be_revalidated" } : null,
    research: [], workers: [], unavailable: [], budget: { maxBytes, bytes: 0, omittedEntries: 0 },
    verification: "research_claims_and_model_critique_require_review_worker_checks_only_establish_recorded_command_outcomes",
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(packet));
  const unavailable = (attempt: Objective["attempts"][number], reason: ObjectiveDeliverable["unavailable"][number]["reason"]) => {
    packet.unavailable.push({ attemptId: attempt.id, stepId: attempt.stepId, ref: attempt.child!, reason });
  };
  // Finish asynchronous authority reads before opening source-backed research
  // results. No await follows their current-grant checks before publication.
  const state = harness ? await harness.state().catch(() => null) : null;
  if (service.get(id, projectId).revision !== objective.revision) throw new BridgeError("Objective changed while assembling its deliverable; refresh it.", 409);
  for (const attempt of objective.attempts) {
    const ref = attempt.child; if (!ref) continue;
    if (attempt.status !== "completed") { unavailable(attempt, "not_complete_or_binding_changed"); continue; }
    if (ref.projectId !== projectId) throw new BridgeError("Objective child scope differs from its project.", 409);
    if (ref.authority === "research") {
      if (!research?.enabled) { unavailable(attempt, "authority_unavailable"); continue; }
      try {
        const result = research.result(ref.runId, projectId);
        packet.research.push({ attemptId: attempt.id, stepId: attempt.stepId, ref, result });
        if (bytes() > maxBytes - 32_000) { packet.research.pop(); packet.budget.omittedEntries++; unavailable(attempt, "response_budget"); }
      } catch { unavailable(attempt, "access_unavailable"); }
    } else if (ref.authority === "harness") {
      if (!state?.ready) { unavailable(attempt, "authority_unavailable"); continue; }
      const run = state.runs.find(value => value.id === ref.runId && value.roomId === projectId && value.roomId === ref.roomId);
      if (!run || run.status !== "completed" || run.planId !== ref.planId || run.planDigest !== ref.planDigest) { unavailable(attempt, "not_complete_or_binding_changed"); continue; }
      const artifactIds = new Set(run.nodes.flatMap(node => node.artifactIds));
      const artifacts = state.artifacts.filter(value => value.roomId === projectId && value.runId === run.id && value.planDigest === run.planDigest && artifactIds.has(value.id));
      const item: ObjectiveDeliverable["workers"][number] = {
        attemptId: attempt.id, stepId: attempt.stepId, ref,
        run: { id: run.id, revision: run.revision, status: run.status, planId: run.planId, planRevision: run.planRevision, planDigest: run.planDigest, nodes: run.nodes, usage: run.usage },
        imageDigest: run.policy.sandbox.image, artifacts: [], omittedArtifacts: artifacts.length,
      };
      packet.workers.push(item);
      if (bytes() > maxBytes - 32_000) { packet.workers.pop(); packet.budget.omittedEntries++; unavailable(attempt, "response_budget"); continue; }
      for (const artifact of artifacts) {
        item.artifacts.push({ ...artifact, contentPath: `/v1/harness/rooms/${ref.roomId}/runs/${ref.runId}/artifacts/${artifact.id}/content` }); item.omittedArtifacts--;
        if (bytes() > maxBytes - 32_000) { item.artifacts.pop(); item.omittedArtifacts++; }
      }
    } else unavailable(attempt, "authority_unavailable");
  }
  // The metadata allowance above is an optimization, not the bound: retained
  // histories may contain many long exact references. Enforce the serialized
  // limit again after all unavailable-entry metadata has been assembled.
  while (bytes() > maxBytes - 16 && (packet.workers.length || packet.research.length)) {
    const removed = packet.workers.length ? packet.workers.pop()! : packet.research.pop()!;
    packet.unavailable.push({ attemptId: removed.attemptId, stepId: removed.stepId, ref: removed.ref, reason: "response_budget" });
    packet.budget.omittedEntries++;
  }
  if (bytes() > maxBytes - 16) throw new BridgeError("Objective reference metadata exceeds its review-package bound.", 413);
  for (let pass = 0; pass < 3; pass++) packet.budget.bytes = bytes();
  return packet;
}
