import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load as loadVectorExtension } from "sqlite-vec";
import { z } from "zod";
import { containsCredentialLikeData, listMemories } from "../../agent/lib/memory.ts";
import { ensurePrivateDirectory, writeJsonAtomically } from "../../agent/lib/persistence.ts";
import { BridgeError } from "../errors.ts";
import {
  DeliverableInputSchema, EvidencePassageSchema, GrantInputSchema, ImportSourceSchema, KnowledgeId,
  ContextSearchInputSchema, IndexEmbeddingsInputSchema, MAX_IMPORT_BYTES, PurposeSchema, ReadGrantSchema, RetrieveInputSchema, SearchInputSchema, SourceVersionSchema,
  type EvidencePassage, type GrantInput, type ImportSource, type ReadGrant, type ResearchDeliverable, type SourceVersion,
} from "./contracts.ts";
import { extractDocument, extractPdf, passageParts, type PdfExtractor } from "./extract.ts";
import { extractPublic, retrievePublic, type RetrievalResult } from "./retrieval.ts";
import { LocalKnowledgeRetrieval } from "./context-retrieval.ts";
import type { LocalEmbeddingProvider } from "./embeddings.ts";

export * from "./contracts.ts";
export type { LocalEmbeddingProvider, EmbeddingIdentity } from "./embeddings.ts";
type Purpose = "local" | "cloud";
type GrantRequest = { grantId: string; projectId: string; resourceId: string; operation: ReadGrant["operations"][number]; purpose: Purpose };
export interface KnowledgeOptions { dataDirectory: string; enabled?: boolean; fetch?: typeof fetch; extractPdf?: PdfExtractor; now?: () => Date; embeddingProvider?: LocalEmbeddingProvider; backgroundIndexing?: boolean }
export interface KnowledgeRouteContext { nativeAuthenticated: boolean }
export interface KnowledgeReply { status: number; body: unknown }
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const asJson = <T>(row: Record<string, unknown> | undefined, key = "record"): T | undefined => row && JSON.parse(String(row[key]));

/** One bridge-owned store; model tools use the authenticated cloud-purpose API. */
export class KnowledgeService {
  readonly enabled: boolean;
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly pdf: PdfExtractor;
  private readonly now: () => Date;
  private connection: DatabaseSync | undefined;
  private readonly activeReads = new Map<string, Set<AbortController>>();
  private readonly options: KnowledgeOptions;
  private preferenceQueue: Promise<void> = Promise.resolve();
  private preferenceGeneration = 0;
  private readonly localRetrieval: LocalKnowledgeRetrieval;
  private retrievalCancellation = new AbortController();
  private nativeVectors = false;
  private backgroundTimer?: NodeJS.Timeout;
  private backgroundBusy = false;
  private backgroundClosed = false;
  private backgroundPaused = false;

  private constructor(options: KnowledgeOptions) {
    this.options = options;
    this.enabled = options.enabled ?? process.env.JARVIS_ENABLE_KNOWLEDGE === "1";
    this.directory = path.join(options.dataDirectory, "knowledge");
    this.fetcher = options.fetch ?? fetch; this.pdf = options.extractPdf ?? extractPdf; this.now = options.now ?? (() => new Date());
    this.localRetrieval = new LocalKnowledgeRetrieval({
      db: () => this.db(), transaction: operation => this.transaction(operation),
      sources: (projectId, purpose, archived) => this.retrievalSources(projectId, purpose, archived),
      guard: (sources, purpose, operation, signal) => {
        const privateSources = sources.filter(source => source.visibility === "private");
        const run = (index: number, current: AbortSignal): Promise<unknown> => index >= privateSources.length ? operation(current) :
          this.withGrant({ grantId: privateSources[index].grantId!, projectId: privateSources[index].projectId,
            resourceId: privateSources[index].resourceId!, operation: "read_document", purpose }, next => run(index + 1, next), current);
        return run(0, signal ?? new AbortController().signal) as ReturnType<typeof operation>;
      },
      audit: (projectId, operation, purpose) => this.audit(projectId, operation, null, purpose), now: this.now,
      nativeVectors: () => this.nativeVectors,
    }, options.embeddingProvider);
  }

  static async open(options: KnowledgeOptions): Promise<KnowledgeService> {
    const service = new KnowledgeService(options);
    if (service.enabled) await service.initialize();
    return service;
  }
  private db(): DatabaseSync {
    if (!this.enabled) throw new BridgeError("Knowledge is disabled. Enable it explicitly in Settings.", 503);
    if (!this.connection) throw new BridgeError("Knowledge store is closed.", 503);
    return this.connection;
  }
  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    await ensurePrivateDirectory(path.join(this.directory, "blobs"));
    const file = path.join(this.directory, "knowledge.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe knowledge database file"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(file, { allowExtension: true }); this.connection = db;
    try { loadVectorExtension(db); this.nativeVectors = true; } catch { this.nativeVectors = false; }
    finally { db.enableLoadExtension(false); }
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error("Unsupported knowledge database version; restore a compatible backup");
      if (version === 1) {
        const backup = path.join(this.directory, "knowledge-v1.before-embeddings.sqlite");
        try {
          const info = await lstat(backup);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe knowledge migration backup");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          db.prepare("VACUUM INTO ?").run(backup);
          await chmod(backup, 0o600);
        }
      }
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned knowledge database is not empty");
        db.exec(`BEGIN EXCLUSIVE;
          CREATE TABLE grants (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record TEXT NOT NULL);
          CREATE TABLE sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id,source_id,revision));
          CREATE INDEX sources_project ON sources(project_id,source_id,revision);
          CREATE TABLE passages (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, project_id TEXT NOT NULL, record TEXT NOT NULL);
          CREATE VIRTUAL TABLE passage_search USING fts5(passage_id UNINDEXED, project_id UNINDEXED, text);
          CREATE TABLE deliverables (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record TEXT NOT NULL);
          CREATE TABLE preferences (id TEXT PRIMARY KEY, text TEXT NOT NULL, imported_at TEXT NOT NULL);
          CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE TABLE access_log (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, project_id TEXT NOT NULL, operation TEXT NOT NULL, resource_id TEXT, purpose TEXT);
          PRAGMA user_version=1; COMMIT;`);
      }
      if (version === 0 || version === 1) this.transaction(() => {
        db.exec(`CREATE TABLE passage_embeddings (
          passage_id TEXT PRIMARY KEY REFERENCES passages(id) ON DELETE CASCADE,
          provider_key TEXT NOT NULL, dimensions INTEGER NOT NULL, text_hash TEXT NOT NULL,
          vector BLOB NOT NULL, indexed_at TEXT NOT NULL);
          CREATE INDEX embedding_model ON passage_embeddings(provider_key,dimensions);
          PRAGMA user_version=2;`);
      });
      if (version === 0 || version === 1 || version === 2) {
        if (version === 2) {
          const backup = path.join(this.directory, `knowledge-v2-${randomUUID()}.backup.sqlite`);
          db.prepare("VACUUM INTO ?").run(backup); await chmod(backup, 0o600);
        }
        this.transaction(() => db.exec(`CREATE TABLE index_jobs(project_id TEXT PRIMARY KEY,state TEXT NOT NULL,updated_at TEXT NOT NULL,error_code TEXT); PRAGMA user_version=3;`));
      }
      // Acquire lifetime exclusive ownership, like the room kernel.
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
      if (!db.prepare("SELECT name FROM migrations WHERE name='legacy-preferences-v1'").get()) {
        const records = await listMemories(this.options.dataDirectory);
        // Preserve the original legacy files and an explicit migration snapshot.
        const backup = path.join(this.directory, "legacy-preferences-v1.backup.json");
        try { await lstat(backup); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await writeJsonAtomically(backup, { version: 1, records });
        }
        this.transaction(() => {
          const insert = db.prepare("INSERT OR IGNORE INTO preferences VALUES (?,?,?)");
          for (const entry of records) insert.run(entry.id, entry.text, this.now().toISOString());
          db.prepare("INSERT INTO migrations VALUES ('legacy-preferences-v1',?)").run(this.now().toISOString());
        });
      }
      await this.reconcilePreferences();
      if (this.options.backgroundIndexing && this.localRetrieval.identity) {
        db.exec("UPDATE index_jobs SET state='pending' WHERE state='running'");
        db.prepare("INSERT OR IGNORE INTO index_jobs SELECT DISTINCT project_id,'pending',?,NULL FROM sources").run(this.now().toISOString());
        this.scheduleIndexing();
      }
    } catch (error) { this.close(); throw error; }
  }
  /** Approved memory files remain authoritative while either feature is disabled.
   * The SQLite rows are a native inspection index, never a second memory authority. */
  private reconcilePreferences(): Promise<void> {
    const operation = this.preferenceQueue.then(async () => {
      let generation: number, records: Awaited<ReturnType<typeof listMemories>>;
      do {
        generation = this.preferenceGeneration;
        records = await listMemories(this.options.dataDirectory);
      } while (generation !== this.preferenceGeneration);
      const ids = new Set(records.map(entry => entry.id));
      this.transaction(() => {
        const upsert = this.db().prepare("INSERT INTO preferences(id,text,imported_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text");
        const importedAt = this.now().toISOString();
        for (const entry of records) upsert.run(entry.id, entry.text, importedAt);
        const remove = this.db().prepare("DELETE FROM preferences WHERE id=?");
        for (const row of this.db().prepare("SELECT id FROM preferences").all()) if (!ids.has(String(row.id))) remove.run(String(row.id));
      });
    });
    this.preferenceQueue = operation.catch(() => {});
    return operation;
  }
  close(): void {
    this.backgroundClosed = true; if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.cancelReads(); this.connection?.close(); this.connection = undefined;
  }
  cancelReads(): void {
    this.backgroundPaused = true;
    this.retrievalCancellation.abort(new Error("Knowledge retrieval stopped"));
    this.retrievalCancellation = new AbortController();
    for (const controllers of this.activeReads.values()) for (const controller of controllers) controller.abort(new Error("Knowledge read stopped"));
    this.activeReads.clear();
    // Cancellation must reach active helpers even if persistence is unavailable
    // or initialization failed before the queue schema existed.
    try { this.connection?.prepare("UPDATE index_jobs SET state='paused' WHERE state IN ('pending','running')").run(); } catch {}
  }
  private scheduleIndexing(): void {
    if (!this.options.backgroundIndexing || !this.localRetrieval.identity || this.backgroundClosed || this.backgroundPaused || this.backgroundBusy || this.backgroundTimer) return;
    this.backgroundTimer = setTimeout(() => { this.backgroundTimer = undefined; void this.runIndexJob(); }, 100);
    this.backgroundTimer.unref();
  }
  private async runIndexJob(): Promise<void> {
    if (this.backgroundClosed || !this.connection) return;
    const job = this.db().prepare("SELECT project_id FROM index_jobs WHERE state='pending' ORDER BY updated_at,project_id LIMIT 1").get();
    if (!job) return;
    const projectId = String(job.project_id); this.backgroundBusy = true;
    this.db().prepare("UPDATE index_jobs SET state='running',error_code=NULL WHERE project_id=?").run(projectId);
    try {
      const result = await this.indexEmbeddings({ projectId, limit: 16 });
      if (!this.backgroundClosed && this.connection) this.db().prepare("UPDATE index_jobs SET state=?,updated_at=? WHERE project_id=? AND state='running'")
        .run(result.remaining ? "pending" : "complete", this.now().toISOString(), projectId);
    } catch {
      if (!this.backgroundClosed && this.connection) this.db().prepare("UPDATE index_jobs SET state='paused',error_code='local_index_unavailable',updated_at=? WHERE project_id=? AND state='running'").run(this.now().toISOString(), projectId);
    } finally { this.backgroundBusy = false; this.scheduleIndexing(); }
  }
  queueIndexing(projectId: string, action: "resume" | "pause" = "resume") {
    KnowledgeId.parse(projectId);
    this.db().prepare("INSERT INTO index_jobs VALUES (?,?,?,NULL) ON CONFLICT(project_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,error_code=NULL")
      .run(projectId, action === "resume" ? "pending" : "paused", this.now().toISOString());
    if (action === "resume") { this.backgroundPaused = false; this.scheduleIndexing(); }
    return this.indexingStatus(projectId);
  }
  indexingStatus(projectId: string) {
    KnowledgeId.parse(projectId);
    const row = this.db().prepare("SELECT state,updated_at,error_code FROM index_jobs WHERE project_id=?").get(projectId);
    return { version: 1, projectId, available: this.localRetrieval.identity !== null, backgroundEnabled: this.options.backgroundIndexing === true,
      state: row ? String(row.state) : "idle", updatedAt: row ? String(row.updated_at) : null, errorCode: row?.error_code ?? null };
  }
  private transaction<T>(operation: () => T): T {
    const db = this.db(); db.exec("BEGIN EXCLUSIVE");
    try { const result = operation(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  private audit(projectId: string, operation: string, resourceId: string | null, purpose: Purpose | null = null): void {
    this.db().prepare("INSERT INTO access_log(at,project_id,operation,resource_id,purpose) VALUES (?,?,?,?,?)")
      .run(this.now().toISOString(), projectId, operation, resourceId, purpose);
    this.db().exec("DELETE FROM access_log WHERE sequence < (SELECT COALESCE(MAX(sequence),0)-10000 FROM access_log)");
  }
  listGrants(projectId: string): ReadGrant[] {
    KnowledgeId.parse(projectId);
    return this.db().prepare("SELECT record FROM grants WHERE project_id=? ORDER BY id").all(projectId).map(row => ReadGrantSchema.parse(asJson(row)));
  }
  createGrant(raw: GrantInput): ReadGrant {
    const input = GrantInputSchema.parse(raw);
    if (input.expiresAt && Date.parse(input.expiresAt) <= this.now().getTime()) throw new BridgeError("Grant expiry must be in the future.", 400);
    if (containsCredentialLikeData(input.label) || containsCredentialLikeData(input.resourceId)) throw new BridgeError("Grant labels and identities cannot contain credentials.", 400);
    const grant: ReadGrant = { ...input, version: 1, id: randomUUID(), revision: 1, createdAt: this.now().toISOString(), revokedAt: null };
    this.transaction(() => { this.db().prepare("INSERT INTO grants VALUES (?,?,?)").run(grant.id, grant.projectId, JSON.stringify(grant)); this.audit(grant.projectId, "grant_created", grant.id); });
    return grant;
  }
  revokeGrant(id: string, expectedRevision: number): ReadGrant {
    KnowledgeId.parse(id);
    const grant = this.grant(id);
    if (grant.revision !== expectedRevision) throw new BridgeError("Grant changed. Refresh before revoking.", 409);
    if (grant.revokedAt) return grant;
    const updated = { ...grant, revision: grant.revision + 1, revokedAt: this.now().toISOString() };
    this.transaction(() => { this.db().prepare("UPDATE grants SET record=? WHERE id=?").run(JSON.stringify(updated), id); this.audit(grant.projectId, "grant_revoked", id); });
    for (const controller of this.activeReads.get(id) ?? []) controller.abort(new Error("Read grant revoked"));
    return updated;
  }
  updateGrant(id: string, expectedRevision: number, changes: { cloudAllowed?: boolean; expiresAt?: string | null }): ReadGrant {
    KnowledgeId.parse(id);
    const grant = this.grant(id);
    if (grant.revision !== expectedRevision || grant.revokedAt) throw new BridgeError("Grant changed or was revoked. Refresh before changing access.", 409);
    if (changes.cloudAllowed === undefined && changes.expiresAt === undefined) throw new BridgeError("No grant change was supplied.", 400);
    const next = ReadGrantSchema.parse({ ...grant, ...changes, revision: grant.revision + 1 });
    if (next.expiresAt && Date.parse(next.expiresAt) <= this.now().getTime()) throw new BridgeError("Grant expiry must be in the future.", 400);
    this.transaction(() => { this.db().prepare("UPDATE grants SET record=? WHERE id=?").run(JSON.stringify(next), id); this.audit(grant.projectId, "grant_updated", id); });
    for (const controller of this.activeReads.get(id) ?? []) controller.abort(new Error("Read grant changed"));
    return next;
  }
  private grant(id: string): ReadGrant {
    const row = this.db().prepare("SELECT record FROM grants WHERE id=?").get(id);
    if (!row) throw new BridgeError("Read grant not found.", 403);
    return ReadGrantSchema.parse(asJson(row));
  }
  requireGrant(input: GrantRequest): ReadGrant {
    const grant = this.grant(input.grantId);
    if (grant.projectId !== input.projectId || grant.resourceId !== input.resourceId || !grant.operations.includes(input.operation) || grant.revokedAt ||
      grant.expiresAt !== null && Date.parse(grant.expiresAt) <= this.now().getTime() || input.purpose === "cloud" && !grant.cloudAllowed) {
      throw new BridgeError("Read or cloud disclosure is outside the current source grant.", 403);
    }
    return grant;
  }
  async withGrant<T>(input: GrantRequest, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); const before = this.requireGrant(input);
    const controller = new AbortController();
    let controllers = this.activeReads.get(before.id); if (!controllers) this.activeReads.set(before.id, controllers = new Set());
    controllers.add(controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    try {
      const result = await operation(combined); combined.throwIfAborted();
      const after = this.requireGrant(input);
      if (after.revision !== before.revision) throw new BridgeError("Source permission changed while reading.", 409);
      this.audit(input.projectId, "read", input.resourceId, input.purpose); return result;
    } finally { controllers.delete(controller); if (!controllers.size) this.activeReads.delete(before.id); }
  }
  private assertSource(source: SourceVersion, purpose: Purpose): void {
    if (source.visibility === "private") this.requireGrant({ grantId: source.grantId!, projectId: source.projectId, resourceId: source.resourceId!, operation: "read_document", purpose });
  }
  private rowSource(row: Record<string, unknown>): SourceVersion { return SourceVersionSchema.parse({ ...asJson<object>(row), archived: Boolean(row.archived) }); }
  private source(id: string, projectId: string, purpose: Purpose): SourceVersion {
    KnowledgeId.parse(id); KnowledgeId.parse(projectId);
    const row = this.db().prepare("SELECT record,archived FROM sources WHERE id=? AND project_id=?").get(id, projectId);
    if (!row) throw new BridgeError("Source not found in this project.", 404);
    const source = this.rowSource(row); this.assertSource(source, purpose); return source;
  }
  private passages(id: string): EvidencePassage[] {
    return this.db().prepare("SELECT record FROM passages WHERE source_id=?").all(id).map(row => EvidencePassageSchema.parse(asJson(row))).sort((a, b) => a.ordinal - b.ordinal);
  }
  private async writeBlob(bytes: Buffer): Promise<string> {
    const digest = sha256(bytes), file = path.join(this.directory, "blobs", digest), temporary = path.join(this.directory, "blobs", `.${randomUUID()}`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await rm(temporary, { force: true }); }
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || sha256(await readFile(file)) !== digest) throw new BridgeError("Source blob integrity check failed.", 500);
    return digest;
  }
  private storeSource(input: Omit<SourceVersion, "id" | "revision" | "sourceId"> & { sourceId?: string }, parts: ReturnType<typeof passageParts>): { source: SourceVersion; passages: EvidencePassage[] } {
    const stored = this.transaction(() => {
      let revision = 1;
      if (input.sourceId) {
        const previous = this.db().prepare("SELECT record,archived FROM sources WHERE project_id=? AND source_id=? ORDER BY revision DESC LIMIT 1").get(input.projectId, input.sourceId);
        if (!previous) throw new BridgeError("Source to supersede was not found in this project.", 404);
        const old = this.rowSource(previous);
        if (old.visibility !== input.visibility || old.resourceId !== input.resourceId) throw new BridgeError("New versions must retain the original source identity and visibility.", 409);
        revision = old.revision + 1;
      }
      const source = SourceVersionSchema.parse({ ...input, id: randomUUID(), sourceId: input.sourceId ?? randomUUID(), revision });
      this.assertSource(source, "local");
      const passages = parts.map((part, ordinal) => EvidencePassageSchema.parse({ ...part, id: randomUUID(), sourceVersionId: source.id, projectId: source.projectId, ordinal }));
      this.db().prepare("INSERT INTO sources(id,project_id,source_id,revision,record) VALUES (?,?,?,?,?)").run(source.id, source.projectId, source.sourceId, source.revision, JSON.stringify(source));
      const passage = this.db().prepare("INSERT INTO passages VALUES (?,?,?,?)"), search = this.db().prepare("INSERT INTO passage_search VALUES (?,?,?)");
      for (const item of passages) { passage.run(item.id, source.id, source.projectId, JSON.stringify(item)); search.run(item.id, source.projectId, item.text); }
      this.audit(source.projectId, "source_imported", source.id); return { source, passages };
    });
    if (this.options.backgroundIndexing) this.queueIndexing(stored.source.projectId);
    return stored;
  }
  async importSource(raw: ImportSource, signal?: AbortSignal): Promise<{ source: SourceVersion; passages: EvidencePassage[] }> {
    this.db(); const input = ImportSourceSchema.parse(raw);
    const bytes = Buffer.from(input.bytesBase64, "base64");
    if (bytes.length > MAX_IMPORT_BYTES || bytes.toString("base64") !== input.bytesBase64) throw new BridgeError("Invalid or oversized source bytes.", 413);
    return this.withGrant({ grantId: input.grantId, projectId: input.projectId, resourceId: input.resourceId, operation: "read_document", purpose: "local" }, async combined => {
      if (input.nativePDFPages && input.mediaType !== "application/pdf" && !/\.pdf$/i.test(input.filename)) throw new BridgeError("Native page extraction is only valid for a PDF source.", 400);
      const pdf: PdfExtractor = input.nativePDFPages ? async () => input.nativePDFPages!.map((text, index) => ({ text, page: index + 1 })) : this.pdf;
      const extraction = await extractDocument(bytes, input.filename, input.mediaType, pdf, combined);
      if (containsCredentialLikeData(extraction.pages.map(page => page.text).join("\n"))) throw new BridgeError("Document contains credential-like data. Import a redacted copy.", 400);
      const digest = await this.writeBlob(bytes); combined.throwIfAborted();
      this.requireGrant({ grantId: input.grantId, projectId: input.projectId, resourceId: input.resourceId, operation: "read_document", purpose: "local" });
      return this.storeSource({ version: 1, projectId: input.projectId, title: input.title, filename: input.filename, mediaType: input.mediaType,
        sha256: digest, bytes: bytes.length, visibility: "private", grantId: input.grantId, resourceId: input.resourceId,
        kind: "document", url: null, createdAt: this.now().toISOString(), extraction: extraction.extraction, archived: false, sourceId: input.sourceId }, passageParts(extraction.pages));
    }, signal);
  }
  listSources(projectId: string, purpose: Purpose = "cloud", includeArchived = false): SourceVersion[] {
    KnowledgeId.parse(projectId);
    const rows = this.db().prepare(`SELECT s.record,s.archived FROM sources s WHERE project_id=? AND revision=(SELECT MAX(revision) FROM sources newer WHERE newer.project_id=s.project_id AND newer.source_id=s.source_id) ORDER BY rowid DESC LIMIT 2000`).all(projectId);
    return rows.map(row => this.rowSource(row)).filter(source => {
      if (!includeArchived && source.archived) return false;
      try { this.assertSource(source, purpose); return true; } catch (error) { if (error instanceof BridgeError && error.status === 403) return false; throw error; }
    });
  }
  private retrievalSources(projectId: string, purpose: Purpose, includeArchived: boolean): SourceVersion[] {
    KnowledgeId.parse(projectId);
    // Coarse SQL authorization avoids inaccessible recent documents starving old
    // permitted evidence before the limit. assertSource remains the authority.
    const rows = this.db().prepare(`SELECT s.record,s.archived FROM sources s
      WHERE s.project_id=? AND (? OR s.archived=0)
      AND s.revision=(SELECT MAX(revision) FROM sources latest WHERE latest.project_id=s.project_id AND latest.source_id=s.source_id)
      AND (json_extract(s.record,'$.visibility')='public' OR EXISTS (
        SELECT 1 FROM grants g WHERE g.id=json_extract(s.record,'$.grantId') AND g.project_id=s.project_id
        AND json_extract(g.record,'$.projectId')=s.project_id
        AND json_extract(g.record,'$.resourceId')=json_extract(s.record,'$.resourceId')
        AND json_extract(g.record,'$.revokedAt') IS NULL
        AND (json_extract(g.record,'$.expiresAt') IS NULL OR json_extract(g.record,'$.expiresAt')>?)
        AND (?='local' OR json_extract(g.record,'$.cloudAllowed')=1)
        AND EXISTS (SELECT 1 FROM json_each(g.record,'$.operations') operation WHERE operation.value='read_document')
      )) ORDER BY s.rowid DESC LIMIT 2000`).all(projectId, includeArchived ? 1 : 0, this.now().toISOString(), purpose);
    return rows.map(row => this.rowSource(row)).filter(source => {
      try { this.assertSource(source, purpose); return true; }
      catch (error) { if (error instanceof BridgeError && error.status === 403) return false; throw error; }
    });
  }
  readSource(id: string, projectId: string, purpose: Purpose = "cloud") {
    const source = this.source(id, projectId, purpose), passages = this.passages(id);
    this.audit(projectId, "source_read", id, purpose); return { source, passages, contentTrust: "untrusted" as const };
  }
  readPassage(id: string, projectId: string, purpose: Purpose = "cloud") {
    KnowledgeId.parse(id); KnowledgeId.parse(projectId);
    const row = this.db().prepare("SELECT record FROM passages WHERE id=? AND project_id=?").get(id, projectId);
    if (!row) throw new BridgeError("Passage not found in this project.", 404);
    const passage = EvidencePassageSchema.parse(asJson(row));
    const source = this.source(passage.sourceVersionId, projectId, purpose);
    const latest = this.db().prepare("SELECT MAX(revision) AS revision FROM sources WHERE project_id=? AND source_id=?").get(projectId, source.sourceId);
    if (source.archived || latest?.revision !== source.revision) throw new BridgeError("Pinned passage belongs to archived or superseded evidence. Review the current source version.", 409);
    this.audit(projectId, "passage_read", id, purpose);
    return { source, passage, contentTrust: "untrusted" as const };
  }
  search(raw: z.input<typeof SearchInputSchema>) {
    return this.localRetrieval.search(raw);
  }
  async indexEmbeddings(raw: z.input<typeof IndexEmbeddingsInputSchema>, signal?: AbortSignal) {
    this.db();
    return this.localRetrieval.index(raw, AbortSignal.any([this.retrievalCancellation.signal, ...(signal ? [signal] : [])]));
  }
  async retrieveContext(raw: z.input<typeof ContextSearchInputSchema>, signal?: AbortSignal) {
    this.db();
    return this.localRetrieval.retrieve(raw, AbortSignal.any([this.retrievalCancellation.signal, ...(signal ? [signal] : [])]));
  }
  archiveSource(id: string, projectId: string, archived: boolean): SourceVersion {
    const source = this.source(id, projectId, "local");
    this.transaction(() => { this.db().prepare("UPDATE sources SET archived=? WHERE project_id=? AND source_id=?").run(archived ? 1 : 0, projectId, source.sourceId); this.audit(projectId, archived ? "source_archived" : "source_restored", id); });
    return { ...source, archived };
  }
  async deleteSource(id: string, projectId: string): Promise<void> {
    // Removal remains possible after revocation; no private bytes are returned.
    KnowledgeId.parse(id); KnowledgeId.parse(projectId);
    const row = this.db().prepare("SELECT record,archived FROM sources WHERE id=? AND project_id=?").get(id, projectId);
    if (!row) throw new BridgeError("Source not found in this project.", 404);
    const source = this.rowSource(row);
    this.transaction(() => {
      this.db().prepare("DELETE FROM passage_search WHERE passage_id IN (SELECT id FROM passages WHERE source_id=?)").run(id);
      this.db().prepare("DELETE FROM sources WHERE id=? AND project_id=?").run(id, projectId);
      this.audit(projectId, "source_deleted", id);
    });
    const referenced = this.db().prepare("SELECT 1 FROM sources WHERE json_extract(record,'$.sha256')=? LIMIT 1").get(source.sha256);
    if (!referenced) await rm(path.join(this.directory, "blobs", source.sha256), { force: true });
  }
  async retrieve(raw: z.input<typeof RetrieveInputSchema>, signal?: AbortSignal) {
    this.db(); const input = RetrieveInputSchema.parse(raw);
    const result = await retrievePublic(input, this.fetcher, signal);
    return this.saveRetrieval(input.projectId, result, signal);
  }
  async extract(projectId: string, urls: string[], signal?: AbortSignal) {
    this.db(); KnowledgeId.parse(projectId); z.array(z.string().max(2_000)).min(1).max(3).parse(urls);
    return this.saveRetrieval(projectId, await extractPublic(urls, this.fetcher, signal), signal);
  }
  private async saveRetrieval(projectId: string, result: RetrievalResult, signal?: AbortSignal) {
    const imported: { source: SourceVersion; passages: EvidencePassage[] }[] = [];
    for (const evidence of result.sources) {
      if (containsCredentialLikeData(evidence.text) || containsCredentialLikeData(evidence.title)) {
        result.errors.push("A retrieved source containing credential-like data was omitted."); continue;
      }
      signal?.throwIfAborted(); const bytes = Buffer.from(evidence.text, "utf8"), digest = await this.writeBlob(bytes); signal?.throwIfAborted();
      imported.push(this.storeSource({ version: 1, projectId, title: evidence.title || evidence.url, filename: "retrieved.txt", mediaType: "text/plain", sha256: digest, bytes: bytes.length,
        visibility: "public", grantId: null, resourceId: null, kind: evidence.metadataOnly ? "metadata" : "web", url: evidence.url,
        createdAt: this.now().toISOString(), extraction: evidence.metadataOnly ? "metadata_only" : evidence.truncated ? "truncated" : "text", archived: false }, passageParts([{ text: evidence.text, page: null }])));
    }
    return { sources: imported, errors: result.errors, usage: result.usage, contentTrust: "untrusted" as const };
  }
  createDeliverable(raw: z.input<typeof DeliverableInputSchema>): ResearchDeliverable {
    const input = DeliverableInputSchema.parse(raw);
    if (containsCredentialLikeData(input.markdown)) throw new BridgeError("Deliverables cannot contain credential-like data.", 400);
    for (const claim of input.claims) {
      if (claim.status === "supported" && !claim.citations.length) throw new BridgeError("A supported claim requires a source passage.", 400);
      for (const citation of claim.citations) {
        const passage = asJson<EvidencePassage>(this.db().prepare("SELECT record FROM passages WHERE id=? AND project_id=?").get(citation.passageId, input.projectId));
        if (!passage) throw new BridgeError("Citation does not belong to this project's current evidence.", 400);
        const source = this.source(passage.sourceVersionId, input.projectId, "cloud");
        if (!passage.text.includes(citation.quote)) throw new BridgeError("Citation quote does not match its source passage.", 400);
        if (source.extraction === "metadata_only" && claim.status === "supported") {
          // Metadata can support bibliographic claims, but never represents a full-text verification.
          if (!/metadata|abstract|title|author|publication|doi|bibliograph/i.test(claim.text)) throw new BridgeError("Metadata-only evidence must be identified as metadata or abstract in the claim.", 400);
        }
      }
    }
    // Conservatively retain private-context dependencies even if a model omits a citation.
    const sourceVersionIds = new Set(this.listSources(input.projectId, "cloud").filter(source => source.visibility === "private").map(source => source.id));
    for (const claim of input.claims) for (const citation of claim.citations) {
      const passage = asJson<EvidencePassage>(this.db().prepare("SELECT record FROM passages WHERE id=? AND project_id=?").get(citation.passageId, input.projectId))!;
      sourceVersionIds.add(passage.sourceVersionId);
    }
    const deliverable: ResearchDeliverable = { ...input, version: 1, id: randomUUID(), createdAt: this.now().toISOString(), sourceVersionIds: [...sourceVersionIds], citationCheck: "locators_and_quotes_verified", critique: "requires_review", checkAuthority: "reported_not_independently_verified" };
    this.transaction(() => { this.db().prepare("INSERT INTO deliverables VALUES (?,?,?)").run(deliverable.id, input.projectId, JSON.stringify(deliverable)); this.audit(input.projectId, "deliverable_created", deliverable.id, "cloud"); });
    return deliverable;
  }
  private assertDeliverable(value: ResearchDeliverable, purpose: Purpose): void {
    for (const sourceId of value.sourceVersionIds ?? []) this.source(sourceId, value.projectId, purpose);
    for (const claim of value.claims) for (const citation of claim.citations) {
      const passage = asJson<EvidencePassage>(this.db().prepare("SELECT record FROM passages WHERE id=? AND project_id=?").get(citation.passageId, value.projectId));
      if (!passage) throw new BridgeError("Deliverable evidence was deleted; review this artifact locally before disclosure.", 409);
      this.source(passage.sourceVersionId, value.projectId, purpose);
    }
  }
  readDeliverable(id: string, projectId: string, purpose: Purpose = "cloud"): ResearchDeliverable {
    KnowledgeId.parse(id); KnowledgeId.parse(projectId);
    const value = asJson<ResearchDeliverable>(this.db().prepare("SELECT record FROM deliverables WHERE id=? AND project_id=?").get(id, projectId));
    if (!value) throw new BridgeError("Deliverable not found in this project.", 404);
    this.assertDeliverable(value, purpose); return value;
  }
  async exportProject(projectId: string) {
    const sources: { source: SourceVersion; passages: EvidencePassage[]; bytesBase64: string }[] = []; let total = 0;
    KnowledgeId.parse(projectId);
    const versions = this.db().prepare("SELECT record,archived FROM sources WHERE project_id=? ORDER BY source_id,revision LIMIT 5000").all(projectId).map(row => this.rowSource(row));
    for (const source of versions) {
      try { this.assertSource(source, "local"); } catch (error) { if (error instanceof BridgeError && error.status === 403) continue; throw error; }
      total += source.bytes; if (total > 16 * 1_024 * 1_024) throw new BridgeError("Project export exceeds 16 MiB; export sources separately.", 413);
      const file = path.join(this.directory, "blobs", source.sha256), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new BridgeError("Source integrity check failed.", 500);
      const bytes = await readFile(file); if (sha256(bytes) !== source.sha256) throw new BridgeError("Source integrity check failed.", 500);
      this.assertSource(source, "local"); sources.push({ source, passages: this.passages(source.id), bytesBase64: bytes.toString("base64") });
    }
    // Recheck every grant after asynchronous disk reads, immediately before disclosure.
    for (const item of sources) this.assertSource(item.source, "local");
    const deliverables = this.db().prepare("SELECT record FROM deliverables WHERE project_id=?").all(projectId).map(row => asJson<ResearchDeliverable>(row)!);
    for (const value of deliverables) this.assertDeliverable(value, "local");
    return { version: 1, projectId, sources, deliverables, preferences: [] };
  }

  deletePreference(id: string): void {
    this.preferenceGeneration++;
    if (!this.enabled || !this.connection) return;
    KnowledgeId.parse(id);
    this.db().prepare("DELETE FROM preferences WHERE id=?").run(id);
  }

  async route(method: string, url: URL, body: unknown, context: KnowledgeRouteContext, signal?: AbortSignal): Promise<KnowledgeReply | null> {
    const pathname = url.pathname;
    if (!pathname.startsWith("/v1/knowledge/") && pathname !== "/v1/grants" && !pathname.startsWith("/v1/grants/")) return null;
    const native = () => { if (!context.nativeAuthenticated) throw new BridgeError("This operation requires the trusted native controls.", 403); };
    const project = () => KnowledgeId.parse(url.searchParams.get("projectId"));
    const purpose = () => { const value = PurposeSchema.parse(url.searchParams.get("purpose") ?? (context.nativeAuthenticated ? "local" : "cloud")); if (value === "local") native(); return value; };
    const reply = (body: unknown, status = 200): KnowledgeReply => ({ status, body });
    if (method === "GET" && pathname === "/v1/knowledge/status") return reply({ version: 1, enabled: this.enabled,
      embeddings: { provider: this.localRetrieval.identity, local: true, available: this.enabled && this.localRetrieval.identity !== null },
      features: ["scoped_sources", "fts_search", "read_grants", "citations", "public_retrieval", "local_hybrid_retrieval"] });
    this.db();
    if (pathname === "/v1/grants") {
      native(); if (method === "GET") return reply({ grants: this.listGrants(project()) });
      if (method === "POST") return reply(this.createGrant(GrantInputSchema.parse(body)), 201);
    }
    const revoke = /^\/v1\/grants\/([^/]+)\/revoke$/.exec(pathname);
    if (revoke && method === "POST") { native(); const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(body); return reply(this.revokeGrant(revoke[1], input.expectedRevision)); }
    const grant = /^\/v1\/grants\/([^/]+)$/.exec(pathname);
    if (grant && method === "PATCH") {
      native(); const input = z.strictObject({ expectedRevision: z.number().int().positive(), cloudAllowed: z.boolean().optional(), expiresAt: z.iso.datetime().nullable().optional() }).parse(body);
      const { expectedRevision, ...changes } = input; return reply(this.updateGrant(grant[1], expectedRevision, changes));
    }
    if (pathname === "/v1/knowledge/import" && method === "POST") { native(); return reply(await this.importSource(ImportSourceSchema.parse(body), signal), 201); }
    if (pathname === "/v1/knowledge/sources" && method === "GET") return reply({ sources: this.listSources(project(), purpose(), url.searchParams.get("includeArchived") === "true") });
    const passage = /^\/v1\/knowledge\/passages\/([^/]+)$/.exec(pathname);
    if (passage && method === "GET") return reply(this.readPassage(passage[1], project(), purpose()));
    const source = /^\/v1\/knowledge\/sources\/([^/]+)$/.exec(pathname);
    if (source) {
      if (method === "GET") return reply(this.readSource(source[1], project(), purpose()));
      if (method === "DELETE") { native(); await this.deleteSource(source[1], project()); return reply({ deleted: true }); }
    }
    const archive = /^\/v1\/knowledge\/sources\/([^/]+)\/archive$/.exec(pathname);
    if (archive && method === "POST") { native(); const input = z.strictObject({ projectId: KnowledgeId, archived: z.boolean() }).parse(body); return reply(this.archiveSource(archive[1], input.projectId, input.archived)); }
    if (pathname === "/v1/knowledge/search" && method === "POST") {
      const input = SearchInputSchema.parse(body); if (input.purpose === "local") native(); return reply(this.search(input));
    }
    if (pathname === "/v1/knowledge/context" && method === "POST") {
      const input = ContextSearchInputSchema.parse(body); if (input.purpose === "local") native();
      return reply(await this.retrieveContext(input, signal));
    }
    if (pathname === "/v1/knowledge/index" && method === "POST") {
      native(); return reply(await this.indexEmbeddings(IndexEmbeddingsInputSchema.parse(body), signal));
    }
    if (pathname === "/v1/knowledge/index-status" && method === "GET") { native(); return reply(this.indexingStatus(project())); }
    if (pathname === "/v1/knowledge/index-queue" && method === "POST") {
      native(); const input = z.strictObject({ projectId: KnowledgeId, action: z.enum(["resume", "pause"]) }).parse(body); return reply(this.queueIndexing(input.projectId, input.action));
    }
    if (pathname === "/v1/knowledge/retrieve" && method === "POST") return reply(await this.retrieve(RetrieveInputSchema.parse(body), signal), 201);
    if (pathname === "/v1/knowledge/extract" && method === "POST") {
      const input = z.strictObject({ projectId: KnowledgeId, urls: z.array(z.string().max(2_000)).min(1).max(3) }).parse(body); return reply(await this.extract(input.projectId, input.urls, signal), 201);
    }
    if (pathname === "/v1/knowledge/deliverables" && method === "POST") return reply(this.createDeliverable(DeliverableInputSchema.parse(body)), 201);
    const deliverable = /^\/v1\/knowledge\/deliverables\/([^/]+)$/.exec(pathname);
    if (deliverable && method === "GET") return reply(this.readDeliverable(deliverable[1], project(), purpose()));
    if (pathname === "/v1/knowledge/export" && method === "GET") { native(); return reply(await this.exportProject(project())); }
    if (pathname === "/v1/knowledge/preferences" && method === "GET") {
      native(); await this.reconcilePreferences();
      return reply({ preferences: this.db().prepare("SELECT id,text,imported_at AS importedAt FROM preferences ORDER BY id").all(), scope: "personal", origin: "user_approved_preferences" });
    }
    if (pathname === "/v1/knowledge/access-log" && method === "GET") { native(); return reply({ entries: this.db().prepare("SELECT sequence,at,operation,resource_id AS resourceId,purpose FROM access_log WHERE project_id=? ORDER BY sequence DESC LIMIT 200").all(project()) }); }
    throw new BridgeError("Knowledge route not found or method unsupported.", 404);
  }
}
