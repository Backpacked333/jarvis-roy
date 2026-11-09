import { createHash } from "node:crypto";
import { getDataDirectory } from "../agent/lib/persistence.ts";
import { ContinuityService } from "./continuity/index.ts";
import type { JarvisService } from "./service.ts";
import type { KnowledgeService } from "./knowledge/index.ts";
import type { MemoryService } from "./memory/index.ts";

export async function createContinuityRuntime(runtime: JarvisService, knowledge: KnowledgeService, memory: MemoryService,
  options: { dataDirectory?: string; enabled?: boolean; onError?: (code: "continuity_persistence_failed") => void } = {}) {
  let continuity: ContinuityService;
  continuity = await ContinuityService.open({ dataDirectory: options.dataDirectory ?? getDataDirectory(), enabled: options.enabled ?? (knowledge.enabled || memory.enabled),
    authorizeReference(reference, access) {
      try {
        if (reference.kind === "source") {
          const value = knowledge.readPassage(reference.id, access.projectId, access.purpose);
          return value.source.id === reference.sourceVersionId && value.source.revision === reference.revision &&
            (!reference.originalSha256 || createHash("sha256").update(value.passage.text).digest("hex") === reference.originalSha256);
        }
        if (reference.kind === "memory") return memory.authorize(reference, access);
        if (reference.kind === "checkpoint") return continuity.authorizeCheckpoint(reference.id, reference.revision, access.projectId, access.purpose);
        return runtime.contextSnapshot(access.projectId, reference.conversationId).messages.some(message => message.id === reference.id);
      } catch { return false; }
    } });
  const recorded = new Set<string>(); let errorCode: string | null = null;
  const synchronize = () => {
    if (!continuity.enabled) return;
    for (const task of runtime.committedTaskContexts()) {
      const eventId = `${task.taskId}:${task.status}`;
      if (recorded.has(eventId)) continue;
      try {
        if (continuity.hasCommittedTaskObservation(task.projectId, eventId, task.taskId, task.status, task.goal.slice(0, 8000))) {
          recorded.add(eventId); continue;
        }
        // Store direct user goals and observed task state. Assistant replies can
        // include revoked excerpts, so they are deliberately not summarized here.
        continuity.recordCommittedTask({ ...task, goal: task.goal.slice(0, 8000), eventId, references: [],
          outcomeAuthority: "runtime_status", dependenciesComplete: true });
        recorded.add(eventId);
      } catch {
        errorCode = "continuity_persistence_failed";
        if (options.onError) options.onError("continuity_persistence_failed");
        else process.stderr.write('{"version":1,"name":"continuity.persistence_failed"}\n');
      }
    }
  };
  synchronize();
  const unsubscribe = runtime.subscribeTasks(synchronize);
  return { service: continuity, synchronize, status: () => ({ errorCode }), close() { unsubscribe(); continuity.close(); } };
}
