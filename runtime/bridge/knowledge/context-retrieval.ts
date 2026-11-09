import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BridgeError } from "../errors.ts";
import {
  ContextSearchInputSchema, EvidencePassageSchema, IndexEmbeddingsInputSchema, SearchInputSchema,
  type EvidencePassage, type RetrievalExplanation, type SourceVersion,
} from "./contracts.ts";
import {
  EMBEDDING_BATCH_BYTES, EMBEDDING_BATCH_TEXTS, EMBEDDING_TEXT_BYTES, EmbeddingIdentitySchema,
  cosine, decodeVector, embeddingKey, encodeVector, matchedTerms, normalizedVector, queryTerms,
  type EmbeddingIdentity, type LocalEmbeddingProvider,
} from "./embeddings.ts";

type Purpose = "local" | "cloud";
type Match = { source: SourceVersion; passage: EvidencePassage; explanation: RetrievalExplanation };
interface RetrievalDependencies {
  db(): DatabaseSync;
  transaction<T>(operation: () => T): T;
  sources(projectId: string, purpose: Purpose, includeArchived: boolean): SourceVersion[];
  guard<T>(sources: SourceVersion[], purpose: Purpose, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  audit(projectId: string, operation: string, purpose: Purpose): void;
  now(): Date;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const CANDIDATE_LIMIT = 256, VECTOR_SCAN_LIMIT = 4096, RRF_OFFSET = 60;
const compareID = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const emptyExplanation = (): RetrievalExplanation => ({ lanes: [], lexicalRank: null, vectorRank: null, bm25: null, cosine: null, rrf: 0, matchedTerms: [], queryCoverage: 0 });

/** Bounded local retrieval over an allowlisted source set. A vector cache is not
 * authorization: grant/project/version/archive checks precede scoring and output. */
export class LocalKnowledgeRetrieval {
  readonly identity: EmbeddingIdentity | null;
  private readonly key: string | null;
  private indexQueue: Promise<void> = Promise.resolve();
  private readonly dependencies: RetrievalDependencies;
  private readonly provider?: LocalEmbeddingProvider;
  constructor(dependencies: RetrievalDependencies, provider?: LocalEmbeddingProvider) {
    this.dependencies = dependencies; this.provider = provider;
    this.identity = provider ? Object.freeze(EmbeddingIdentitySchema.parse(provider.identity)) : null;
    this.key = this.identity ? embeddingKey(this.identity) : null;
  }
  private assertModel(): void {
    if (!this.provider || !this.identity || embeddingKey(this.provider.identity) !== this.key) throw new BridgeError("Local embedding model changed or is unavailable. Restart and rebuild its index.", 503);
  }
  private async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.assertModel(); signal?.throwIfAborted();
    if (!texts.length || texts.length > EMBEDDING_BATCH_TEXTS || texts.some(text => Buffer.byteLength(text) > EMBEDDING_TEXT_BYTES) ||
        texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > EMBEDDING_BATCH_BYTES) throw new BridgeError("Local embedding batch exceeds its bounds.", 413);
    const combined = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    const vectors = await new Promise<readonly (readonly number[])[]>((resolve, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => { combined.throwIfAborted(); return this.provider!.embed(texts, { signal: combined }); }).then(resolve, reject)
        .finally(() => combined.removeEventListener("abort", abort));
    });
    combined.throwIfAborted(); this.assertModel();
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new BridgeError("Local embedding provider returned an incomplete batch.", 502);
    return vectors.map(vector => normalizedVector(vector, this.identity!.dimensions));
  }
  private sourceMap(projectId: string, purpose: Purpose, includeArchived: boolean): Map<string, SourceVersion> {
    return new Map(this.dependencies.sources(projectId, purpose, includeArchived).map(source => [source.id, source]));
  }
  private lexical(input: z.infer<typeof SearchInputSchema>, sources: Map<string, SourceVersion>): Match[] {
    const terms = queryTerms(input.query);
    if (!terms.length || !sources.size) return [];
    const query = terms.map(term => `"${term}"`).join(" OR ");
    const rows = this.dependencies.db().prepare(`SELECT p.record AS passage,bm25(passage_search) AS score FROM passage_search f
      JOIN passages p ON p.id=f.passage_id WHERE passage_search MATCH ? AND p.project_id=?
      AND p.source_id IN (SELECT value FROM json_each(?)) ORDER BY score,p.id LIMIT ?`)
      .all(query, input.projectId, JSON.stringify([...sources.keys()]), CANDIDATE_LIMIT);
    return rows.map((row, index) => {
      const passage = EvidencePassageSchema.parse(JSON.parse(String(row.passage)));
      const matched = matchedTerms(passage.text, terms);
      return { source: sources.get(passage.sourceVersionId)!, passage,
        explanation: { ...emptyExplanation(), lanes: ["lexical" as const], lexicalRank: index + 1,
          bm25: Number(row.score), matchedTerms: matched, queryCoverage: matched.length / terms.length, rrf: 1 / (RRF_OFFSET + index + 1) } };
    });
  }
  search(raw: z.input<typeof SearchInputSchema>) {
    const input = SearchInputSchema.parse(raw), sources = this.sourceMap(input.projectId, input.purpose, input.includeArchived);
    const matches = this.lexical(input, sources).slice(0, input.limit);
    this.dependencies.audit(input.projectId, "search", input.purpose);
    return { matches, contentTrust: "untrusted" as const };
  }
  private coverage(sources: Map<string, SourceVersion>) {
    const row = this.dependencies.db().prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN e.provider_key=? AND e.dimensions=? THEN 1 ELSE 0 END) AS cached
      FROM passages p LEFT JOIN passage_embeddings e ON e.passage_id=p.id WHERE p.source_id IN (SELECT value FROM json_each(?))`)
      .get(this.key ?? "", this.identity?.dimensions ?? 0, JSON.stringify([...sources.keys()]))!;
    const eligiblePassages = Number(row.total), indexedPassages = Number(row.cached ?? 0);
    return { eligiblePassages, indexedPassages, pendingPassages: eligiblePassages - indexedPassages };
  }
  async index(raw: z.input<typeof IndexEmbeddingsInputSchema>, signal?: AbortSignal, purpose: Purpose = "local", includeArchived = false) {
    const input = IndexEmbeddingsInputSchema.parse(raw);
    const operation = this.indexQueue.then(() => this.indexBatch(input, purpose, includeArchived, signal));
    this.indexQueue = operation.then(() => {}, () => {});
    return operation;
  }
  private async indexBatch(input: z.infer<typeof IndexEmbeddingsInputSchema>, purpose: Purpose, includeArchived: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const sources = this.sourceMap(input.projectId, purpose, includeArchived), before = this.coverage(sources);
    if (!this.provider) return { version: 1 as const, provider: null, status: "unavailable" as const, indexed: 0, cached: 0, remaining: before.eligiblePassages };
    this.assertModel();
    const rows = this.dependencies.db().prepare(`SELECT p.record FROM passages p LEFT JOIN passage_embeddings e ON e.passage_id=p.id
      WHERE p.source_id IN (SELECT value FROM json_each(?)) AND (e.passage_id IS NULL OR e.provider_key!=? OR e.dimensions!=?)
      ORDER BY p.source_id,p.id LIMIT ?`).all(JSON.stringify([...sources.keys()]), this.key!, this.identity!.dimensions, input.limit);
    const pending = rows.map(row => EvidencePassageSchema.parse(JSON.parse(String(row.record))));
    let indexed = 0;
    while (pending.length) {
      signal?.throwIfAborted();
      const batch: EvidencePassage[] = []; let bytes = 0;
      while (pending.length && batch.length < EMBEDDING_BATCH_TEXTS && bytes + Buffer.byteLength(pending[0].text) <= EMBEDDING_BATCH_BYTES) {
        const passage = pending.shift()!;
        if (Buffer.byteLength(passage.text) > EMBEDDING_TEXT_BYTES) throw new BridgeError("Passage exceeds local embedding text limit.", 413);
        bytes += Buffer.byteLength(passage.text); batch.push(passage);
      }
      if (!batch.length) throw new BridgeError("Passage exceeds local embedding batch limit.", 413);
      const batchSources = [...new Map(batch.map(passage => [passage.sourceVersionId, sources.get(passage.sourceVersionId)!])).values()];
      await this.dependencies.guard(batchSources, purpose, async combined => {
        const vectors = await this.embed(batch.map(passage => passage.text), combined);
        combined.throwIfAborted();
        const current = this.sourceMap(input.projectId, purpose, includeArchived);
        this.dependencies.transaction(() => {
          const save = this.dependencies.db().prepare(`INSERT INTO passage_embeddings(passage_id,provider_key,dimensions,text_hash,vector,indexed_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(passage_id) DO UPDATE SET provider_key=excluded.provider_key,dimensions=excluded.dimensions,
            text_hash=excluded.text_hash,vector=excluded.vector,indexed_at=excluded.indexed_at`);
          for (const [index, passage] of batch.entries()) {
            // Deletion, new source revision or archival while the helper ran must not publish stale vectors.
            if (!current.has(passage.sourceVersionId) || !this.dependencies.db().prepare("SELECT id FROM passages WHERE id=?").get(passage.id)) continue;
            save.run(passage.id, this.key!, this.identity!.dimensions, digest(passage.text), encodeVector(vectors[index]), this.dependencies.now().toISOString()); indexed++;
          }
        });
      }, signal);
    }
    const after = this.coverage(this.sourceMap(input.projectId, purpose, includeArchived));
    this.dependencies.audit(input.projectId, "local_embedding_index", purpose);
    return { version: 1 as const, provider: this.identity, status: "indexed" as const, indexed, cached: after.indexedPassages, remaining: after.pendingPassages };
  }
  async retrieve(raw: z.input<typeof ContextSearchInputSchema>, signal?: AbortSignal) {
    const input = ContextSearchInputSchema.parse(raw); signal?.throwIfAborted();
    let vectorStatus: "ready" | "unavailable" | "failed" = this.provider ? "ready" : "unavailable";
    const warnings: string[] = [], terms = queryTerms(input.query);
    let queryVector: number[] | null = null;
    if (this.provider) {
      try {
        if (input.indexBudget) await this.index({ projectId: input.projectId, limit: input.indexBudget }, signal, input.purpose, input.includeArchived);
        queryVector = (await this.embed([input.query], signal))[0];
      } catch {
        signal?.throwIfAborted(); vectorStatus = "failed";
        warnings.push("Local semantic retrieval is unavailable for this request; lexical evidence only. Check the local model and rebuild its index if it changed.");
      }
    } else warnings.push("No local embedding provider is configured; lexical evidence only.");
    signal?.throwIfAborted();
    // This happens after every asynchronous operation. Cached vectors never bypass current grants.
    const sources = this.sourceMap(input.projectId, input.purpose, input.includeArchived);
    const lexical = this.lexical(input, sources), candidates = new Map(lexical.map(match => [match.passage.id, match]));
    let scannedVectors = 0, vectorScanLimited = false;
    if (queryVector) {
      const rows = this.dependencies.db().prepare(`SELECT p.record,e.vector,e.text_hash FROM passage_embeddings e JOIN passages p ON p.id=e.passage_id
        WHERE e.provider_key=? AND e.dimensions=? AND p.source_id IN (SELECT value FROM json_each(?))
        ORDER BY p.source_id,p.id LIMIT ?`).all(this.key!, this.identity!.dimensions, JSON.stringify([...sources.keys()]), VECTOR_SCAN_LIMIT + 1);
      vectorScanLimited = rows.length > VECTOR_SCAN_LIMIT;
      const scored: { passage: EvidencePassage; similarity: number }[] = [], invalid: string[] = [];
      for (const row of rows.slice(0, VECTOR_SCAN_LIMIT)) {
        const passage = EvidencePassageSchema.parse(JSON.parse(String(row.record))); scannedVectors++;
        if (row.text_hash !== digest(passage.text)) { warnings.push("A stale cached passage embedding was omitted and requires reindexing."); invalid.push(passage.id); continue; }
        try {
          const similarity = cosine(queryVector, decodeVector(row.vector as Uint8Array, this.identity!.dimensions));
          if (similarity >= 0.15) scored.push({ passage, similarity });
        } catch { warnings.push("An invalid cached passage embedding was omitted and requires reindexing."); invalid.push(passage.id); }
      }
      if (invalid.length) this.dependencies.transaction(() => {
        const remove = this.dependencies.db().prepare("DELETE FROM passage_embeddings WHERE passage_id=? AND provider_key=?");
        for (const id of invalid) remove.run(id, this.key!);
      });
      scored.sort((a, b) => b.similarity - a.similarity || compareID(a.passage.id, b.passage.id));
      scored.slice(0, CANDIDATE_LIMIT).forEach(({ passage, similarity }, index) => {
        const match = candidates.get(passage.id) ?? { source: sources.get(passage.sourceVersionId)!, passage, explanation: emptyExplanation() };
        match.explanation.lanes.push("vector"); match.explanation.vectorRank = index + 1; match.explanation.cosine = similarity;
        match.explanation.rrf += 1 / (RRF_OFFSET + index + 1);
        match.explanation.matchedTerms = matchedTerms(passage.text, terms);
        match.explanation.queryCoverage = terms.length ? match.explanation.matchedTerms.length / terms.length : 0;
        candidates.set(passage.id, match);
      });
    }
    const sorted = [...candidates.values()].sort((a, b) => b.explanation.rrf - a.explanation.rrf || b.explanation.queryCoverage - a.explanation.queryCoverage || compareID(a.passage.id, b.passage.id));
    const matches: Match[] = [], perSource = new Map<string, number>();
    const current = this.sourceMap(input.projectId, input.purpose, input.includeArchived);
    for (const match of sorted) {
      if (!current.has(match.source.id)) continue;
      const count = perSource.get(match.source.sourceId) ?? 0;
      if (count >= input.maxPerSource) continue;
      matches.push(match); perSource.set(match.source.sourceId, count + 1);
      if (matches.length >= input.limit) break;
    }
    const coverage = this.coverage(current);
    // A full authorized source window is conservatively marked partial. Do not
    // expose counts or capacity information about sources outside this grant set.
    const sourceScanLimited = current.size >= 2000;
    if (coverage.pendingPassages) warnings.push("Some eligible passages are not indexed for the current local model.");
    if (vectorScanLimited) warnings.push("Vector scan reached its bounded candidate limit; semantic coverage is partial.");
    if (sourceScanLimited) warnings.push("Source selection is limited to the latest 2000 source families; coverage is partial.");
    this.dependencies.audit(input.projectId, "context_retrieval", input.purpose);
    return { version: 1 as const, matches, contentTrust: "untrusted" as const,
      retrieval: { mode: queryVector ? "hybrid" as const : "lexical" as const, terms, vectorStatus, provider: this.identity,
        coverage: { ...coverage, scannedVectors, vectorScanLimited, sourceScanLimited }, diversity: { maxPerSource: input.maxPerSource }, warnings: [...new Set(warnings)] } };
  }
}
