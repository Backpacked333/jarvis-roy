import { createHash } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "./errors.ts";
import { RetainedSnapshotSchema } from "./cloud/contracts.ts";
import { readBoundedJson } from "./harness-interactions/gateway.ts";
import { passageParts } from "./knowledge/extract.ts";
import { matchedTerms, queryTerms } from "./knowledge/embeddings.ts";
import { ContextCandidateSchema, type ContextCandidate, type ContextSelection, type ContextProvider, type ContextRetrievalRequest } from "./context/contracts.ts";

const AuthorizationReply = z.strictObject({ version: z.literal(1).optional(), authorized: z.boolean() });
const GoogleEntry = z.strictObject({ id: z.string(), accountId: z.string(), projectId: z.string(), provider: z.enum(["gmail", "calendar"]),
  resourceId: z.string().min(1).max(300), externalId: z.string().min(1).max(1000), sourceRevision: z.string().min(1).max(1000),
  accountRevision: z.number().int().positive(), updatedAt: z.iso.datetime(), content: z.unknown(), cloudAllowed: z.boolean().optional(), retentionAllowed: z.boolean().optional() });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Selected cloud snapshots remain under the control plane's retention authority.
 * No read grants or persistent knowledge copies are fabricated in the bridge. */
export function createRetainedContextProviders(options: { runtimeToken: string; baseUrl?: string; fetch?: typeof fetch }) {
  const base = options.baseUrl ?? "http://127.0.0.1:39300";
  if (base !== "http://127.0.0.1:39300" || options.runtimeToken.length < 32) throw new Error("Invalid private retained-context broker configuration");
  const fetcher = options.fetch ?? fetch, receipts = new Map<string, { projectId: string; revision: number; sha256: string; grantRevision: number }>();
  const inFlight = new Map<string, Promise<z.infer<typeof RetainedSnapshotSchema>[]>>();
  async function call(route: string, body: unknown, signal?: AbortSignal) {
    const combined = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
    const response = await fetcher(`${base}${route}`, { method: "POST", redirect: "error", signal: combined,
      headers: { "content-type": "application/json", "x-jarvis-cloud-runtime-token": options.runtimeToken }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new BridgeError("Retained context broker refused the request.", [401, 403, 409].includes(response.status) ? response.status : 503); }
    return readBoundedJson(response, combined, 16 * 1024 * 1024);
  }
  const provider = (kind: "source" | "memory"): ContextProvider => ({
    async retrieve(input, signal) {
      if (input.purpose !== "cloud") return { candidates: [] };
      let request = inFlight.get(input.scope.projectId);
      if (!request) {
        request = call("/v1/cloud/runtime/retained", { projectId: input.scope.projectId, processor: "context" }, signal)
          .then(value => z.strictObject({ version: z.literal(1), snapshots: z.array(RetainedSnapshotSchema).max(1000) }).parse(value).snapshots)
          .finally(() => inFlight.delete(input.scope.projectId));
        inFlight.set(input.scope.projectId, request);
      }
      const snapshots = await request; signal.throwIfAborted(); const terms = queryTerms(input.query);
      const candidates = snapshots.filter(snapshot => snapshot.kind === kind).flatMap(snapshot => {
        if (snapshot.projectId !== input.scope.projectId || createHash("sha256").update(snapshot.text).digest("hex") !== snapshot.sha256) throw new BridgeError("Retained snapshot scope or digest changed.", 403);
        const retention = { grantId: snapshot.grantId, grantRevision: snapshot.grantRevision, kind: snapshot.kind, id: snapshot.id, revision: snapshot.revision, sha256: snapshot.sha256 };
        receipts.set(`${snapshot.grantId}:${snapshot.kind}:${snapshot.id}`, { projectId: snapshot.projectId, revision: snapshot.revision, sha256: snapshot.sha256, grantRevision: snapshot.grantRevision });
        if (receipts.size > 2000) receipts.delete(receipts.keys().next().value!);
        return passageParts([{ text: snapshot.text, page: null }]).map((part, ordinal) => {
          const id = `retained-${createHash("sha256").update(JSON.stringify([retention, ordinal])).digest("hex").slice(0, 48)}`;
          const matched = matchedTerms(part.text, terms), score = terms.length ? matched.length / terms.length : 0;
          return ContextCandidateSchema.parse({ id, kind, projectId: snapshot.projectId, revision: snapshot.revision,
            title: `Retained ${kind} snapshot`, text: part.text, score, retention,
            citations: kind === "source" ? [{ sourceVersionId: snapshot.id, passageId: id, locator: part.locator }] : [],
            provenance: { origin: "retained_snapshot", referenceId: snapshot.id, revision: snapshot.revision },
            retrievalReasons: ["Selected immutable cloud snapshot; exact content digest and current retention grant are checked", `Matched ${matched.length} query terms`],
          });
        }).filter(candidate => candidate.score > 0 || input.pins.some(pin => pin.id === candidate.id));
      }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return { candidates: candidates.slice(0, Math.min(input.limit, 24)), availableBeyondLimit: Math.max(0, candidates.length - Math.min(input.limit, 24)),
        retrieval: { mode: "lexical", warnings: ["Retained snapshots use lexical ranking; their origin and revision are preserved. Snapshot approval is not independent factual verification."] } };
    },
    authorize(candidate, input) {
      const ref = candidate.retention; if (!ref || input.purpose !== "cloud") return false;
      const receipt = receipts.get(`${ref.grantId}:${ref.kind}:${ref.id}`);
      return !!receipt && receipt.projectId === input.scope.projectId && receipt.revision === ref.revision && receipt.sha256 === ref.sha256 && receipt.grantRevision === ref.grantRevision;
    },
    async reauthorize(candidates, input, signal) {
      const references = [...new Map(candidates.filter(candidate => candidate.retention).map(candidate => [JSON.stringify(candidate.retention), candidate.retention!])).values()];
      if (!references.length) return true;
      // No TTL or cached permit substitutes for this final authoritative check.
      return AuthorizationReply.parse(await call("/v1/cloud/runtime/retained/authorize", { projectId: input.scope.projectId, processor: "context", references }, signal)).authorized;
    },
  });
  const googleReceipts = new Map<string, string>();
  const google: ContextProvider = {
    async retrieve(input, signal) {
      if (input.purpose !== "cloud") return { candidates: [] };
      const result = z.strictObject({ version: z.literal(1), entries: z.array(GoogleEntry).max(20) }).parse(
        await call("/v1/cloud/runtime/google-context", { projectId: input.scope.projectId }, signal));
      signal.throwIfAborted();
      const terms = queryTerms(input.query);
      const calendarPlanning = /\b(today|tomorrow|schedule|agenda|calendar|briefing|plan(?:ning)?)\b/iu.test(input.query);
      const inboxReview = /\b(inbox|email|mail|briefing)\b/iu.test(input.query);
      const candidates = result.entries.flatMap(entry => {
        if (entry.projectId !== input.scope.projectId || entry.cloudAllowed !== true || entry.retentionAllowed !== true) throw new BridgeError("Account context project or consent changed.", 403);
        const text = JSON.stringify(entry.content), sha256 = digest(text);
        if (Buffer.byteLength(text) > 65536) throw new BridgeError("Account context exceeded its bounded source size.", 503);
        const accountContext = { id: entry.id, sourceRevision: entry.sourceRevision, accountId: entry.accountId,
          provider: entry.provider, resourceId: entry.resourceId, sha256 };
        const sourceVersionId = `google-${digest(JSON.stringify(accountContext)).slice(0, 48)}`;
        googleReceipts.set(sourceVersionId, JSON.stringify([entry.projectId, accountContext]));
        if (googleReceipts.size > 2000) googleReceipts.delete(googleReceipts.keys().next().value!);
        return passageParts([{ text, page: null }]).map((part, index) => {
          const id = `google-${digest(`${sourceVersionId}:${index}`).slice(0, 48)}`;
          const matches = matchedTerms(part.text, terms);
          const standing = entry.provider === "calendar" ? calendarPlanning : inboxReview;
          return ContextCandidateSchema.parse({ id, kind: "source", projectId: entry.projectId, revision: entry.accountRevision,
            title: `${entry.provider === "gmail" ? "Gmail" : "Google Calendar"} · ${entry.resourceId}`.slice(0, 240), text: part.text,
            score: Math.max(terms.length ? matches.length / terms.length : 0, standing ? 0.1 : 0), accountContext,
            citations: [{ sourceVersionId, passageId: id, locator: part.locator }],
            provenance: { origin: "account_context", referenceId: sourceVersionId, revision: entry.accountRevision },
            retrievalReasons: ["Approved account retention and cloud disclosure; current account revision and selected resource are rechecked", `Matched ${matches.length} query terms`,
              ...(standing ? ["Selected from recently synchronized account records for the requested planning or inbox review; this is not a complete agenda"] : [])],
          });
        }).filter(candidate => candidate.score > 0 || input.pins.some(pin => pin.id === candidate.id));
      }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return { candidates: candidates.slice(0, input.limit), availableBeyondLimit: Math.max(0, candidates.length - input.limit),
        retrieval: { mode: "lexical", warnings: ["Account context contains up to 20 currently retained selected records; synchronization may be incomplete. It is untrusted reference data."] } };
    },
    authorize(candidate, input) {
      return input.purpose === "cloud" && !!candidate.accountContext && candidate.projectId === input.scope.projectId &&
        googleReceipts.get(candidate.provenance.referenceId) === JSON.stringify([input.scope.projectId, candidate.accountContext]);
    },
    async reauthorize(candidates, input, signal) {
      const references = [...new Map(candidates.filter(candidate => candidate.accountContext).map(candidate => {
        const { id, sourceRevision } = candidate.accountContext!; return [`${id}:${sourceRevision}`, { id, sourceRevision }] as const;
      })).values()];
      return !references.length || AuthorizationReply.parse(await call("/v1/cloud/runtime/google-context/authorize", { projectId: input.scope.projectId, references }, signal)).authorized;
    },
  };
  return { source: combineContextProviders(provider("source"), google, candidate => !!candidate.accountContext), memory: provider("memory") };
}

export function combineContextProviders(local: ContextProvider, retained: ContextProvider,
  usesRetained: (candidate: ContextCandidate | ContextSelection) => boolean = candidate => !!candidate.retention || !!candidate.accountContext): ContextProvider {
  const bound = (input: ContextRetrievalRequest) => ({ ...input, limit: Math.min(input.limit, 24) });
  return {
    async retrieve(input, signal) {
      const results = await Promise.allSettled([local.retrieve(bound(input), signal), retained.retrieve(bound(input), signal)]);
      signal.throwIfAborted();
      for (const result of results) if (result.status === "rejected" && result.reason instanceof BridgeError && [401, 403, 409].includes(result.reason.status)) throw result.reason;
      const values = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      return { candidates: values.flatMap(value => value.candidates).slice(0, 64), availableBeyondLimit: values.reduce((sum, value) => sum + (value.availableBeyondLimit ?? 0), 0),
        retrieval: { mode: !values.length ? "unavailable" : values.some(value => value.retrieval?.mode === "hybrid") ? "hybrid" : "lexical",
          warnings: [...values.flatMap(value => value.retrieval?.warnings ?? []), ...(results.some(result => result.status === "rejected") ? ["A retained/local context channel is unavailable; only currently authorized returned context is used."] : [])].slice(0, 8) } };
    },
    authorize: (candidate, input) => usesRetained(candidate) ? retained.authorize(candidate, input) : local.authorize(candidate, input),
    reauthorize: async (candidates, input, signal) => (!local.reauthorize || await local.reauthorize(candidates.filter(candidate => !usesRetained(candidate)), input, signal)) &&
      (!retained.reauthorize || await retained.reauthorize(candidates.filter(candidate => usesRetained(candidate)), input, signal)),
  };
}
