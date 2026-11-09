import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ObjectiveSchema, type Objective } from "../objectives/contracts.ts";
import { canonicalJson } from "../harness-contracts/validation.ts";
import { IntegrationId, type IntegrationHooks, type OutboxRecord } from "./contracts.ts";
import type { IntegrationStore } from "./store.ts";

const category = z.enum(["blocking_deadline", "call_when_ready"]);
const timeZone = z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
export const OutreachPolicySchema = z.strictObject({
  version: z.literal(1), projectId: IntegrationId, revision: z.number().int().nonnegative(), enabled: z.boolean(),
  timeZone, timezoneConfirmed: z.boolean(), categories: z.array(category).max(2), updatedAt: z.iso.datetime().nullable(),
  quietStartHour: z.literal(22), quietEndHour: z.literal(8), digestHours: z.tuple([z.literal(9), z.literal(18)]),
  maxRoutinePerDay: z.literal(4), maxCallsPerDay: z.literal(2), maxCallSeconds: z.literal(300),
  deadlineWindowMinutes: z.literal(60), unansweredMinimumMinutes: z.literal(10),
});
export type OutreachPolicy = z.infer<typeof OutreachPolicySchema>;
export interface ReadyCallRequest { version: 1; id: string; projectId: string; objectiveId: string; objectiveRevision: number; definitionDigest: string; createdAt: string; expiresAt: string; status: "pending" | "consumed" }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function objectiveDefinitionDigest(objective: Objective): string { return hash(canonicalJson({ id: objective.id, projectId: objective.projectId, goal: objective.goal, steps: objective.steps })); }
export class OutreachPolicies {
  private readonly store: IntegrationStore; private readonly zone: string; private readonly now: () => Date;
  constructor(store: IntegrationStore, zone: string, now: () => Date) { this.store = store; this.zone = timeZone.parse(zone); this.now = now; }
  read(projectId: string): OutreachPolicy {
    IntegrationId.parse(projectId);
    return OutreachPolicySchema.parse(this.store.get("outreach_policy", projectId) ?? { version: 1, projectId, revision: 0, enabled: false,
      timeZone: this.zone, timezoneConfirmed: false, categories: [], updatedAt: null, quietStartHour: 22, quietEndHour: 8, digestHours: [9, 18],
      maxRoutinePerDay: 4, maxCallsPerDay: 2, maxCallSeconds: 300, deadlineWindowMinutes: 60, unansweredMinimumMinutes: 10 });
  }
  update(raw: unknown): OutreachPolicy {
    const input = z.strictObject({ projectId: IntegrationId, expectedRevision: z.number().int().nonnegative(), enabled: z.boolean(), timeZone,
      timezoneConfirmed: z.boolean(), categories: z.array(category).max(2) }).parse(raw), current = this.read(input.projectId);
    if (current.revision !== input.expectedRevision) throw new Error("Outreach policy changed; inspect its current revision");
    if (input.timeZone !== this.zone || input.enabled && !input.timezoneConfirmed || new Set(input.categories).size !== input.categories.length) throw new Error("Confirm the configured time zone and unique outreach categories before enabling");
    const { expectedRevision: _, ...changes } = input;
    const next = OutreachPolicySchema.parse({ ...current, ...changes, revision: current.revision + 1, updatedAt: this.now().toISOString() });
    this.store.transaction(() => {
      this.store.put("outreach_policy", input.projectId, next);
      for (const request of this.store.list<ReadyCallRequest>("ready_call")) if (request.projectId === input.projectId && request.status === "pending") this.store.put("ready_call", request.id, { ...request, status: "consumed" });
    }); return next;
  }
  allows(projectId: string, kind: z.infer<typeof category>, checkQuiet = true): boolean {
    try {
      this.store.assertWritable(); const policy = this.read(projectId);
      if (!policy.enabled || !policy.timezoneConfirmed || !policy.categories.includes(kind) || policy.timeZone !== this.zone) return false;
      const hour = Number(new Intl.DateTimeFormat("en", { timeZone: policy.timeZone, hour: "2-digit", hourCycle: "h23" }).format(this.now()));
      return !checkQuiet || hour >= 8 && hour < 22;
    } catch { return false; }
  }
  blockingCandidate(raw: unknown, outbox: OutboxRecord[]) {
    const objective = ObjectiveSchema.parse(raw), now = this.now().getTime();
    if (!this.allows(objective.projectId, "blocking_deadline") || objective.cancelRequested || !["waiting", "waiting_for_user"].includes(objective.status) || !objective.question || Date.parse(objective.question.expiresAt) <= now) return null;
    const remaining = Date.parse(objective.deadlineAt) - now;
    if (remaining <= 0 || remaining > 3_600_000) return null;
    const sent = outbox.filter(item => item.projectId === objective.projectId && item.objectiveId === objective.id && item.status === "sent" && item.sentAt &&
      item.question?.kind !== "task" && item.question?.objectiveId === objective.id && item.question.questionId === objective.question!.id && item.question.revision === objective.question!.revision)
      .sort((a, b) => a.sentAt!.localeCompare(b.sentAt!))[0];
    if (!sent?.sentAt || now - Date.parse(sent.sentAt) < 600_000) return null;
    const issueId = `question-${hash(`${objective.projectId}:${objective.id}:${objective.question.id}:${objective.question.revision}`).slice(0, 64)}`;
    return { id: issueId, issueId, projectId: objective.projectId, objectiveId: objective.id, blocked: true as const, deadlineAt: objective.deadlineAt, unansweredSince: sent.sentAt };
  }
  async requestReady(raw: unknown, read: IntegrationHooks["readObjective"]): Promise<ReadyCallRequest> {
    const input = z.strictObject({ projectId: IntegrationId, objectiveId: IntegrationId, expectedRevision: z.number().int().positive(), expiresAt: z.iso.datetime() }).parse(raw);
    const lifetime = Date.parse(input.expiresAt) - this.now().getTime();
    if (!this.allows(input.projectId, "call_when_ready", false) || lifetime <= 0 || lifetime > 86_400_000 || !read) throw new Error("Enabled ready-call policy, bounded expiry and authoritative objective lookup required");
    const policyRevision = this.read(input.projectId).revision;
    const objective = ObjectiveSchema.parse(await read({ projectId: input.projectId, objectiveId: input.objectiveId }));
    if (!this.allows(input.projectId, "call_when_ready", false) || this.read(input.projectId).revision !== policyRevision || objective.id !== input.objectiveId || objective.projectId !== input.projectId || objective.revision !== input.expectedRevision || objective.cancelRequested) throw new Error("Objective or policy changed before ready-call request");
    const request: ReadyCallRequest = { version: 1, id: randomUUID(), projectId: input.projectId, objectiveId: input.objectiveId, objectiveRevision: objective.revision,
      definitionDigest: objectiveDefinitionDigest(objective), createdAt: this.now().toISOString(), expiresAt: input.expiresAt, status: "pending" };
    this.store.transaction(() => {
      for (const previous of this.store.list<ReadyCallRequest>("ready_call")) if (previous.status === "pending" && previous.projectId === request.projectId && previous.objectiveId === request.objectiveId) this.store.put("ready_call", previous.id, { ...previous, status: "consumed" });
      this.store.put("ready_call", request.id, request);
    }); return request;
  }
  consumeReady(raw: unknown): ReadyCallRequest | null {
    const objective = ObjectiveSchema.parse(raw);
    if (!this.allows(objective.projectId, "call_when_ready") || objective.status !== "completed" || objective.cancelRequested) return null;
    const request = this.store.list<ReadyCallRequest>("ready_call").find(request => request.status === "pending" && request.projectId === objective.projectId && request.objectiveId === objective.id &&
      request.objectiveRevision <= objective.revision && Date.parse(request.expiresAt) > this.now().getTime() && request.definitionDigest === objectiveDefinitionDigest(objective));
    if (!request) return null;
    const consumed: ReadyCallRequest = { ...request, status: "consumed" }; this.store.put("ready_call", request.id, consumed); return consumed;
  }
  cancelPending(): void {
    this.store.transaction(() => { for (const request of this.store.list<ReadyCallRequest>("ready_call")) if (request.status === "pending") this.store.put("ready_call", request.id, { ...request, status: "consumed" }); });
  }
}
