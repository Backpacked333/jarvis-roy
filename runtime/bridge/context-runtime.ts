import { z } from "zod";
import { BridgeError } from "./errors.ts";
import { containsCredentialLikeData } from "../agent/lib/memory.ts";
import { createContextAssembler, ContextId, ContextPinSchema, type ContextCandidateInput, type ContextProvider } from "./context/index.ts";
import type { JarvisService } from "./service.ts";
import type { KnowledgeService } from "./knowledge/index.ts";
import type { MemoryEntry, MemoryService } from "./memory/index.ts";
import type { ContinuityService } from "./continuity/index.ts";
import { combineContextProviders } from "./retained-context.ts";

export const ContextPreviewSchema = z.strictObject({
  version: z.literal(1), projectId: ContextId, conversationId: ContextId.optional(),
  query: z.string().trim().min(1).max(1000), purpose: z.enum(["local", "cloud"]),
  maxTokens: z.number().int().min(512).max(12_000).default(12_000),
  maxItems: z.number().int().min(0).max(32).default(12), pins: z.array(ContextPinSchema).max(16).default([]),
});
export const ContextRecallSchema = z.strictObject({ query: z.string().trim().min(1).max(1000), maxTokens: z.number().int().min(512).max(12_000).default(6000) });

export function createContextRuntime(service: JarvisService, knowledge: KnowledgeService, memory: MemoryService, continuity?: ContinuityService, retained?: { source: ContextProvider; memory: ContextProvider }) {
  const source: ContextProvider = {
    async retrieve(input, signal) {
      if (!knowledge.enabled) return { candidates: [] };
      const result = await knowledge.retrieveContext({ projectId: input.scope.projectId, query: input.query,
        purpose: input.purpose, limit: 20, maxPerSource: 2, indexBudget: 0 }, signal);
      const matches = [...result.matches];
      for (const pin of input.pins) {
        if (matches.some(match => match.passage.id === pin.id)) continue;
        try {
          const item = knowledge.readPassage(pin.id, input.scope.projectId, input.purpose);
          matches.push({ ...item, explanation: { lanes: [], lexicalRank: null, vectorRank: null,
            cosine: null, bm25: null, rrf: 0, matchedTerms: [], queryCoverage: 0 } });
        } catch { /* Invalid or revoked pins remain explicit omissions. */ }
      }
      return { retrieval: { mode: result.retrieval.mode, warnings: result.retrieval.warnings.slice(0, 8).map(value => value.slice(0, 300)) },
        candidates: matches.map(({ source, passage, explanation }, index): ContextCandidateInput => ({
        id: passage.id, kind: "source", projectId: source.projectId, revision: source.revision,
        title: `${source.title}${source.extraction === "metadata_only" ? " (metadata only)" : ""}`.slice(0, 240), text: passage.text,
        score: 1 / (1 + index / 5), citations: [{ sourceVersionId: source.id, passageId: passage.id, locator: passage.locator }],
        retrievalReasons: [explanation.lanes.length ? `Matched through ${explanation.lanes.join(" and ")} retrieval` : "Exact pinned passage",
          ...(explanation.matchedTerms.length ? [`Query terms: ${explanation.matchedTerms.join(", ")}`.slice(0, 300)] : []),
          ...(explanation.cosine === null ? [] : [`Local cosine similarity: ${explanation.cosine.toFixed(3)}`])],
        provenance: { origin: "original_source", referenceId: source.id, revision: source.revision },
      })) };
    },
    authorize(candidate, input) {
      if (!knowledge.enabled) return false;
      try {
        const current = knowledge.readPassage(candidate.id, input.scope.projectId, input.purpose);
        return current.source.revision === candidate.revision && current.source.id === candidate.provenance.referenceId;
      } catch { return false; }
    },
  };
  const memoryCandidate = (entry: MemoryEntry, projectId: string, score: number): ContextCandidateInput => ({
    id: entry.id, kind: "memory", projectId, revision: entry.revision, title: `${entry.scope.kind === "global" ? "Personal" : "Project"} ${entry.kind}`,
    text: entry.text, score: Math.max(0, Math.min(1, score)),
    provenance: { origin: "user_approved_memory", referenceId: entry.id, revision: entry.revision, memoryScope: entry.scope.kind === "global" ? "personal" : "project" },
    citations: entry.provenance.references.flatMap(ref => ref.type === "knowledge" && ref.passageId ? [{ sourceVersionId: ref.sourceVersionId, passageId: ref.passageId }] : []),
  });
  const memories: ContextProvider = {
    async retrieve(input, signal) {
      if (!memory.enabled) return { candidates: [] };
      const result = await memory.recall({ projectId: input.scope.projectId, purpose: input.purpose, query: input.query, limit: 20 }, { nativeAuthenticated: true }, signal);
      signal.throwIfAborted();
      const candidates = result.matches.map(match => ({ ...memoryCandidate(match.entry, input.scope.projectId, match.score / (match.score + 2)),
        retrievalReasons: match.reasons.slice(0, 8).map(reason => reason.slice(0, 300)) }));
      for (const pin of input.pins) {
        if (candidates.some(candidate => candidate.id === pin.id)) continue;
        try {
          const entry = await memory.inspect(pin.id, { nativeAuthenticated: true, projectId: input.scope.projectId });
          if (memory.authorize(entry, { projectId: input.scope.projectId, purpose: input.purpose })) candidates.push({ ...memoryCandidate(entry, input.scope.projectId, 1), retrievalReasons: ["Exact pinned memory revision"] });
        } catch { /* Pins cannot widen scope or resurrect forgotten memories. */ }
      }
      signal.throwIfAborted(); return { candidates, retrieval: { mode: result.retrieval.mode, warnings: result.retrieval.warnings.slice(0, 8).map(value => value.slice(0, 300)) } };
    },
    authorize: (candidate, input) => memory.enabled && memory.authorize(candidate, { projectId: input.scope.projectId, purpose: input.purpose }),
  };
  const history: ContextProvider = {
    async retrieve(input) {
      const { messages } = service.contextSnapshot(input.scope.projectId, input.scope.conversationId ?? undefined, input.scope.taskId ?? undefined);
      const terms = input.query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      const selected = messages.map((message, index) => ({ message, score: 0.2 + (index + 1) / Math.max(1, messages.length) * 0.2 +
        (terms.length ? terms.filter(term => message.text.toLocaleLowerCase().includes(term)).length / terms.length * 0.6 : 0) }))
        .sort((a, b) => Number(input.pins.some(pin => pin.id === b.message.id)) - Number(input.pins.some(pin => pin.id === a.message.id)) || b.score - a.score).slice(0, 24);
      return { retrieval: { mode: "history", warnings: [] }, candidates: selected.map(({ message, score }): ContextCandidateInput => ({
        id: message.id, kind: "history", projectId: input.scope.projectId, conversationId: input.scope.conversationId,
        revision: 1, title: `You · ${message.createdAt}`, text: message.text, score,
        provenance: { origin: "conversation_message", referenceId: message.id, revision: 1 },
      })), availableBeyondLimit: Math.max(0, messages.length - selected.length) };
    },
    authorize(candidate, input) {
      return service.contextSnapshot(input.scope.projectId, input.scope.conversationId ?? undefined, input.scope.taskId ?? undefined)
        .messages.some(message => message.id === candidate.id && message.text.startsWith(candidate.text));
    },
  };
  const checkpoint: ContextProvider = {
    async retrieve(input) {
      if (!continuity?.enabled) return { candidates: [] };
      const value = continuity.checkpoint(input.scope.projectId, input.purpose, input.query);
      return { candidates: value.text ? [{ id: value.id, kind: "checkpoint", projectId: value.projectId, revision: value.revision,
        title: "Project continuity", text: value.text, score: 0.7, provenance: { origin: "project_checkpoint", referenceId: value.id, revision: value.revision },
        retrievalReasons: ["Committed project episodes across conversations; observed task state is not proof of an external effect"],
      }] : [], retrieval: { mode: "history", warnings: [] } };
    },
    authorize: (candidate, input) => continuity?.enabled === true && continuity.authorizeCheckpoint(candidate.id, candidate.revision, input.scope.projectId, input.purpose),
  };
  const assembler = createContextAssembler({ providers: { source: retained ? combineContextProviders(source, retained.source) : source,
    memory: retained ? combineContextProviders(memories, retained.memory) : memories, history, checkpoint },
    authorizeScope(scope) {
      service.contextSnapshot(scope.projectId, scope.conversationId ?? undefined, scope.taskId ?? undefined);
      if (!knowledge.enabled && !memory.enabled && !retained) throw new BridgeError("Enable Knowledge or Personal Memory to use scoped context.", 503);
    },
    async activeActions(scope) {
      return service.contextSnapshot(scope.projectId, scope.conversationId ?? undefined, scope.taskId ?? undefined).actions
        .filter(action => (!scope.conversationId || action.conversationId === scope.conversationId) && (!scope.taskId || action.id === scope.taskId))
        .slice(0, 8).map(action => ({ projectId: scope.projectId, conversationId: action.conversationId,
          taskId: action.id, status: action.status, pendingApprovals: action.pendingApprovals, summary: action.title }));
    },
    authorizeAction(action, scope) {
      return service.contextSnapshot(scope.projectId, scope.conversationId ?? undefined, scope.taskId ?? undefined).actions
        .some(current => current.id === action.taskId && current.conversationId === action.conversationId &&
          current.status === action.status && current.pendingApprovals === action.pendingApprovals);
    },
  });
  return {
    assembler,
    async preview(raw: unknown, signal?: AbortSignal) {
      const input = ContextPreviewSchema.parse(raw);
      if (containsCredentialLikeData(input.query)) throw new BridgeError("Context queries cannot contain credentials.", 400);
      return assembler.assemble({ version: 1, scope: { projectId: input.projectId, conversationId: input.conversationId ?? null, taskId: null },
        query: input.query, purpose: input.purpose, currentTurn: { text: input.query },
        budget: { maxBytes: 32_768, maxTokens: input.maxTokens, maxItems: input.maxItems }, pins: input.pins }, signal);
    },
    async current(scope: { projectId: string; conversationId: string; taskId: string }, query?: string, maxTokens = 12_000, signal?: AbortSignal) {
      const snapshot = service.contextSnapshot(scope.projectId, scope.conversationId, scope.taskId);
      const text = query ?? snapshot.currentTurn.trim().slice(0, 1000);
      if (containsCredentialLikeData(text)) throw new BridgeError("Context queries cannot contain credentials.", 400);
      const packet = await assembler.assemble({ version: 1, scope, purpose: "cloud", query: text || "current conversation", currentTurn: { text: snapshot.currentTurn },
        pins: continuity?.enabled ? continuity.getWorkingSet(scope.projectId).pins : [],
        budget: { maxBytes: 32_768, maxTokens, maxItems: 12 } }, signal);
      await assembler.revalidateAsync(packet, signal);
      if (continuity?.enabled) continuity.recordContextUse(packet);
      return packet;
    },
  };
}
export type ContextRuntime = ReturnType<typeof createContextRuntime>;
