import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "../../agent/lib/persistence.ts";
import { boundedDatabase, type Database } from "./model.ts";
import { RoomArchiveSchema, RoomArchiveSummarySchema, type ArchivedRequest, type RoomArchive, type RoomArchiveSummary } from "./archive.ts";
import { canonicalJson, sha256 } from "../harness-contracts/validation.ts";

export interface KernelStore {
  open(initial: Database): Promise<Database>;
  save(value: Database): void;
  close(): void;
  saveArchive?(archive: RoomArchive, value: Database, entityIds: string[]): void;
  listArchives?(roomId?: string): RoomArchiveSummary[];
  readArchive?(archiveId: string, roomId: string): RoomArchive | null;
  archivedRequest?(key: string): ArchivedRequest | null;
  hasArchivedEntity?(id: string): boolean;
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
    await ensurePrivateDirectory(path.join(this.directory, "archives"));
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
      connection.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;");
      const version = connection.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported harness database version; upgrade or restore a compatible backup");
      if (version === 1) {
        const backup = path.join(this.directory, "kernel-v1.before-archives.sqlite");
        try {
          const info = await lstat(backup);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe kernel migration backup");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          connection.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
          await chmod(backup, 0o600);
        }
      }
      connection.exec("BEGIN EXCLUSIVE;");
      if (version === 0) {
        if (connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error("Unversioned harness database is not empty");
        connection.exec("CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA user_version=1;");
        connection.prepare("INSERT INTO snapshot VALUES (1, ?)").run(this.encode(initial));
      }
      if (version === 0 || version === 1) {
        connection.exec(`CREATE TABLE room_archives (id TEXT PRIMARY KEY,room_id TEXT NOT NULL,summary TEXT NOT NULL);
          CREATE INDEX room_archive_scope ON room_archives(room_id);
          CREATE TABLE archive_requests (key TEXT PRIMARY KEY,digest TEXT NOT NULL,entity_id TEXT NOT NULL,archive_id TEXT NOT NULL);
          CREATE TABLE archive_entities (id TEXT PRIMARY KEY,archive_id TEXT NOT NULL);
          PRAGMA user_version=2;`);
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

  saveArchive(raw: RoomArchive, value: Database, entityIds: string[]): void {
    if (!this.connection) throw new Error("Harness store is closed");
    const archive = RoomArchiveSchema.parse(raw), encoded = canonicalJson(archive);
    if (Buffer.byteLength(encoded) > MAX_BYTES || sha256(canonicalJson(archive.snapshot)) !== archive.summary.digest) throw new Error("Invalid archive snapshot digest or size");
    const body = this.encode(value);
    const directory = path.join(this.directory, "archives"), file = path.join(directory, `${archive.summary.id}.json`);
    // Immutable export reaches stable storage before any active state is pruned.
    const descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(descriptor, encoded); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const parent = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const connection = this.connection;
    try {
      connection.exec("BEGIN EXCLUSIVE");
      connection.prepare("INSERT INTO room_archives VALUES (?,?,?)").run(archive.summary.id, archive.summary.roomId, JSON.stringify(archive.summary));
      const request = connection.prepare("INSERT INTO archive_requests VALUES (?,?,?,?)");
      for (const entry of archive.snapshot.requests) request.run(entry.key, entry.digest, entry.entityId, archive.summary.id);
      const entity = connection.prepare("INSERT INTO archive_entities VALUES (?,?)");
      for (const id of new Set(entityIds)) entity.run(id, archive.summary.id);
      connection.prepare("UPDATE snapshot SET body=? WHERE id=1").run(body);
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch {}
      // A preserved orphan export is safe; live state and the dedup index did not change.
      throw error;
    }
  }

  listArchives(roomId?: string): RoomArchiveSummary[] {
    if (!this.connection) throw new Error("Harness store is closed");
    const rows = roomId === undefined ? this.connection.prepare("SELECT summary FROM room_archives ORDER BY rowid DESC LIMIT 1000").all()
      : this.connection.prepare("SELECT summary FROM room_archives WHERE room_id=? ORDER BY rowid DESC LIMIT 1000").all(roomId);
    return rows.map(row => RoomArchiveSummarySchema.parse(JSON.parse(String(row.summary))));
  }

  readArchive(archiveId: string, roomId: string): RoomArchive | null {
    if (!this.connection) throw new Error("Harness store is closed");
    const row = this.connection.prepare("SELECT summary FROM room_archives WHERE id=? AND room_id=?").get(archiveId, roomId);
    if (!row) return null;
    const summary = RoomArchiveSummarySchema.parse(JSON.parse(String(row.summary)));
    const file = path.join(this.directory, "archives", `${summary.id}.json`), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("Unsafe archive file");
    const archive = RoomArchiveSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (canonicalJson(archive.summary) !== canonicalJson(summary) || sha256(canonicalJson(archive.snapshot)) !== summary.digest ||
      archive.snapshot.state.rooms.length !== 1 || archive.snapshot.state.rooms[0].id !== roomId) throw new Error("Archive integrity or scope check failed");
    return archive;
  }

  archivedRequest(key: string): ArchivedRequest | null {
    if (!this.connection) throw new Error("Harness store is closed");
    const row = this.connection.prepare("SELECT key,digest,entity_id AS entityId,archive_id AS archiveId FROM archive_requests WHERE key=?").get(key);
    return row ? { key: String(row.key), digest: String(row.digest), entityId: String(row.entityId), archiveId: String(row.archiveId) } : null;
  }
  hasArchivedEntity(id: string): boolean {
    if (!this.connection) throw new Error("Harness store is closed");
    return Boolean(this.connection.prepare("SELECT 1 FROM archive_entities WHERE id=?").get(id));
  }

  private encode(value: Database): string {
    boundedDatabase(value);
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Harness history exceeds the bounded database size");
    return body;
  }
}
