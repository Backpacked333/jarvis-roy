import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { ResearchRecordSchema, type ResearchRecord } from "./contracts.ts";

export class ResearchStore {
  private database?: DatabaseSync;
  async open(dataDirectory: string): Promise<ResearchRecord[]> {
    const directory = join(dataDirectory, "research"); await ensurePrivateDirectory(directory);
    const file = join(directory, "research.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe research database file"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(file); this.database = db;
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported research database version");
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned research database is not empty");
        db.exec("CREATE TABLE runs(id TEXT PRIMARY KEY, body TEXT NOT NULL); PRAGMA user_version=1;");
      }
      const rows = db.prepare("SELECT body FROM runs LIMIT 501").all();
      if (rows.length > 500) throw new Error("Research history limit exceeded");
      const records = rows.map(row => {
        if (typeof row.body !== "string" || Buffer.byteLength(row.body) > 512_000) throw new Error("Invalid research record");
        return ResearchRecordSchema.parse(JSON.parse(row.body));
      });
      db.exec("COMMIT"); return records;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} this.close(); throw error; }
  }
  save(record: ResearchRecord): void {
    if (!this.database) throw new Error("Research store closed");
    const body = JSON.stringify(ResearchRecordSchema.parse(record));
    if (Buffer.byteLength(body) > 512_000) throw new Error("Research record limit exceeded");
    this.database.prepare("INSERT INTO runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(record.run.id, body);
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
