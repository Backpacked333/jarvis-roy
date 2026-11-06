import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ArtifactManifestSchema, ArtifactRefSchema, RelativePathSchema,
  type ArtifactManifest, type ArtifactRef, type RoomPolicy,
} from "../harness-contracts/domain.ts";
import { artifactDigest, canonicalJson, sha256, validateArtifact } from "../harness-contracts/validation.ts";
import type { ArtifactReader, WorkerSpec } from "../harness-contracts/worker.ts";

export class PrivateStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Worker store must be a private real directory");
  }
  path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid private store key");
    return join(this.directory, key);
  }
  async read(key: string, limit = 2_000_000): Promise<Buffer> {
    const handle = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error("Unsafe or oversized stored file");
      const buffer = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const result = await handle.read(buffer, count, buffer.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      const after = await handle.stat();
      if (count !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("Stored file changed during read");
      return buffer.subarray(0, count);
    } finally { await handle.close(); }
  }
  async json(key: string): Promise<any | null> {
    try { return JSON.parse((await this.read(key)).toString("utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async write(key: string, bytes: Buffer, immutable = false): Promise<void> {
    await this.initialize();
    const path = this.path(key);
    if (immutable) {
      try {
        const handle = await open(path, "wx", 0o400);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await this.read(key, bytes.length)).equals(bytes)) throw new Error("Immutable store collision");
      }
    } else {
      const temp = `${path}.${randomUUID()}`;
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(bytes); await handle.sync(); await handle.close();
        await rename(temp, path);
      } catch (error) { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); throw error; }
    }
    const directory = await open(this.directory, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async put(key: string, value: unknown, immutable = false): Promise<void> {
    await this.write(key, Buffer.from(canonicalJson(value)), immutable);
  }
}

export const SnapshotSchema = z.array(z.strictObject({
  path: RelativePathSchema,
  data: z.string().max(90_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0, "Invalid base64 length"),
})).max(256);
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type CheckEvidence = { command: string; exitCode: number; outputDigest: string };

function artifactKey(ref: Pick<ArtifactRef, "roomId" | "runId" | "artifactId">): string {
  return sha256(canonicalJson([ref.roomId, ref.runId, ref.artifactId]));
}

export class Artifacts implements ArtifactReader {
  readonly manifests: PrivateStore;
  readonly blobs: PrivateStore;
  constructor(directory: string) {
    this.manifests = new PrivateStore(join(directory, "manifests"));
    this.blobs = new PrivateStore(join(directory, "blobs"));
  }
  async seal(spec: WorkerSpec, input: unknown, checks: CheckEvidence[]): Promise<ArtifactManifest[]> {
    const files = SnapshotSchema.parse(input);
    if (!files.length) return [];
    if (new Set(files.map(f => f.path)).size !== files.length) throw new Error("Duplicate snapshot paths");
    const data = files.map(file => ({ path: file.path, bytes: Buffer.from(file.data, "base64") }));
    if (data.reduce((sum, file) => sum + file.bytes.length, 0) > spec.policy.sandbox.maxArtifactBytes || files.length > spec.policy.sandbox.maxArtifactFiles) {
      throw new Error("Artifact volume exceeded");
    }
    const manifest: ArtifactManifest = {
      version: 1, id: `artifact_${sha256(canonicalJson(spec.ref)).slice(0, 40)}`, ...spec.ref,
      planDigest: spec.planDigest, digest: "0".repeat(64), createdAt: new Date().toISOString(),
      files: data.map(file => ({ path: file.path, sha256: sha256(file.bytes), bytes: file.bytes.length,
        mediaType: /\.(txt|md|py|js|ts|css|html|json|csv|log)$/.test(file.path) ? "text/plain" : "application/octet-stream" })),
      inputDigests: [...new Set([...spec.inputs, ...(spec.checkpoint?.artifacts ?? [])].map(m => m.digest))],
      verification: checks.length ? (checks.every(check => check.exitCode === 0) ? "passed" : "failed") : "unverified",
      verificationSummary: checks.length ? checks.map(check => `exit=${check.exitCode}; output-sha256=${check.outputDigest}; command=${check.command}`).join("\n").slice(0, 2000)
        : "No verification command ran. Model claims are not verification.",
    };
    manifest.digest = artifactDigest(manifest);
    validateArtifact(manifest, spec.policy);
    for (const file of data) await this.blobs.write(sha256(file.bytes), file.bytes, true);
    await this.manifests.put(artifactKey({ ...spec.ref, artifactId: manifest.id }), manifest, true);
    return [manifest];
  }
  async read(ref: ArtifactRef, path: string, maxBytes: number): Promise<{ manifest: ArtifactManifest; bytes: Uint8Array }> {
    ArtifactRefSchema.parse(ref); RelativePathSchema.parse(path);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1_048_576) throw new Error("Invalid artifact read bound");
    const manifest = ArtifactManifestSchema.parse(await this.manifests.json(artifactKey(ref)));
    if (manifest.roomId !== ref.roomId || manifest.runId !== ref.runId || manifest.id !== ref.artifactId ||
        manifest.digest !== ref.digest || artifactDigest(manifest) !== ref.digest) throw new Error("Artifact scope/digest mismatch");
    const file = manifest.files.find(file => file.path === path);
    if (!file || file.bytes > maxBytes) throw new Error("Artifact path absent or read bound exceeded");
    const bytes = await this.blobs.read(file.sha256, Math.min(maxBytes, file.bytes));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("Artifact content digest mismatch");
    return { manifest, bytes };
  }
  async restore(manifests: ArtifactManifest[], policy: RoomPolicy): Promise<Snapshot> {
    const files: Snapshot = [];
    let total = 0;
    const paths = new Set<string>();
    for (const value of manifests) {
      const manifest = validateArtifact(value, policy);
      for (const file of manifest.files) {
        if (paths.has(file.path)) throw new Error("Conflicting input artifact paths");
        paths.add(file.path);
        total += file.bytes;
        if (total > policy.sandbox.maxArtifactBytes || paths.size > policy.sandbox.maxArtifactFiles) throw new Error("Combined artifact import exceeds policy");
        const { bytes } = await this.read({ roomId: manifest.roomId, runId: manifest.runId, artifactId: manifest.id, digest: manifest.digest }, file.path, file.bytes);
        files.push({ path: file.path, data: Buffer.from(bytes).toString("base64") });
      }
    }
    return files;
  }
}
