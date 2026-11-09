import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { AssistantSnapshotSchema, type AssistantSnapshot } from "./contracts.ts";

const MAX_BYTES = 24 * 1024 * 1024;

/** Separate persistence for UI coordination, never a second execution ledger. */
export class AssistantStore {
  private database: DatabaseSync | undefined;
  private readonly dataDirectory: string;
  constructor(dataDirectory: string) { this.dataDirectory = dataDirectory; }
  async open(): Promise<AssistantSnapshot> {
    const directory = join(this.dataDirectory, "assistant");
    await ensurePrivateDirectory(directory);
    const file = join(directory, "assistant.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        const info = await lstat(file + suffix);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe assistant database file");
        await chmod(file + suffix, 0o600);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(file);
    this.database = db;
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported assistant database version");
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned assistant database is not empty");
        db.exec("CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA user_version=1;");
        db.prepare("INSERT INTO snapshot VALUES (1, ?)").run(JSON.stringify({ version: 1, sequence: 0, sessions: [], turns: [], presentations: [], proposals: [], events: [] }));
      }
      const body = db.prepare("SELECT body FROM snapshot WHERE id=1").get()?.body;
      if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BYTES) throw new Error("Invalid assistant snapshot");
      const result = AssistantSnapshotSchema.parse(JSON.parse(body));
      if (version === 1) {
        // Keep a transactionally consistent, private pre-migration snapshot.
        db.exec("CREATE TABLE IF NOT EXISTS migration_backups (version INTEGER PRIMARY KEY, body TEXT NOT NULL)");
        db.prepare("INSERT OR IGNORE INTO migration_backups VALUES (1, ?)").run(body);
      }
      if (version !== 2) {
        db.prepare("UPDATE snapshot SET body=? WHERE id=1").run(JSON.stringify(result));
        db.exec("PRAGMA user_version=2");
      }
      db.exec("COMMIT");
      return result;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} this.close(); throw error; }
  }
  save(value: AssistantSnapshot): void {
    const db = this.database;
    if (!db) throw new Error("Assistant store is closed");
    const body = JSON.stringify(AssistantSnapshotSchema.parse(value));
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Assistant history storage limit exceeded");
    try {
      db.exec("BEGIN EXCLUSIVE");
      db.prepare("UPDATE snapshot SET body=? WHERE id=1").run(body);
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
