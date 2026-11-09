import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { MemoryEntrySchema, type MemoryEntry } from "./contracts.ts";

/** No in-memory authority: callers can observe only a committed SQLite row. */
export class MemoryStore {
  private connection?: DatabaseSync;
  async open(dataDirectory: string): Promise<void> {
    const directory = join(dataDirectory, "memory"); await ensurePrivateDirectory(directory);
    const file = join(directory, "memory.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe memory database file"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(file); this.connection = db;
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported memory database version; use a compatible migration and backup");
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned memory database is not empty");
        db.exec(`BEGIN EXCLUSIVE;
          CREATE TABLE entries (id TEXT PRIMARY KEY, body TEXT NOT NULL);
          CREATE VIRTUAL TABLE memory_search USING fts5(entry_id UNINDEXED, text);
          INSERT INTO memory_search(memory_search,rank) VALUES('secure-delete',1);
          CREATE TABLE legacy (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, fingerprint TEXT NOT NULL, detached INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE tombstones (legacy_id TEXT PRIMARY KEY);
          CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE TABLE memory_vectors (entry_id TEXT PRIMARY KEY, digest TEXT NOT NULL, provider_key TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL);
          PRAGMA user_version=2; COMMIT;`);
      } else if (version === 1) {
        this.all();
        const destination = join(directory, `schema-v1-${randomUUID()}.backup.sqlite`);
        const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close();
        db.prepare("VACUUM INTO ?").run(destination); await chmod(destination, 0o600);
        db.exec(`BEGIN EXCLUSIVE;
          CREATE TABLE memory_vectors (entry_id TEXT PRIMARY KEY, digest TEXT NOT NULL, provider_key TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL);
          PRAGMA user_version=2; COMMIT;`);
      }
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
      this.all();
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} this.close(); throw error; }
  }
  db(): DatabaseSync { if (!this.connection) throw new Error("Memory store is closed"); return this.connection; }
  transaction<T>(operation: () => T): T {
    const db = this.db(); db.exec("BEGIN EXCLUSIVE");
    try { const result = operation(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  all(): MemoryEntry[] {
    const rows = this.db().prepare("SELECT body FROM entries ORDER BY id LIMIT 5001").all();
    if (rows.length > 5000) throw new Error("Memory storage limit exceeded");
    return rows.map(row => {
      if (typeof row.body !== "string" || Buffer.byteLength(row.body) > 32000) throw new Error("Invalid memory record");
      return MemoryEntrySchema.parse(JSON.parse(row.body));
    });
  }
  get(id: string): MemoryEntry | undefined {
    const body = this.db().prepare("SELECT body FROM entries WHERE id=?").get(id)?.body;
    return typeof body === "string" ? MemoryEntrySchema.parse(JSON.parse(body)) : undefined;
  }
  save(entry: MemoryEntry): void {
    const value = MemoryEntrySchema.parse(entry), body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 32000) throw new Error("Memory record limit exceeded");
    if (!this.get(value.id) && Number(this.db().prepare("SELECT COUNT(*) AS count FROM entries").get()?.count) >= 5000) throw new Error("Memory storage limit exceeded");
    this.db().prepare("INSERT INTO entries VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(value.id, body);
    this.db().prepare("DELETE FROM memory_vectors WHERE entry_id=? AND digest!=?").run(value.id, value.digest);
    this.db().prepare("DELETE FROM memory_search WHERE entry_id=?").run(value.id);
    if (value.status === "active") this.db().prepare("INSERT INTO memory_search(entry_id,text) VALUES (?,?)").run(value.id, value.text);
  }
  remove(id: string): void {
    this.db().prepare("DELETE FROM memory_vectors WHERE entry_id=?").run(id);
    this.db().prepare("DELETE FROM memory_search WHERE entry_id=?").run(id);
    this.db().prepare("DELETE FROM entries WHERE id=?").run(id);
  }
  close(): void { this.connection?.close(); this.connection = undefined; }
}
