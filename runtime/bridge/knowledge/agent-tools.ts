import { z } from "zod";
import { isValidLocalToken } from "../../agent/lib/local-auth.ts";
import { readBoundedJson } from "../harness-interactions/gateway.ts";
import { KnowledgeId, SourceVersionSchema, EvidencePassageSchema } from "./contracts.ts";

export const KnowledgeSearchToolSchema = z.strictObject({ projectId: KnowledgeId, query: z.string().trim().min(1).max(1_000), limit: z.number().int().min(1).max(20).default(8) });
export const KnowledgeReadToolSchema = z.strictObject({ projectId: KnowledgeId, sourceVersionId: KnowledgeId, passageIds: z.array(KnowledgeId).min(1).max(8) });
export interface KnowledgeToolContext { sessionId: string; delegated: boolean; signal: AbortSignal }

/** Root model gets no native token and can only request cloud-disclosable project evidence. */
export function createKnowledgeAgentPort(context: KnowledgeToolContext, fetcher: typeof fetch = fetch) {
  async function call(route: string, body?: unknown) {
    if (context.delegated) throw new Error("Knowledge tool requests must be routed through the root assistant's scoped broker");
    context.signal.throwIfAborted();
    const token = process.env.JARVIS_LOCAL_TOKEN;
    if (!isValidLocalToken(token)) throw new Error("Authenticated local bridge unavailable");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
    const response = await fetcher(`http://127.0.0.1:39202${route}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "x-jarvis-eve-session": context.sessionId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Knowledge request refused (HTTP ${response.status}); refresh the exact project or source grant, never broaden it automatically`); }
    return readBoundedJson(response, signal, 4 * 1_024 * 1_024);
  }
  return {
    search: (input: z.infer<typeof KnowledgeSearchToolSchema>) => call("/v1/knowledge/context", { ...KnowledgeSearchToolSchema.parse(input), purpose: "cloud", includeArchived: false, maxPerSource: 2, indexBudget: 0 }),
    retrieve: (input: unknown) => call("/v1/knowledge/retrieve", input),
    extract: (input: unknown) => call("/v1/knowledge/extract", input),
    publish: (input: unknown) => call("/v1/knowledge/deliverables", input),
    async read(raw: z.infer<typeof KnowledgeReadToolSchema>) {
      const input = KnowledgeReadToolSchema.parse(raw);
      const response = z.object({ source: SourceVersionSchema, passages: z.array(EvidencePassageSchema) }).parse(await call(`/v1/knowledge/sources/${encodeURIComponent(input.sourceVersionId)}?projectId=${encodeURIComponent(input.projectId)}&purpose=cloud`));
      const requested = new Set(input.passageIds), passages = response.passages.filter(passage => requested.has(passage.id));
      if (passages.length !== requested.size) throw new Error("A requested passage is not part of that exact source version");
      return { source: response.source, passages, contentTrust: "untrusted", notice: "Quotes and locators establish provenance, not proof that a claim is correct. Metadata-only records are not full-text evidence." };
    },
  };
}
