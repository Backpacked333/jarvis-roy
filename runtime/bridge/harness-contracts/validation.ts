import { createHash } from "node:crypto";
import { ArtifactManifestSchema, PlanSchema, type ArtifactManifest, type Plan, type RoomPolicy } from "./domain.ts";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Expected inert JSON data");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function planDigest(plan: Plan): string {
  return sha256(canonicalJson({ version: plan.version, id: plan.id, roomId: plan.roomId,
    revision: plan.revision, policyRevision: plan.policyRevision, goal: plan.goal, nodes: plan.nodes }));
}

export function validatePlan(input: unknown, policy: RoomPolicy): Plan {
  const plan = PlanSchema.parse(input);
  if (plan.policyRevision !== policy.revision) throw new Error("Plan uses a stale room policy");
  if (plan.nodes.length > policy.maxNodes) throw new Error("Plan exceeds room node limit");
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  if (nodes.size !== plan.nodes.length) throw new Error("Duplicate node IDs");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Dependency cycle");
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error("Unknown dependency");
    visiting.add(id);
    for (const dependency of node.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of plan.nodes) {
    if (node.dependencies.length > policy.maxDependenciesPerNode) throw new Error("Dependency fan-in exceeds policy");
    if (new Set(node.dependencies).size !== node.dependencies.length || new Set(node.inputFrom).size !== node.inputFrom.length) {
      throw new Error("Duplicate dependency or artifact input");
    }
    if (new Set(node.outputPaths).size !== node.outputPaths.length) throw new Error("Duplicate output path");
    visit(node.id);
    for (const key of ["maxSteps", "maxModelCalls", "maxTokens", "maxOutputTokensPerCall", "maxWallTimeMs"] as const) {
      if (node.limits[key] > policy.runBudget[key]) throw new Error(`Node exceeds ${key}`);
    }
  }
  const ancestors = (id: string): Set<string> => {
    const result = new Set<string>();
    const walk = (current: string): void => {
      for (const dependency of nodes.get(current)!.dependencies) {
        if (!result.has(dependency)) { result.add(dependency); walk(dependency); }
      }
    };
    walk(id);
    return result;
  };
  for (const node of plan.nodes) {
    const allowed = ancestors(node.id);
    if (node.inputFrom.some((id) => !allowed.has(id))) throw new Error("Artifact input is not an upstream dependency");
  }
  for (const key of ["maxSteps", "maxModelCalls", "maxTokens"] as const) {
    if (plan.nodes.reduce((total, node) => total + node.limits[key], 0) > policy.runBudget[key]) {
      throw new Error(`Plan reservations exceed ${key}`);
    }
  }
  if (plan.status === "draft" && (plan.digest !== null || plan.acceptedAt !== null)) throw new Error("Draft must not impersonate acceptance");
  if (plan.status === "accepted" && (plan.digest !== planDigest(plan) || plan.acceptedAt === null)) throw new Error("Accepted plan digest mismatch");
  return plan;
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function acceptPlan(input: unknown, policy: RoomPolicy, now = new Date()): Plan {
  const plan = validatePlan(input, policy);
  if (plan.status !== "draft") throw new Error("Plan is already accepted");
  return freeze({ ...plan, status: "accepted", digest: planDigest(plan), acceptedAt: now.toISOString() });
}

export function artifactDigest(manifest: ArtifactManifest): string {
  const { digest: _digest, ...content } = manifest;
  return sha256(canonicalJson(content));
}

export function validateArtifact(input: unknown, policy: RoomPolicy): ArtifactManifest {
  const artifact = ArtifactManifestSchema.parse(input);
  if (artifact.files.length > policy.sandbox.maxArtifactFiles) throw new Error("Artifact file count exceeds policy");
  if (new Set(artifact.files.map((file) => file.path)).size !== artifact.files.length) throw new Error("Duplicate artifact paths");
  if (artifact.files.reduce((bytes, file) => bytes + file.bytes, 0) > policy.sandbox.maxArtifactBytes) throw new Error("Artifact bytes exceed policy");
  if (artifact.digest !== artifactDigest(artifact)) throw new Error("Artifact manifest digest mismatch");
  return freeze(artifact);
}
