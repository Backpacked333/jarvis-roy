import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { ObjectiveSnapshotSchema, type ObjectiveSnapshot } from "./contracts.ts";

export interface ObjectivePersistence {
  open(dataDirectory: string): Promise<ObjectiveSnapshot>;
  save(snapshot: ObjectiveSnapshot): void;
  close(): void;
}
/** Single-writer durable store. No existing schema is rewritten: future version
 * migrations must first create a verified private SQLite backup. */
export class ObjectiveStore implements ObjectivePersistence {
  private database?: DatabaseSync;
  async open(dataDirectory: string): Promise<ObjectiveSnapshot> {
    const directory = join(dataDirectory, "objectives"); await ensurePrivateDirectory(directory);
    const file = join(directory, "objectives.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe objective database file"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = this.database = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported objective database version; a backed-up migration is required");
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned objective database is not empty");
        db.exec("CREATE TABLE snapshot(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL); PRAGMA user_version=1;");
        db.prepare("INSERT INTO snapshot VALUES (1,?)").run(JSON.stringify({ version: 1, sequence: 0, objectives: [], events: [], requests: [], inbox: [], reservations: [] }));
      }
      const body = db.prepare("SELECT body FROM snapshot WHERE id=1").get()?.body;
      if (typeof body !== "string" || Buffer.byteLength(body) > 16_777_216) throw new Error("Invalid objective snapshot");
      const value = ObjectiveSnapshotSchema.parse(JSON.parse(body)); db.exec("COMMIT"); return value;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} this.close(); throw error; }
  }
  save(snapshot: ObjectiveSnapshot): void {
    if (!this.database) throw new Error("Objective store closed");
    const body = JSON.stringify(ObjectiveSnapshotSchema.parse(snapshot));
    if (Buffer.byteLength(body) > 16_777_216) throw new Error("Objective history limit exceeded");
    this.database.exec("BEGIN EXCLUSIVE");
    try { this.database.prepare("UPDATE snapshot SET body=? WHERE id=1").run(body); this.database.exec("COMMIT"); }
    catch (error) { try { this.database.exec("ROLLBACK"); } catch {} throw error; }
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
