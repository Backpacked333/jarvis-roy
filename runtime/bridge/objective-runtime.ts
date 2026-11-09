import { z } from "zod";
import { BridgeError } from "./errors.ts";
import { ObjectiveDispatchRejected, ObjectiveId, ObjectiveService, type ChildObservation, type ChildRunRef,
  type ObjectiveAdapter, type ObjectiveOptions } from "./objectives/index.ts";
import type { ResearchRun, ResearchService } from "./research/index.ts";
import type { HarnessService } from "./harness-contracts/service.ts";
import type { Run } from "./harness-contracts/domain.ts";
import { objectiveResearchGoal } from "./objectives/continuation.ts";
import { objectiveDeliverable } from "./objectives/deliverable.ts";

const ResearchParameters = z.strictObject({
  publicQuery: z.string().trim().min(1).max(400).optional(),
  providers: z.array(z.enum(["arxiv", "crossref", "tavily"])).max(3).default([]),
  sourceVersionIds: z.array(ObjectiveId).max(20).default([]), tavilyAllowanceUsd: z.number().positive().max(5).optional(),
  maxTokens: z.number().int().min(1000).max(200_000).default(100_000),
  maxModelCalls: z.number().int().min(2).max(4).default(2),
});
const HarnessParameters = z.strictObject({ roomId: ObjectiveId, planId: ObjectiveId,
  expectedPlanRevision: z.number().int().positive(), planDigest: z.string().regex(/^[a-f0-9]{64}$/) });

function researchObservation(run: ResearchRun): ChildObservation {
  const accounting = run.accounting !== "unknown" && run.reservedTokens === 0 && run.retrievalAccounting !== "operator_allowance_unverified" ? "measured" : "unknown";
  return { ref: { authority: "research", projectId: run.projectId, runId: run.id },
    status: run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : run.status === "interrupted" ? "unknown" : "running",
    accounting, estimatedUsd: accounting === "measured" ? run.estimatedModelUsd : null,
    cancelConfirmed: run.status === "cancelled", detail: run.error };
}
function harnessObservation(run: Run): ChildObservation {
  const accounting = run.usage.accounting === "measured" && run.usage.reservedTokens === 0 && run.usage.estimatedUsd !== null ? "measured" : "unknown";
  return { ref: { authority: "harness", projectId: run.roomId, roomId: run.roomId, runId: run.id, planId: run.planId, planDigest: run.planDigest },
    status: run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" :
      run.status === "waiting_question" || run.status === "paused" ? "waiting" : run.status === "interrupted" ? "unknown" : "running",
    accounting, estimatedUsd: accounting === "measured" ? run.usage.estimatedUsd : null, cancelConfirmed: run.cancelConfirmed, detail: null };
}
export function objectiveAdapters(research?: ResearchService, harness?: HarnessService): ObjectiveOptions["adapters"] {
  const adapters: ObjectiveOptions["adapters"] = {};
  if (research?.enabled) adapters.research = {
    async dispatch(input, signal) {
      let parameters: z.infer<typeof ResearchParameters>;
      try { parameters = ResearchParameters.parse(input.step.parameters); signal.throwIfAborted(); }
      catch { throw new ObjectiveDispatchRejected("Invalid research work specification before admission."); }
      const { maxTokens, maxModelCalls, ...options } = parameters;
      const goal = objectiveResearchGoal(input);
      let run: ResearchRun;
      try { run = await research.start({ ...options, requestId: input.attemptId, projectId: input.projectId, goal,
        budget: { estimatedUsd: input.step.estimatedUsd, maxWallTimeMs: input.step.maxWallTimeMs, maxTokens, maxModelCalls, maxConcurrentWorkers: 2 } }); }
      catch { throw new ObjectiveDispatchRejected("Research refused admission before returning a child."); }
      return researchObservation(run);
    },
    async inspect(ref, signal) { signal.throwIfAborted(); if (ref.authority !== "research") throw new Error("Wrong research authority"); return researchObservation(research.get(ref.runId, ref.projectId)); },
    async cancel(ref, signal) { signal.throwIfAborted(); if (ref.authority !== "research") throw new Error("Wrong research authority"); return researchObservation(await research.cancel(ref.runId, ref.projectId)); },
  };
  if (harness) {
    const read = async (ref: ChildRunRef) => {
      if (ref.authority !== "harness" || ref.projectId !== ref.roomId) throw new Error("Wrong room scope");
      const state = await harness.state(), run = state.runs.find(run => run.id === ref.runId && run.roomId === ref.roomId);
      if (!state.ready || !run || run.planId !== ref.planId || run.planDigest !== ref.planDigest) throw new Error("Exact room run not available"); return run;
    };
    const adapter: ObjectiveAdapter = {
      async dispatch(input, signal) {
        let parameters: z.infer<typeof HarnessParameters>;
        try {
          parameters = HarnessParameters.parse(input.step.parameters); signal.throwIfAborted();
          if (parameters.roomId !== input.projectId) throw new Error("Room differs from project");
          const state = await harness.state(); signal.throwIfAborted();
          const room = state.rooms.find(room => room.id === parameters.roomId), plan = state.plans.find(plan => plan.id === parameters.planId && plan.roomId === parameters.roomId);
          if (!state.ready || !state.worker.available || !room || room.status !== "active" || !plan || plan.status !== "accepted" || plan.digest !== parameters.planDigest || plan.revision !== parameters.expectedPlanRevision || plan.policyRevision !== room.policy.revision) throw new Error("Accepted plan binding changed");
          if (room.policy.runBudget.estimatedUsdLimit === null || room.policy.runBudget.estimatedUsdLimit > input.step.estimatedUsd ||
              room.policy.runBudget.maxWallTimeMs > input.step.maxWallTimeMs || plan.nodes.some(node => node.limits.estimatedUsdLimit === null)) throw new Error("Room lacks an enforceable objective-sized cost/time cap");
        } catch { throw new ObjectiveDispatchRejected("Exact accepted room plan or bounded policy was unavailable before dispatch."); }
        const { roomId, ...binding } = parameters;
        const run = await harness.startRun(roomId, { ...binding, requestId: input.attemptId });
        return harnessObservation(run);
      },
      async inspect(ref, signal) { signal.throwIfAborted(); return harnessObservation(await read(ref)); },
      async cancel(ref, signal) { signal.throwIfAborted(); const run = await read(ref); signal.throwIfAborted();
        return harnessObservation(await harness.cancelRun(run.roomId, run.id, { expectedRevision: run.revision })); },
    };
    adapters.harness = adapter;
  }
  return adapters;
}

export interface ObjectiveRuntimeOptions extends Omit<ObjectiveOptions, "adapters"> { research?: ResearchService; harness?: HarnessService }
export interface ObjectiveRouteContext { nativeAuthenticated: boolean; ownerAuthenticated?: boolean; projectId?: string }
export async function createObjectiveRuntime(options: ObjectiveRuntimeOptions) {
  const service = await ObjectiveService.open({ ...options, adapters: objectiveAdapters(options.research, options.harness) });
  const deliverable = (id: string, projectId: string) => objectiveDeliverable(service, id, projectId, options.research, options.harness);
  const route = async (method: string, url: URL, body: unknown, context: ObjectiveRouteContext): Promise<{ status: number; body: unknown } | null> => {
    if (!url.pathname.startsWith("/v1/objectives")) return null;
    const owner = context.nativeAuthenticated || context.ownerAuthenticated === true;
    const reply = (body: unknown, status = 200) => ({ status, body });
    const project = () => {
      const requested = url.searchParams.get("projectId") ?? (body && typeof body === "object" && "projectId" in body ? String(body.projectId) : undefined);
      if (!owner && (!context.projectId || requested && requested !== context.projectId)) throw new BridgeError("Objective project scope differs from its session.", 403);
      const value = owner ? requested : context.projectId;
      if (!value) throw new BridgeError("Explicit objective project is required.", 400); return ObjectiveId.parse(value);
    };
    if (method !== "GET" && !owner) throw new BridgeError("Objective admission and control require the authenticated owner.", 403);
    if (url.pathname === "/v1/objectives/readiness" && method === "GET") {
      if (!owner) throw new BridgeError("Owner readiness access required.", 403); return reply(service.readiness());
    }
    if (url.pathname === "/v1/objectives/events" && method === "GET") return reply(service.events(Number(url.searchParams.get("after") ?? "0"), owner && !url.searchParams.has("projectId") ? undefined : project()));
    if (url.pathname === "/v1/objectives" && method === "GET") {
      const scope = owner && !url.searchParams.has("projectId") ? undefined : project();
      return reply({ version: 1, sequence: service.readiness().sequence, objectives: service.list(scope), ...(owner ? { readiness: service.readiness() } : {}) });
    }
    if (url.pathname === "/v1/objectives" && method === "POST") { project(); return reply(await service.create(body), 201); }
    const match = /^\/v1\/objectives\/([A-Za-z0-9_-]+)(?:\/(pause|resume|stop|answer|checkpoint|deliverable))?$/.exec(url.pathname);
    if (!match) throw new BridgeError("Objective route not found.", 404);
    const [, id, action] = match, scope = project();
    if (method === "GET" && action === "deliverable") {
      if (!owner) throw new BridgeError("Objective deliverable review requires the authenticated owner.", 403);
      return reply(await deliverable(id, scope));
    }
    if (method === "GET" && !action) return reply(service.get(id, scope));
    if (method === "PATCH" && !action) return reply(await service.revise(id, body, scope));
    if (method === "POST" && action === "pause") return reply(await service.pause(id, body, scope));
    if (method === "POST" && action === "resume") return reply(await service.resume(id, body, scope));
    if (method === "POST" && action === "stop") return reply(await service.stop(id, body, scope));
    if (method === "POST" && action === "answer") return reply(await service.answer(id, body, scope));
    if (method === "POST" && action === "checkpoint") {
      const input = z.strictObject({ expectedRevision: z.number().int().positive(), checkpoint: z.unknown() }).parse(body);
      return reply(await service.checkpoint(id, input.checkpoint, scope, input.expectedRevision));
    }
    throw new BridgeError("Objective route not found.", 404);
  };
  return { service, route, deliverable };
}
export type ObjectiveRuntime = Awaited<ReturnType<typeof createObjectiveRuntime>>;
