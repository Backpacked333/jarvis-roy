import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";

export class IntegrationStore {
  private connection?: DatabaseSync;
  private failed = false;
  private readonly key: Buffer;
  constructor(encryptionKey: Uint8Array) {
    if (encryptionKey.byteLength !== 32) throw new Error("Integration encryption key must contain 32 bytes");
    this.key = Buffer.from(encryptionKey);
  }
  async open(dataDirectory: string): Promise<void> {
    const directory = join(dataDirectory, "integrations"); await ensurePrivateDirectory(directory);
    const file = join(directory, "integrations.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe integration database"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.connection = new DatabaseSync(file);
    try {
      this.db().exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; BEGIN EXCLUSIVE;");
      const version = this.db().prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported integrations schema");
      if (version === 0) {
        if (this.db().prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned integration store is not empty");
        this.db().exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;");
      }
      this.db().exec("COMMIT");
      this.transaction(() => {
        for (const kind of ["attempt", "inbox", "outbox", "call"]) for (const row of this.list<Record<string, unknown>>(kind)) {
          if (["sending", "dispatching", "initiating"].includes(String(row.status)) || kind === "call" && ["ringing", "in_progress"].includes(String(row.status))) {
            this.put(kind, String(row.id), { ...row, status: "unknown", ...(kind === "call" ? { verifiedUntil: null, verification: null } : {}) });
          }
        }
      });
    } catch (error) { try { this.db().exec("ROLLBACK"); } catch {} this.close(); throw error; }
  }
  private db(): DatabaseSync { if (!this.connection) throw new Error("Integration store closed"); return this.connection; }
  assertWritable(): void { if (this.failed) throw new Error("Integration persistence failed; restart and inspect durable state"); this.db(); }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db().prepare("SELECT body FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  list<T>(kind: string): T[] {
    const rows = this.db().prepare("SELECT body FROM records WHERE kind=? ORDER BY id LIMIT 10001").all(kind);
    if (rows.length > 10000) throw new Error("Integration history limit exceeded");
    return rows.map(row => JSON.parse(String(row.body)) as T);
  }
  put(kind: string, id: string, value: unknown): void {
    this.assertWritable(); const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 1_048_576) throw new Error("Integration record too large");
    try { this.db().prepare("INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").run(kind, id, body); }
    catch (error) { this.failed = true; throw error; }
  }
  remove(kind: string, id: string): void { this.assertWritable(); try { this.db().prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id); } catch (error) { this.failed = true; throw error; } }
  transaction<T>(operation: () => T): T {
    this.assertWritable(); this.db().exec("BEGIN EXCLUSIVE");
    try { const result = operation(); this.db().exec("COMMIT"); return result; }
    catch (error) { try { this.db().exec("ROLLBACK"); } catch {} this.failed = true; throw error; }
  }
  seal(kind: string, id: string, value: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }
  unseal<T>(kind: string, id: string, encrypted: string): T {
    const bytes = Buffer.from(encrypted, "base64");
    if (bytes.length < 29 || bytes.toString("base64") !== encrypted) throw new Error("Invalid encrypted integration credential");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${kind}:${id}`)); decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as T;
  }
  close(): void { this.connection?.close(); this.connection = undefined; }
}
