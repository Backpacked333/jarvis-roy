import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { containsCredentialLikeData, deleteMemory, listMemories } from "../../agent/lib/memory.ts";
import { readPrivateJson, writeJsonAtomically } from "../../agent/lib/persistence.ts";
import { BridgeError } from "../errors.ts";
import { canonicalJson } from "../harness-contracts/validation.ts";
import { EmbeddingIdentitySchema, cosine, decodeVector, embeddingKey, encodeVector, matchedTerms, normalizedVector, queryTerms,
  type EmbeddingIdentity, type LocalEmbeddingProvider } from "../knowledge/embeddings.ts";
import { MemoryStore } from "./store.ts";
import {
  MemoryApprovalSchema, MemoryEntrySchema, MemoryIdSchema, MemoryInputSchema, MemoryRecallSchema,
  MemoryRevisionSchema, MemorySupersedeSchema, MemoryUpdateSchema, MemoryEntityInputSchema, MemoryEntitySchema,
  type MemoryContext, type MemoryEntry, type MemoryInput, type MemoryMatch, type MemoryReference,
} from "./contracts.ts";

export * from "./contracts.ts";
export { MemoryStore } from "./store.ts";
export interface MemoryOptions {
  dataDirectory: string; enabled?: boolean; now?: () => Date;
  /** Read the exact source version and current grant; reject archived sources. */
  resolveSource?: (reference: Extract<MemoryReference, { type: "knowledge" }>, context: { projectId: string; purpose: "local" | "cloud" }) => boolean;
  onLegacyChanged?: (legacyId: string) => Promise<void> | void;
  embeddingProvider?: LocalEmbeddingProvider;
  backgroundIndexing?: boolean;
}
export interface MemoryReply { status: number; body: unknown }
type Access = { projectId: string | null; purpose: "local" | "cloud"; asOf?: string };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const memoryDigest = (entry: Omit<MemoryEntry, "digest"> | MemoryEntry): string => {
  const { digest: _digest, ...content } = entry as MemoryEntry;
  return sha256(canonicalJson(content));
};
const seal = (entry: Omit<MemoryEntry, "digest"> | MemoryEntry): MemoryEntry => {
  const parsed = MemoryEntrySchema.parse({ ...entry, digest: "0".repeat(64) });
  return { ...parsed, digest: memoryDigest(parsed) };
};
const LegacyBackupSchema = z.strictObject({ version: z.literal(1), records: z.array(z.strictObject({ id: MemoryIdSchema, text: z.string().max(4000) })).max(5000) });

export class MemoryService {
  readonly enabled: boolean;
  private readonly store = new MemoryStore();
  private readonly options: MemoryOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly activeReads = new Set<AbortController>();
  private readonly completedLegacyCleanup = new Set<string>();
  private readonly embeddingIdentity: EmbeddingIdentity | null;
  private readonly embeddingModelKey: string | null;
  private backgroundTimer?: NodeJS.Timeout;
  private backgroundBusy = false;
  private backgroundPaused = false;
  private constructor(options: MemoryOptions) {
    this.options = options; this.enabled = options.enabled ?? process.env.JARVIS_ENABLE_MEMORY === "1";
    this.embeddingIdentity = options.embeddingProvider ? Object.freeze(EmbeddingIdentitySchema.parse(options.embeddingProvider.identity)) : null;
    this.embeddingModelKey = this.embeddingIdentity ? embeddingKey(this.embeddingIdentity) : null;
  }
  static async open(options: MemoryOptions): Promise<MemoryService> {
    const service = new MemoryService(options);
    if (service.enabled) {
      try { await service.store.open(options.dataDirectory); await service.reconcile(); service.scheduleMemoryIndex(); }
      catch (error) { service.store.close(); throw error; }
    }
    return service;
  }
  private time(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private scheduleMemoryIndex(resume = false): void {
    if (resume) this.backgroundPaused = false;
    if (!this.options.backgroundIndexing || !this.options.embeddingProvider || this.backgroundPaused || this.closed || this.backgroundBusy || this.backgroundTimer) return;
    this.backgroundTimer = setTimeout(() => { this.backgroundTimer = undefined; void this.indexMemoryBatch(); }, 100);
    this.backgroundTimer.unref();
  }
  private async indexMemoryBatch(): Promise<void> {
    if (this.closed || this.backgroundPaused) return;
    this.backgroundBusy = true; const controller = new AbortController(); this.activeReads.add(controller);
    let more = false;
    try {
      await this.serialized(async () => {
        const pending = this.store.all().filter(entry => this.authorize(entry, { projectId: entry.scope.kind === "project" ? entry.scope.projectId : null, purpose: "local" }) &&
          !this.store.db().prepare("SELECT 1 FROM memory_vectors WHERE entry_id=? AND digest=? AND provider_key=?").get(entry.id, entry.digest, this.embeddingModelKey!));
        more = pending.length > 16; const batch = pending.slice(0, 16);
        while (batch.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0) > 65536) { batch.pop(); more = true; }
        if (!batch.length) return;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
        const values = await this.options.embeddingProvider!.embed(batch.map(entry => entry.text), { signal, purpose: "document" });
        signal.throwIfAborted();
        if (embeddingKey(this.options.embeddingProvider!.identity) !== this.embeddingModelKey || values.length !== batch.length) throw new Error("Local memory embedding model changed");
        this.store.transaction(() => batch.forEach((entry, index) => {
          if (!this.authorize(entry, { projectId: entry.scope.kind === "project" ? entry.scope.projectId : null, purpose: "local" })) return;
          this.store.db().prepare("INSERT INTO memory_vectors VALUES (?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET digest=excluded.digest,provider_key=excluded.provider_key,dimensions=excluded.dimensions,vector=excluded.vector")
            .run(entry.id, entry.digest, this.embeddingModelKey!, this.embeddingIdentity!.dimensions, encodeVector(normalizedVector(values[index], this.embeddingIdentity!.dimensions)));
        }));
      });
    } catch { this.backgroundPaused = true; }
    finally { this.activeReads.delete(controller); this.backgroundBusy = false; if (more) this.scheduleMemoryIndex(); }
  }
  private saveEntry(entry: MemoryEntry): void { this.store.save(entry); this.scheduleMemoryIndex(true); }
  private requireEnabled(): void {
    if (!this.enabled) throw new BridgeError("Structured memory is disabled. Enable it explicitly in Settings.", 503);
    if (this.closed) throw new BridgeError("Memory service is closed.", 503);
  }
  private requireNative(context: MemoryContext): void {
    this.requireEnabled(); if (!context.nativeAuthenticated) throw new BridgeError("An authenticated native memory action is required.", 403);
  }
  private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    this.requireEnabled(); const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }
  private scopeAllowed(entry: Pick<MemoryInput, "scope">, projectId: string | null): boolean {
    return entry.scope.kind === "global" || entry.scope.projectId === projectId;
  }
  private checkContext(entry: Pick<MemoryInput, "scope">, context: MemoryContext): void {
    if (context.nativeAuthenticated && context.projectId === undefined) return;
    if (context.projectId === undefined || !this.scopeAllowed(entry, context.projectId)) throw new BridgeError("Memory belongs to another project.", 403);
  }
  private validateInput(raw: unknown): MemoryInput {
    const input = MemoryInputSchema.parse(raw);
    if (containsCredentialLikeData(JSON.stringify(input))) throw new BridgeError("Credentials cannot be stored in memory.", 400);
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(this.time())) throw new BridgeError("Memory expiry must be in the future.", 400);
    if (input.assertion) {
      const row = this.store.db().prepare("SELECT body FROM entities WHERE id=?").get(input.assertion.entityId);
      if (!row || canonicalJson(MemoryEntitySchema.parse(JSON.parse(String(row.body))).scope) !== canonicalJson(input.scope)) throw new BridgeError("Assertion entity must exist in this exact memory scope.", 400);
    }
    return input;
  }
  private entry(id: string, context: MemoryContext): MemoryEntry {
    MemoryIdSchema.parse(id); const entry = this.store.get(id);
    if (!entry) throw new BridgeError("Memory entry not found.", 404);
    this.checkContext(entry, context); return entry;
  }
  private revision(entry: MemoryEntry, expected: number): void {
    if (entry.revision !== expected) throw new BridgeError("Memory changed. Refresh and review the current revision.", 409);
  }
  private revised(entry: MemoryEntry, patch: Partial<MemoryEntry>): MemoryEntry {
    return seal({ ...entry, ...patch, revision: entry.revision + 1, updatedAt: this.time() });
  }
  private backupPath(): string { return join(this.options.dataDirectory, "memory", "legacy-migration-v1.backup.json"); }
  private async readBackup(): Promise<z.infer<typeof LegacyBackupSchema> | undefined> {
    try {
      const info = await lstat(this.backupPath());
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 24 * 1024 * 1024) throw new Error("Unsafe memory migration backup");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    return LegacyBackupSchema.parse(await readPrivateJson(this.backupPath()));
  }
  private async cleanupLegacy(id: string): Promise<void> {
    await deleteMemory(id, this.options.dataDirectory);
    const backup = await this.readBackup();
    if (backup?.records.some(entry => entry.id === id)) await writeJsonAtomically(this.backupPath(), { ...backup, records: backup.records.filter(entry => entry.id !== id) });
    await this.options.onLegacyChanged?.(id);
    this.completedLegacyCleanup.add(id);
  }
  private detach(id: string): string[] {
    const rows = this.store.db().prepare("SELECT id FROM legacy WHERE entry_id=?").all(id);
    for (const row of rows) {
      this.store.db().prepare("INSERT OR IGNORE INTO tombstones VALUES (?)").run(String(row.id));
      this.store.db().prepare("UPDATE legacy SET detached=1 WHERE id=?").run(String(row.id));
    }
    return rows.map(row => String(row.id));
  }
  private async reconcile(): Promise<void> {
    this.requireEnabled(); const db = this.store.db();
    const legacyRecords = await listMemories(this.options.dataDirectory);
    const presentLegacyIds = new Set(legacyRecords.map(entry => entry.id));
    // Content-free deletion markers are durable before touching external files.
    // Completed work can be skipped in this process, but any restored original
    // file triggers cleanup again. A restart retries every durable tombstone.
    for (const row of db.prepare("SELECT legacy_id FROM tombstones").all()) {
      const id = String(row.legacy_id);
      if (!this.completedLegacyCleanup.has(id) || presentLegacyIds.has(id)) await this.cleanupLegacy(id);
    }
    const records = legacyRecords.filter(entry => entry.text.trim().length > 0 && entry.text.length <= 4000 && !containsCredentialLikeData(entry.text));
    if (records.length > 5000) throw new BridgeError("Legacy memory import limit exceeded.", 413);
    if (!db.prepare("SELECT name FROM migrations WHERE name='legacy-v1'").get()) {
      // Backup precedes the durable migration marker. It is never auto-restored,
      // and forgetting/adopting a legacy entry removes its backup copy too.
      if (!await this.readBackup()) {
        const backup = { version: 1, records };
        if (Buffer.byteLength(JSON.stringify(backup), "utf8") + 1 > 24 * 1024 * 1024) throw new BridgeError("Legacy memory migration backup exceeds its byte limit.", 413);
        await writeJsonAtomically(this.backupPath(), backup);
      }
    }
    const present = new Set(records.map(entry => entry.id));
    const cleanup: string[] = [];
    this.store.transaction(() => {
      for (const legacy of records) {
        if (db.prepare("SELECT legacy_id FROM tombstones WHERE legacy_id=?").get(legacy.id)) continue;
        const mapping = db.prepare("SELECT entry_id,fingerprint,detached FROM legacy WHERE id=?").get(legacy.id);
        if (mapping?.detached) continue;
        const fingerprint = sha256(legacy.text), current = mapping ? this.store.get(String(mapping.entry_id)) : undefined;
        if (mapping?.fingerprint === fingerprint && current) continue;
        const input: MemoryInput = { kind: "preference", scope: { kind: "global" }, text: legacy.text,
          provenance: { origin: "explicit_user", references: [{ type: "legacy", memoryId: legacy.id }] }, confidence: 1, pinned: false, expiresAt: null, cloudAllowed: true };
        // Original files were written through an approval-required tool. Later
        // changes to an existing file are new text and need a fresh native review.
        const entry = current ? this.revised(current, { text: legacy.text, status: "proposed" }) : seal({ ...input,
          version: 1, id: legacy.id, revision: 1, status: "active", createdAt: this.time(), updatedAt: this.time(), supersededBy: null });
        this.saveEntry(entry);
        db.prepare("INSERT INTO legacy VALUES (?,?,?,0) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint").run(legacy.id, entry.id, fingerprint);
      }
      for (const row of db.prepare("SELECT id,entry_id FROM legacy WHERE detached=0").all()) {
        if (present.has(String(row.id))) continue;
        this.store.remove(String(row.entry_id));
        db.prepare("INSERT OR IGNORE INTO tombstones VALUES (?)").run(String(row.id));
        db.prepare("UPDATE legacy SET detached=1 WHERE id=?").run(String(row.id)); cleanup.push(String(row.id));
      }
      db.prepare("INSERT OR IGNORE INTO migrations VALUES ('legacy-v1',?)").run(this.time());
    });
    for (const id of cleanup) await this.cleanupLegacy(id);
  }
  async reconcileLegacy(): Promise<void> { return this.serialized(() => this.reconcile()); }
  async create(raw: unknown, context: MemoryContext): Promise<MemoryEntry> {
    this.requireNative(context); return this.insert(raw, context, "active");
  }
  async propose(raw: unknown, context: MemoryContext): Promise<MemoryEntry> {
    this.requireEnabled(); const parsed = this.validateInput(raw);
    return this.insert({ ...parsed, provenance: { ...parsed.provenance, origin: "inferred" } }, context, "proposed");
  }
  private async insert(raw: unknown, context: MemoryContext, status: "active" | "proposed"): Promise<MemoryEntry> {
    const input = this.validateInput(raw); this.checkContext(input, context);
    return this.serialized(async () => {
      await this.reconcile();
      const entry = seal({ ...input, version: 1, id: randomUUID(), revision: 1, status, createdAt: this.time(), updatedAt: this.time(), supersededBy: null });
      this.store.transaction(() => this.saveEntry(entry)); return entry;
    });
  }
  async approve(id: string, raw: unknown, context: MemoryContext): Promise<MemoryEntry> {
    this.requireNative(context); const input = MemoryApprovalSchema.parse(raw);
    return this.serialized(async () => {
      await this.reconcile(); const current = this.entry(id, context); this.revision(current, input.expectedRevision);
      if (current.status !== "proposed" || current.digest !== input.digest || memoryDigest(current) !== input.digest) throw new BridgeError("Memory approval does not match the current pending revision and digest.", 409);
      const { version: _version, id: _id, revision: _revision, digest: _digest, status: _status,
        createdAt: _createdAt, updatedAt: _updatedAt, supersededBy: _supersededBy, ...approvedInput } = current;
      this.validateInput(approvedInput);
      const entry = this.revised(current, { status: "active" }); let legacy: string[] = [];
      this.store.transaction(() => { this.saveEntry(entry); legacy = this.detach(id); });
      for (const legacyId of legacy) await this.cleanupLegacy(legacyId); return entry;
    });
  }
  async update(id: string, raw: unknown, context: MemoryContext): Promise<MemoryEntry> {
    this.requireNative(context); const request = MemoryUpdateSchema.parse(raw), input = this.validateInput(request.input); this.checkContext(input, context);
    this.cancelReads();
    return this.serialized(async () => {
      await this.reconcile(); const current = this.entry(id, context); this.revision(current, request.expectedRevision);
      const entry = this.revised(current, { ...input, status: "proposed", supersededBy: null }); let legacy: string[] = [];
      this.store.transaction(() => { this.saveEntry(entry); legacy = this.detach(id); });
      for (const legacyId of legacy) await this.cleanupLegacy(legacyId); return entry;
    });
  }
  async archive(id: string, raw: unknown, context: MemoryContext): Promise<MemoryEntry> {
    this.requireNative(context); const input = MemoryRevisionSchema.parse(raw);
    this.cancelReads();
    return this.serialized(async () => {
      await this.reconcile(); const current = this.entry(id, context); this.revision(current, input.expectedRevision);
      const entry = this.revised(current, { status: "archived" }); let legacy: string[] = [];
      this.store.transaction(() => { this.saveEntry(entry); legacy = this.detach(id); });
      for (const legacyId of legacy) await this.cleanupLegacy(legacyId); return entry;
    });
  }
  async supersede(id: string, raw: unknown, context: MemoryContext): Promise<MemoryEntry> {
    this.requireNative(context); const input = MemorySupersedeSchema.parse(raw);
    this.cancelReads();
    return this.serialized(async () => {
      await this.reconcile(); const current = this.entry(id, context), replacement = this.entry(input.replacementId, context);
      this.revision(current, input.expectedRevision); this.revision(replacement, input.replacementRevision);
      if (id === replacement.id || replacement.status !== "active" || canonicalJson(current.scope) !== canonicalJson(replacement.scope)) throw new BridgeError("Choose an active replacement in the same memory scope.", 409);
      const entry = this.revised(current, { status: "superseded", supersededBy: replacement.id,
        ...(current.assertion ? { assertion: { ...current.assertion, validTo: replacement.assertion?.validFrom ?? this.time() } } : {}) }); let legacy: string[] = [];
      this.store.transaction(() => { this.saveEntry(entry); legacy = this.detach(id); });
      for (const legacyId of legacy) await this.cleanupLegacy(legacyId); return entry;
    });
  }
  private async forgetEntry(id: string, expectedRevision: number, context: MemoryContext): Promise<{ forgotten: true; id: string }> {
    const current = this.entry(id, context); this.revision(current, expectedRevision); let legacy: string[] = [];
    this.store.transaction(() => { legacy = this.detach(id); this.store.remove(id); });
    for (const legacyId of legacy) await this.cleanupLegacy(legacyId); return { forgotten: true, id };
  }
  async forget(id: string, raw: unknown, context: MemoryContext): Promise<{ forgotten: true; id: string }> {
    this.requireNative(context); const input = MemoryRevisionSchema.parse(raw);
    this.cancelReads();
    return this.serialized(async () => { await this.reconcile(); return this.forgetEntry(id, input.expectedRevision, context); });
  }
  async forgetLegacy(id: string, context: MemoryContext): Promise<{ forgotten: true; id: string }> {
    this.requireNative(context); MemoryIdSchema.parse(id);
    this.cancelReads();
    return this.serialized(async () => {
      await this.reconcile(); const mapping = this.store.db().prepare("SELECT entry_id FROM legacy WHERE id=?").get(id);
      const entry = mapping ? this.store.get(String(mapping.entry_id)) : undefined;
      if (entry) return this.forgetEntry(entry.id, entry.revision, context);
      this.store.transaction(() => this.store.db().prepare("INSERT OR IGNORE INTO tombstones VALUES (?)").run(id));
      await this.cleanupLegacy(id); return { forgotten: true, id };
    });
  }
  async inspect(id: string, context: MemoryContext): Promise<MemoryEntry> {
    this.requireNative(context); return this.serialized(async () => { await this.reconcile(); return this.entry(id, context); });
  }
  async list(projectId: string | null, context: MemoryContext): Promise<{ entries: MemoryEntry[] }> {
    this.requireNative(context); if (projectId !== null) MemoryIdSchema.parse(projectId);
    if (context.projectId !== undefined && context.projectId !== projectId) throw new BridgeError("Memory inspection project mismatch.", 403);
    return this.serialized(async () => { await this.reconcile(); return { entries: this.store.all().filter(entry => this.scopeAllowed(entry, projectId)) }; });
  }
  async export(projectId: string | null, context: MemoryContext): Promise<{ version: 1; exportedAt: string; entries: MemoryEntry[] }> {
    return { version: 1, exportedAt: this.time(), ...await this.list(projectId, context) };
  }
  authorize(ref: Pick<MemoryEntry, "id" | "revision">, access: Access): boolean {
    try {
      this.requireEnabled(); const entry = this.store.get(MemoryIdSchema.parse(ref.id));
      if (!entry || entry.revision !== ref.revision || !(entry.status === "active" || access.asOf && entry.status === "superseded" && entry.assertion) || !this.scopeAllowed(entry, access.projectId) ||
          (access.purpose === "cloud" && !entry.cloudAllowed) || (entry.expiresAt !== null && Date.parse(entry.expiresAt) <= Date.parse(this.time())) || memoryDigest(entry) !== entry.digest) return false;
      const at = Date.parse(access.asOf ?? this.time());
      if (entry.assertion && (entry.assertion.validFrom !== null && at < Date.parse(entry.assertion.validFrom) || entry.assertion.validTo !== null && at >= Date.parse(entry.assertion.validTo))) return false;
      // Legacy files remain authoritative until adopted. A synchronous final
      // disclosure check must detect external edits/deletes without waiting for
      // the next asynchronous reconciliation pass.
      for (const mapping of this.store.db().prepare("SELECT id,fingerprint FROM legacy WHERE entry_id=? AND detached=0").all(entry.id)) {
        const handle = openSync(join(this.options.dataDirectory, "memories", `${String(mapping.id)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = fstatSync(handle);
          if (!info.isFile() || info.nlink !== 1 || info.size > 32000) return false;
          const original = JSON.parse(readFileSync(handle, "utf8")) as { id?: unknown; text?: unknown };
          if (original.id !== mapping.id || typeof original.text !== "string" || sha256(original.text) !== mapping.fingerprint) return false;
        } finally { closeSync(handle); }
      }
      for (const reference of entry.provenance.references) if (reference.type === "knowledge") {
        if (entry.scope.kind !== "project" || access.projectId !== reference.projectId || this.options.resolveSource?.(reference, { projectId: reference.projectId, purpose: access.purpose }) !== true) return false;
      }
      return true;
    } catch { return false; }
  }
  private async semantic(query: string, entries: MemoryEntry[], access: Access, signal: AbortSignal) {
    const similarities = new Map<string, number>();
    const retrieval: { mode: "lexical" | "hybrid"; vectorStatus: "unavailable" | "ready" | "partial" | "failed"; provider: EmbeddingIdentity | null; indexedEntries: number; eligibleEntries: number; scannedEntries: number; warnings: string[] } = {
      mode: "lexical", vectorStatus: "unavailable", provider: this.embeddingIdentity, indexedEntries: 0, eligibleEntries: entries.length, scannedEntries: 0, warnings: [],
    };
    if (!this.options.embeddingProvider || !this.embeddingIdentity || !this.embeddingModelKey) {
      retrieval.warnings.push("No local embedding model is configured; memory recall uses lexical relevance and standing pinned preferences."); return { similarities, retrieval };
    }
    if (!entries.length || !queryTerms(query).length) {
      retrieval.warnings.push("No eligible entries or meaningful query terms for semantic recall."); return { similarities, retrieval };
    }
    const localSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    const embed = async (texts: string[], purpose: "query" | "document" = "document"): Promise<number[][]> => {
      if (embeddingKey(this.options.embeddingProvider!.identity) !== this.embeddingModelKey) throw new Error("Embedding model changed");
      const values = await new Promise<readonly (readonly number[])[]>((resolve, reject) => {
        const abort = () => reject(localSignal.reason);
        localSignal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => { localSignal.throwIfAborted(); return this.options.embeddingProvider!.embed(texts, { signal: localSignal, purpose }); })
          .then(resolve, reject).finally(() => localSignal.removeEventListener("abort", abort));
      });
      localSignal.throwIfAborted();
      if (embeddingKey(this.options.embeddingProvider!.identity) !== this.embeddingModelKey || !Array.isArray(values) || values.length !== texts.length) throw new Error("Invalid embedding model or batch");
      return values.map(vector => normalizedVector(vector, this.embeddingIdentity!.dimensions));
    };
    try {
      // Bounded work per request; the next request can continue warming the cache.
      const candidates = entries.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 512);
      const vectors = new Map<string, number[]>(), pending: MemoryEntry[] = [];
      for (const entry of candidates) {
        const row = this.store.db().prepare("SELECT vector FROM memory_vectors WHERE entry_id=? AND digest=? AND provider_key=? AND dimensions=?")
          .get(entry.id, entry.digest, this.embeddingModelKey, this.embeddingIdentity.dimensions);
        try { if (row) { vectors.set(entry.id, decodeVector(row.vector as Uint8Array, this.embeddingIdentity.dimensions)); continue; } } catch {}
        pending.push(entry);
      }
      let budget = this.options.backgroundIndexing ? 0 : 32;
      while (pending.length && budget > 0) {
        const batch: MemoryEntry[] = []; let bytes = 0;
        while (pending.length && batch.length < 16 && budget > 0) {
          const next = pending[0], size = Buffer.byteLength(next.text, "utf8");
          if (bytes + size > 64 * 1024) break;
          pending.shift(); budget--; if (!this.authorize(next, access)) continue;
          bytes += size; batch.push(next);
        }
        if (!batch.length) break;
        const generated = await embed(batch.map(entry => entry.text));
        signal.throwIfAborted();
        this.store.transaction(() => {
          for (const [index, entry] of batch.entries()) {
            if (!this.authorize(entry, access)) continue;
            this.store.db().prepare("INSERT INTO memory_vectors VALUES (?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET digest=excluded.digest,provider_key=excluded.provider_key,dimensions=excluded.dimensions,vector=excluded.vector")
              .run(entry.id, entry.digest, this.embeddingModelKey!, this.embeddingIdentity!.dimensions, encodeVector(generated[index]));
            vectors.set(entry.id, generated[index]);
          }
        });
      }
      const queryVector = (await embed([query], "query"))[0]; signal.throwIfAborted();
      for (const entry of candidates) {
        const vector = vectors.get(entry.id); if (!vector || !this.authorize(entry, access)) continue;
        retrieval.scannedEntries++;
        const similarity = cosine(queryVector, vector);
        if (similarity >= 0.35) similarities.set(entry.id, similarity);
      }
      retrieval.indexedEntries = vectors.size; retrieval.vectorStatus = vectors.size < entries.length ? "partial" : "ready"; retrieval.mode = "hybrid";
      if (retrieval.vectorStatus === "partial") retrieval.warnings.push(this.options.backgroundIndexing ? "Local semantic recall is partial while the background index catches up; at most 512 cached entries are scanned." : "Local semantic recall is partial: at most 32 new entries are indexed and 512 vectors scanned per request.");
    } catch {
      signal.throwIfAborted(); retrieval.vectorStatus = "failed";
      retrieval.warnings.push("Local semantic retrieval is busy, invalid, or unavailable; this request uses lexical relevance and standing pinned preferences.");
    }
    return { similarities, retrieval };
  }
  async recall(raw: unknown, context: MemoryContext, signal?: AbortSignal) {
    this.requireEnabled(); const input = MemoryRecallSchema.parse(raw);
    if (!context.nativeAuthenticated && (context.projectId === undefined || context.projectId !== input.projectId || input.purpose !== "cloud")) throw new BridgeError("Model memory recall requires its exact project and cloud purpose.", 403);
    if (context.nativeAuthenticated && context.projectId !== undefined && context.projectId !== input.projectId) throw new BridgeError("Memory recall project mismatch.", 403);
    if (containsCredentialLikeData(input.query)) throw new BridgeError("Memory queries cannot contain credentials.", 400);
    const controller = new AbortController(); this.activeReads.add(controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    try { return await this.serialized(async () => {
      combined.throwIfAborted(); await this.reconcile(); const terms = queryTerms(input.query), matches: MemoryMatch[] = [];
      const eligible = this.store.all().filter(entry => this.authorize(entry, input));
      const { similarities, retrieval } = await this.semantic(input.query, eligible, input, combined);
      combined.throwIfAborted();
      for (const entry of eligible) {
        if (!this.authorize(entry, input)) continue;
        const matched = matchedTerms(entry.text, terms), similarity = similarities.get(entry.id);
        const standing = entry.pinned && (entry.kind === "preference" || entry.kind === "routine");
        if (!matched.length && similarity === undefined && !standing) continue;
        const phrase = entry.text.toLocaleLowerCase("en-US").includes(input.query.toLocaleLowerCase("en-US"));
        const ageDays = Math.max(0, Date.parse(this.time()) - Date.parse(entry.updatedAt)) / 86400000;
        const score = Number(((terms.length ? matched.length / terms.length : 0) * 10 + (similarity ?? 0) * 5 + (phrase ? 2 : 0) + (entry.pinned ? 1.5 : 0) + 0.5 / (1 + ageDays / 30)).toFixed(4));
        matches.push({ entry, score, reasons: [`Matched ${matched.length} of ${terms.length} meaningful query terms: ${matched.slice(0, 8).join(", ")}`, ...(similarity === undefined ? [] : [`Local semantic similarity ${similarity.toFixed(3)}`]), ...(standing ? ["Pinned preference or routine selected as standing context"] : []), ...(phrase ? ["Exact phrase match"] : []), ...(entry.pinned ? ["Pinned memory"] : []), "Recency used as a ranking tie-breaker", "Explicitly approved memory; confidence and provenance are recorded, not independent verification"] });
      }
      return { matches: matches.sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt) || a.entry.id.localeCompare(b.entry.id)).slice(0, input.limit), retrieval };
    }); } finally { this.activeReads.delete(controller); }
  }
  async route(method: string, url: URL, body: unknown, context: MemoryContext): Promise<MemoryReply | null> {
    if (!url.pathname.startsWith("/v1/memory/")) return null;
    const reply = (body: unknown, status = 200): MemoryReply => ({ status, body });
    if (method === "GET" && url.pathname === "/v1/memory/status") return reply({ version: 1, enabled: this.enabled });
    this.requireEnabled();
    if (url.pathname === "/v1/memory/entities") {
      this.requireNative(context);
      if (method === "GET") {
        const projectId = url.searchParams.get("projectId");
        return reply({ version: 1, entities: this.store.db().prepare("SELECT body FROM entities ORDER BY id LIMIT 5000").all().map(row => MemoryEntitySchema.parse(JSON.parse(String(row.body)))).filter(entity => this.scopeAllowed(entity, projectId)) });
      }
      if (method === "POST") {
        const input = MemoryEntityInputSchema.parse(body); this.checkContext(input, context);
        if (containsCredentialLikeData(JSON.stringify(input))) throw new BridgeError("Entity labels cannot contain credentials.", 400);
        const entity = MemoryEntitySchema.parse({ ...input, version: 1, id: randomUUID(), revision: 1, updatedAt: this.time() });
        this.store.transaction(() => this.store.db().prepare("INSERT INTO entities VALUES (?,?)").run(entity.id, JSON.stringify(entity))); return reply(entity, 201);
      }
    }
    const history = /^\/v1\/memory\/entries\/([A-Za-z0-9_-]+)\/history$/.exec(url.pathname);
    if (history && method === "GET") {
      this.requireNative(context); this.entry(history[1], context);
      return reply({ version: 1, revisions: this.store.db().prepare("SELECT body FROM entry_history WHERE entry_id=? ORDER BY revision DESC LIMIT 100").all(history[1]).map(row => MemoryEntrySchema.parse(JSON.parse(String(row.body)))) });
    }
    if (url.pathname === "/v1/memory/conflicts" && method === "GET") {
      this.requireNative(context); const entries = (await this.list(url.searchParams.get("projectId"), context)).entries.filter(entry => entry.status === "active" && entry.assertion);
      const conflicts: { left: { id: string; revision: number }; right: { id: string; revision: number }; reason: string }[] = [];
      for (let i = 0; i < entries.length && conflicts.length < 100; i++) for (let j = i + 1; j < entries.length && conflicts.length < 100; j++) {
        const left = entries[i], right = entries[j], a = left.assertion!, b = right.assertion!;
        if (a.entityId === b.entityId && a.property === b.property && a.value !== b.value &&
          Math.max(a.validFrom ? Date.parse(a.validFrom) : -Infinity, b.validFrom ? Date.parse(b.validFrom) : -Infinity) < Math.min(a.validTo ? Date.parse(a.validTo) : Infinity, b.validTo ? Date.parse(b.validTo) : Infinity)) {
          conflicts.push({ left: { id: left.id, revision: left.revision }, right: { id: right.id, revision: right.revision }, reason: "Different values for the same entity and property have overlapping validity; review before choosing a current fact." });
        }
      }
      return reply({ version: 1, conflicts, resolution: "Review both records and explicitly supersede only if one replaces the other; contradictory evidence may remain unresolved." });
    }
    if (url.pathname === "/v1/memory/entries") {
      if (method === "GET") return reply(await this.list(url.searchParams.get("projectId"), context));
      if (method === "POST") return reply(await this.create(body, context), 201);
    }
    if (method === "GET" && url.pathname === "/v1/memory/export") return reply(await this.export(url.searchParams.get("projectId"), context));
    if (method === "POST" && url.pathname === "/v1/memory/proposals") return reply(await this.propose(body, context), 201);
    if (method === "POST" && url.pathname === "/v1/memory/recall") return reply(await this.recall(body, context));
    const match = /^\/v1\/memory\/entries\/([A-Za-z0-9_-]+)(?:\/(approve|archive|forget|supersede))?$/.exec(url.pathname);
    if (match) {
      const [, id, action] = match;
      if (method === "GET" && !action) return reply(await this.inspect(id, context));
      if (method === "PATCH" && !action) return reply(await this.update(id, body, context));
      if (method === "POST" && action === "approve") return reply(await this.approve(id, body, context));
      if (method === "POST" && action === "archive") return reply(await this.archive(id, body, context));
      if (method === "POST" && action === "forget") return reply(await this.forget(id, body, context));
      if (method === "POST" && action === "supersede") return reply(await this.supersede(id, body, context));
    }
    throw new BridgeError("Memory route not found.", 404);
  }
  cancelReads(): void { this.backgroundPaused = true; if (this.backgroundTimer) { clearTimeout(this.backgroundTimer); this.backgroundTimer = undefined; } for (const controller of this.activeReads) controller.abort(new Error("Memory recall stopped")); }
  async close(): Promise<void> { this.cancelReads(); await this.queue; this.closed = true; this.store.close(); }
}
