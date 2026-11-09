import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { containsCredentialLikeData } from "../../agent/lib/memory.ts";
import { BridgeError } from "../errors.ts";
import { ContextId, ContextPacketSchema, type ContextPacket } from "../context/contracts.ts";
import { queryTerms } from "../knowledge/embeddings.ts";
import { CommittedTaskEpisodeSchema, ProjectEpisodeSchema, UsageManifestSchema, WorkingSetSchema, WorkingSetUpdateSchema,
  type ContinuityReference, type ProjectEpisode, type UsageManifest } from "./contracts.ts";
export * from "./contracts.ts";
type Purpose = "local" | "cloud";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface ContinuityOptions {
  dataDirectory: string; enabled: boolean; now?: () => Date;
  authorizeReference(reference: ContinuityReference, access: { projectId: string; purpose: Purpose }): boolean;
}

/** Derived project history. This store owns no executable jobs or approvals. */
export class ContinuityService {
  readonly enabled: boolean;
  private connection?: DatabaseSync;
  private readonly options: ContinuityOptions;
  private constructor(options: ContinuityOptions) { this.options = options; this.enabled = options.enabled; }
  static async open(options: ContinuityOptions): Promise<ContinuityService> {
    const service = new ContinuityService(options);
    if (options.enabled) await service.initialize();
    return service;
  }
  private time() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private db() { if (!this.enabled || !this.connection) throw new BridgeError("Project continuity is disabled or closed.", 503); return this.connection; }
  private async initialize() {
    const directory = path.join(this.options.dataDirectory, "continuity"); await ensurePrivateDirectory(directory);
    const file = path.join(directory, "continuity.sqlite");
    try { const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe continuity store"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(file); this.connection = db;
    try {
      db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported continuity version");
      if (version === 0) db.exec(`BEGIN EXCLUSIVE;
        CREATE TABLE episodes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(project_id,event_id));
        CREATE INDEX episode_project ON episodes(project_id,sequence);
        CREATE VIRTUAL TABLE episode_search USING fts5(episode_id UNINDEXED,project_id UNINDEXED,text);
        CREATE TABLE working_sets(project_id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE manifests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT,body TEXT NOT NULL);
        CREATE INDEX manifest_task ON manifests(project_id,task_id);
        CREATE TABLE checkpoints(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision INTEGER NOT NULL,episode_ids TEXT NOT NULL,working_revision INTEGER NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
    } catch (error) { this.close(); throw error; }
  }
  private transaction<T>(operation: () => T): T {
    const db = this.db(); db.exec("BEGIN EXCLUSIVE");
    try { const value = operation(); db.exec("COMMIT"); return value; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  recordCommittedTask(raw: z.input<typeof CommittedTaskEpisodeSchema>): ProjectEpisode {
    const input = CommittedTaskEpisodeSchema.parse(raw);
    if (containsCredentialLikeData(JSON.stringify(input))) throw new BridgeError("Episode contains credential-like content.", 400);
    if (input.outcomeAuthority === "runtime_status" && input.observedOutcome && input.observedOutcome !== input.status) {
      throw new BridgeError("Runtime-status episodes can contain only the observed status; prose must be labeled an unverified summary.", 400);
    }
    const digest = hash(input), id = `episode-${hash([input.projectId, input.eventId]).slice(0, 48)}`;
    return this.transaction(() => {
      const old = this.db().prepare("SELECT body FROM episodes WHERE project_id=? AND event_id=?").get(input.projectId, input.eventId);
      if (old) {
        const episode = ProjectEpisodeSchema.parse(JSON.parse(String(old.body)));
        if (episode.digest !== digest) throw new BridgeError("Committed episode identity was reused with different content.", 409);
        return episode;
      }
      const revision = Number(this.db().prepare("SELECT COUNT(*) AS total FROM episodes WHERE project_id=? AND task_id=?").get(input.projectId, input.taskId)?.total ?? 0) + 1;
      const result = this.db().prepare("INSERT INTO episodes(id,project_id,task_id,event_id,digest,body) VALUES (?,?,?,?,?,'{}')").run(id, input.projectId, input.taskId, input.eventId, digest);
      const episode = ProjectEpisodeSchema.parse({ ...input, version: 1, id, revision, digest, sequence: Number(result.lastInsertRowid) });
      this.db().prepare("UPDATE episodes SET body=? WHERE id=?").run(JSON.stringify(episode), id);
      this.db().prepare("INSERT INTO episode_search VALUES (?,?,?)").run(id, input.projectId, `${input.goal}\n${input.observedOutcome ?? input.status}`);
      return episode;
    });
  }
  getWorkingSet(projectId: string) {
    ContextId.parse(projectId);
    const row = this.db().prepare("SELECT body FROM working_sets WHERE project_id=?").get(projectId);
    return WorkingSetSchema.parse(row ? JSON.parse(String(row.body)) : { version: 1, projectId, revision: 0, pins: [], goal: null, updatedAt: null });
  }
  updateWorkingSet(projectId: string, raw: unknown) {
    const input = WorkingSetUpdateSchema.parse(raw);
    if (containsCredentialLikeData(input.goal ?? "")) throw new BridgeError("Working-set goal cannot contain credentials.", 400);
    return this.transaction(() => {
      const current = this.getWorkingSet(projectId);
      if (current.revision !== input.expectedRevision) throw new BridgeError("Working set changed. Refresh before editing.", 409);
      const next = WorkingSetSchema.parse({ ...current, pins: input.pins, goal: input.goal, revision: current.revision + 1, updatedAt: this.time() });
      this.db().prepare("INSERT INTO working_sets VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body").run(projectId, JSON.stringify(next)); return next;
    });
  }
  private authorizeEpisode(episode: ProjectEpisode, purpose: Purpose): boolean {
    if (episode.outcomeAuthority === "unverified_summary" && !episode.dependenciesComplete) return false;
    return episode.references.every(reference => this.options.authorizeReference(reference, { projectId: episode.projectId, purpose }));
  }
  listEpisodes(projectId: string, purpose: Purpose, query = "", limit = 20): ProjectEpisode[] {
    ContextId.parse(projectId); z.number().int().min(1).max(100).parse(limit); z.string().max(1000).parse(query);
    const terms = queryTerms(query);
    const rows = terms.length ? this.db().prepare(`SELECT e.body FROM episode_search f JOIN episodes e ON e.id=f.episode_id
      WHERE episode_search MATCH ? AND e.project_id=? ORDER BY bm25(episode_search),e.sequence DESC LIMIT 200`)
      .all(terms.map(term => `"${term}"`).join(" OR "), projectId) : this.db().prepare("SELECT body FROM episodes WHERE project_id=? ORDER BY sequence DESC LIMIT 200").all(projectId);
    return rows.map(row => ProjectEpisodeSchema.parse(JSON.parse(String(row.body)))).filter(episode => this.authorizeEpisode(episode, purpose)).slice(0, limit);
  }
  checkpoint(projectId: string, purpose: Purpose, query = "") {
    const working = this.getWorkingSet(projectId);
    const recent = this.listEpisodes(projectId, purpose, "", 8), relevant = query ? this.listEpisodes(projectId, purpose, query, 12) : [];
    const episodes = [...new Map([...relevant, ...recent].map(episode => [episode.id, episode])).values()].slice(0, 16);
    const id = `checkpoint-${hash([projectId, working.revision, episodes.map(episode => episode.id)]).slice(0, 48)}`;
    const revision = Math.max(1, working.revision, ...episodes.map(episode => episode.sequence));
    this.db().prepare("INSERT OR IGNORE INTO checkpoints VALUES (?,?,?,?,?)").run(id, projectId, revision, JSON.stringify(episodes.map(episode => episode.id)), working.revision);
    const lines = episodes.map(episode => `Observed ${episode.occurredAt}: task ${episode.taskId} ${episode.status}. Goal: ${episode.goal}${episode.outcomeAuthority === "unverified_summary" ? `\nUnverified historical summary: ${episode.observedOutcome ?? ""}` : ""}`);
    return { version: 1 as const, id, revision, projectId, episodes, workingSet: working,
      text: [working.goal ? `Current project goal: ${working.goal}` : "", ...lines].filter(Boolean).join("\n\n").slice(0, 28_000),
      authority: "historical_reference_not_execution" as const };
  }
  authorizeCheckpoint(id: string, revision: number, projectId: string, purpose: Purpose): boolean {
    const row = this.db().prepare("SELECT episode_ids,working_revision FROM checkpoints WHERE id=? AND revision=? AND project_id=?").get(id, revision, projectId);
    if (!row || Number(row.working_revision) !== this.getWorkingSet(projectId).revision) return false;
    return (JSON.parse(String(row.episode_ids)) as string[]).every(episodeId => {
      const row = this.db().prepare("SELECT body FROM episodes WHERE id=? AND project_id=?").get(episodeId, projectId);
      return !!row && this.authorizeEpisode(ProjectEpisodeSchema.parse(JSON.parse(String(row.body))), purpose);
    });
  }
  recordContextUse(raw: ContextPacket): UsageManifest {
    const packet = ContextPacketSchema.parse(raw), id = `usage-${packet.id}`;
    const value = UsageManifestSchema.parse({ version: 1, id, packetId: packet.id, ...packet.scope, createdAt: this.time(),
      usageAuthority: "supplied_context_not_claim_attribution", selections: packet.selections.map(selection => ({
        kind: selection.kind, id: selection.id, revision: selection.revision, originalSha256: selection.originalSha256, reasons: selection.reasons, citations: selection.citations,
      })) });
    this.db().prepare("INSERT OR IGNORE INTO manifests VALUES (?,?,?,?)").run(id, value.projectId, value.taskId, JSON.stringify(value));
    return UsageManifestSchema.parse(JSON.parse(String(this.db().prepare("SELECT body FROM manifests WHERE id=?").get(id)!.body)));
  }
  manifestsForTask(taskId: string, projectId: string) {
    ContextId.parse(taskId); ContextId.parse(projectId);
    return { version: 1 as const, manifests: this.db().prepare("SELECT body FROM manifests WHERE project_id=? AND task_id=? ORDER BY rowid DESC LIMIT 32").all(projectId, taskId)
      .map(row => UsageManifestSchema.parse(JSON.parse(String(row.body)))) };
  }
  readManifest(id: string, projectId: string, purpose: Purpose) {
    ContextId.parse(id); ContextId.parse(projectId);
    const row = this.db().prepare("SELECT body FROM manifests WHERE id=? AND project_id=?").get(id, projectId);
    if (!row) throw new BridgeError("Context manifest not found in this project.", 404);
    const manifest = UsageManifestSchema.parse(JSON.parse(String(row.body)));
    return { ...manifest, selections: manifest.selections.map(selection => {
      let available = false;
      if (selection.kind === "checkpoint") available = this.authorizeCheckpoint(selection.id, selection.revision, projectId, purpose);
      else if (selection.kind === "source") available = selection.citations.length > 0 && selection.citations.every(citation => this.options.authorizeReference({ kind: "source", id: citation.passageId,
        revision: selection.revision, sourceVersionId: citation.sourceVersionId, originalSha256: selection.originalSha256 }, { projectId, purpose }));
      else if (selection.kind === "memory") available = this.options.authorizeReference({ kind: "memory", id: selection.id, revision: selection.revision }, { projectId, purpose });
      else if (manifest.conversationId) available = this.options.authorizeReference({ kind: "history", id: selection.id, revision: selection.revision, conversationId: manifest.conversationId }, { projectId, purpose });
      return { ...selection, available };
    }) };
  }
  async route(method: string, url: URL, body: unknown, context: { nativeAuthenticated: boolean }) {
    if (!url.pathname.startsWith("/v1/continuity/")) return null;
    if (!context.nativeAuthenticated) throw new BridgeError("Project continuity controls require native authentication.", 403);
    const projectId = ContextId.parse(url.searchParams.get("projectId")), reply = (body: unknown) => ({ status: 200, body });
    if (url.pathname === "/v1/continuity/working-set") {
      if (method === "GET") return reply(this.getWorkingSet(projectId));
      if (method === "PUT") return reply(this.updateWorkingSet(projectId, body));
    }
    if (method === "GET" && url.pathname === "/v1/continuity/episodes") return reply({ version: 1, episodes: this.listEpisodes(projectId, "local", url.searchParams.get("query") ?? "") });
    if (method === "GET" && url.pathname === "/v1/continuity/checkpoint") return reply(this.checkpoint(projectId, "local"));
    if (method === "GET" && url.pathname === "/v1/continuity/manifests") return reply(this.manifestsForTask(ContextId.parse(url.searchParams.get("taskId")), projectId));
    const match = /^\/v1\/continuity\/manifests\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && match) return reply(this.readManifest(match[1], projectId, "local"));
    throw new BridgeError("Continuity route not found.", 404);
  }
  close() { this.connection?.close(); this.connection = undefined; }
}
