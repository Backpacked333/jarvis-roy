import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { boundedDatabase, type Database } from "./model.ts";

export interface KernelStore {
  open(initial: Database): Promise<Database>;
  save(value: Database): void;
  close(): void;
}

const MAX_BYTES = 32 * 1_024 * 1_024;

/** A lifetime SQLite exclusive lock also fences competing kernel processes. */
export class SqliteKernelStore implements KernelStore {
  private connection: DatabaseSync | null = null;
  private readonly directory: string;

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "harness-kernel");
  }

  async open(initial: Database): Promise<Database> {
    await ensurePrivateDirectory(this.directory);
    const file = path.join(this.directory, "kernel.sqlite");
    try {
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        const info = await lstat(file + suffix);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe harness database file");
        await chmod(file + suffix, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const connection = new DatabaseSync(file);
    this.connection = connection;
    try {
      connection.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
      const version = connection.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported harness database version; upgrade or restore a compatible backup");
      if (version === 0) {
        if (connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned harness database is not empty");
        connection.exec("CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA user_version=1;");
        connection.prepare("INSERT INTO snapshot VALUES (1, ?)").run(this.encode(initial));
      }
      const body = connection.prepare("SELECT body FROM snapshot WHERE id=1").get()?.body;
      if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BYTES) throw new Error("Invalid harness snapshot");
      const value = boundedDatabase(JSON.parse(body));
      connection.exec("COMMIT");
      return value;
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch { /* There may not be an open transaction. */ }
      this.close();
      throw error;
    }
  }

  save(value: Database): void {
    if (!this.connection) throw new Error("Harness store is closed");
    const body = this.encode(value);
    try {
      this.connection.exec("BEGIN EXCLUSIVE");
      this.connection.prepare("UPDATE snapshot SET body=? WHERE id=1").run(body);
      this.connection.exec("COMMIT");
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch { /* A failed commit is never published to memory. */ }
      throw error;
    }
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
  }

  private encode(value: Database): string {
    boundedDatabase(value);
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Harness history exceeds the bounded database size");
    return body;
  }
}
