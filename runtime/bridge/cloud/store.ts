import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { CloudStateSchema, type CloudState } from "./contracts.ts";

const checksum = (body: string) => createHash("sha256").update(body).digest("hex");
const MAX_STATE_BYTES = 24 * 1024 * 1024;
export class CloudStore {
  private connection?: DatabaseSync;
  async open(directory: string, initial: () => CloudState): Promise<CloudState> {
    const root = join(directory, "cloud"); await ensurePrivateDirectory(root);
    const file = join(root, "control.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { const stat = await lstat(file + suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe cloud database"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(file); this.connection = db;
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported cloud database version");
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned cloud database is not empty");
        const body = JSON.stringify(CloudStateSchema.parse(initial()));
        db.exec("BEGIN EXCLUSIVE; CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,checksum TEXT NOT NULL); PRAGMA user_version=2;");
        db.prepare("INSERT INTO state VALUES(1,?,?)").run(body, checksum(body)); db.exec("COMMIT");
      } else if (version === 1) {
        const body = db.prepare("SELECT body FROM state WHERE id=1").get()?.body;
        if (typeof body !== "string" || Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("Invalid cloud state");
        CloudStateSchema.parse(JSON.parse(body));
        const destination = join(root, `schema-v1-${randomUUID()}.backup.sqlite`);
        const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close();
        db.prepare("VACUUM INTO ?").run(destination); await chmod(destination, 0o600);
        db.exec("BEGIN EXCLUSIVE; ALTER TABLE state ADD COLUMN checksum TEXT NOT NULL DEFAULT ''; PRAGMA user_version=2;");
        db.prepare("UPDATE state SET checksum=? WHERE id=1").run(checksum(body)); db.exec("COMMIT");
      }
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
      const row = db.prepare("SELECT body,checksum FROM state WHERE id=1").get();
      if (typeof row?.body !== "string" || Buffer.byteLength(row.body) > MAX_STATE_BYTES || row.checksum !== checksum(row.body)) throw new Error("Invalid cloud state checksum");
      return CloudStateSchema.parse(JSON.parse(row.body));
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} this.close(); throw error; }
  }
  save(state: CloudState): void {
    if (!this.connection) throw new Error("Cloud store is closed");
    const body = JSON.stringify(CloudStateSchema.parse(state));
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("Cloud store size limit exceeded");
    this.connection.prepare("UPDATE state SET body=?,checksum=? WHERE id=1").run(body, checksum(body));
  }
  close(): void { this.connection?.close(); this.connection = undefined; }
}
