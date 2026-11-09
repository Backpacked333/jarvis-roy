import { createPublicKey, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ensurePrivateDirectory } from "../agent/lib/persistence.ts";
import { actionDigest } from "./assistant/coordinator.ts";
import type { AssistantAdapters } from "./assistant/coordinator.ts";
import { ActionRefSchema } from "./assistant/contracts.ts";
import { cloudCommandDigest } from "./cloud/control.ts";
import { CloudCommandSchema, CloudId } from "./cloud/contracts.ts";
import { canonicalJson } from "./harness-contracts/validation.ts";
import { BridgeError } from "./errors.ts";

const PairSchema = z.strictObject({ version: z.literal(1), profileId: CloudId, origin: z.url().max(2048), deviceId: CloudId,
  generation: z.number().int().positive(), serverEpoch: z.number().int().positive(), receiptPublicKey: z.string().max(2048) });
type Pair = z.infer<typeof PairSchema>;
type Result = { version: 1; status: "completed" | "failed" | "unknown"; code: "ok" | "rejected" | "stale" | "unavailable" | "interrupted" | "unknown" };
const ResultSchema = z.strictObject({ version: z.literal(1), status: z.enum(["completed", "failed", "unknown"]),
  code: z.enum(["ok", "rejected", "stale", "unavailable", "interrupted", "unknown"]) });
const ClaimSchema = z.strictObject({ profileId: CloudId, deviceId: CloudId, generation: z.number().int().positive(),
  serverEpoch: z.number().int().positive(), projectId: CloudId, actionRef: ActionRefSchema, room: z.boolean(),
  handoffComplete: z.boolean() });
type Claim = z.infer<typeof ClaimSchema>;
const uncertain: Result = { version: 1, status: "unknown", code: "unknown" };
export interface NativeCloudOptions {
  dataDirectory: string; enabled: boolean;
  authority: Required<Pick<AssistantAdapters, "readAction" | "executeAction">>;
  projectForAction(taskId: string, room: boolean): Promise<string | null>;
  /** Observe this exact effect's durable result. Task completion alone is insufficient. */
  observeAction?(taskId: string, room: boolean, optionId: string, reference: z.infer<typeof ActionRefSchema>): Promise<"completed" | "failed" | "unknown">;
  now?: () => number;
}

/** Trusted native bootstrap pins a paired key. Commands remain subject to the
 * current local approval card and the single existing execution authority. */
export class NativeCloudRuntime {
  private db?: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: NativeCloudOptions;
  private constructor(options: NativeCloudOptions) { this.options = options; }
  static async open(options: NativeCloudOptions) {
    const runtime = new NativeCloudRuntime(options);
    if (!options.enabled) return runtime;
    const directory = join(options.dataDirectory, "native-cloud"); await ensurePrivateDirectory(directory);
    const file = join(directory, "receipts.sqlite");
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { const info = await lstat(file + suffix); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe native receipt store"); await chmod(file + suffix, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(file); runtime.db = db;
    try {
      db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported native receipt store");
      if (version === 1) {
        const backup = join(directory, `receipts-v1-${randomUUID()}.backup.sqlite`);
        db.prepare("VACUUM INTO ?").run(backup); await chmod(backup, 0o600);
        const handle = await open(backup, "r"); try { await handle.sync(); } finally { await handle.close(); }
      }
      db.exec("BEGIN EXCLUSIVE");
      if (version === 0) db.exec("CREATE TABLE profiles(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE commands(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL,claim TEXT); PRAGMA user_version=2");
      // Older unknown records have no exact observation binding and remain unknown.
      if (version === 1) db.exec("ALTER TABLE commands ADD COLUMN claim TEXT; PRAGMA user_version=2");
      db.exec("COMMIT"); return runtime;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} db.close(); throw error; }
  }
  private store() { if (!this.options.enabled || !this.db) throw new BridgeError("Cloud pairing is disabled.", 503); return this.db; }
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  async pair(raw: unknown): Promise<{ version: 1; paired: true }> {
    const pair = PairSchema.parse(raw), origin = new URL(pair.origin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.origin !== pair.origin) throw new BridgeError("Pairing requires a credential-free HTTPS origin.", 400);
    if (createPublicKey(pair.receiptPublicKey).asymmetricKeyType !== "ed25519") throw new BridgeError("Unsupported receipt signing key.", 400);
    return this.serial(async () => {
      const db = this.store(), previous = db.prepare("SELECT body FROM profiles WHERE id=?").get(pair.profileId);
      if (previous) {
        const prior = PairSchema.parse(JSON.parse(String(previous.body)));
        if (pair.origin !== prior.origin || pair.deviceId !== prior.deviceId || pair.receiptPublicKey !== prior.receiptPublicKey ||
            pair.generation < prior.generation || pair.serverEpoch < prior.serverEpoch) throw new BridgeError("Pairing identity changed; use a new reviewed profile.", 409);
      }
      db.prepare("INSERT INTO profiles VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(pair.profileId, JSON.stringify(pair));
      return { version: 1, paired: true };
    });
  }
  async execute(raw: unknown): Promise<Result> {
    const input = z.strictObject({ version: z.literal(1), profileId: CloudId, command: CloudCommandSchema }).parse(raw);
    return this.serial(async () => {
      const db = this.store(), command = input.command;
      const profileRow = db.prepare("SELECT body FROM profiles WHERE id=?").get(input.profileId);
      if (!profileRow) throw new BridgeError("Device pairing is unavailable.", 403);
      const profile: Pair = PairSchema.parse(JSON.parse(String(profileRow.body))), now = this.options.now?.() ?? Date.now();
      const reject = (code: Result["code"] = "rejected"): Result => ({ version: 1, status: "failed", code });
      if (command.digest !== cloudCommandDigest(command) || command.deviceId !== profile.deviceId || command.generation !== profile.generation || command.serverEpoch !== profile.serverEpoch ||
          Date.parse(command.expiresAt) <= now || Date.parse(command.createdAt) > now + 5000 || Date.parse(command.createdAt) >= Date.parse(command.expiresAt) || !["sent", "queued"].includes(command.status)) return reject("stale");
      // Cancellation/snapshot import use their own scoped protocols, never an action approval.
      if (command.payload.kind !== "action.execute") return reject("unavailable");
      const { action, receipt, proposalId } = command.payload;
      const { signature, ...unsigned } = receipt;
      const digest = actionDigest(action);
      if (receipt.proposalId !== proposalId || receipt.deviceId !== profile.deviceId || receipt.deviceGeneration !== profile.generation || receipt.serverEpoch !== profile.serverEpoch ||
          receipt.actionDigest !== digest || Date.parse(receipt.expiresAt) <= now || Date.parse(receipt.issuedAt) > now + 5000 ||
          Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt) || Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt) > 120000 ||
          canonicalJson(receipt.actionRef) !== canonicalJson({ taskId: action.taskId, interactionId: action.interactionId, revision: action.revision, optionId: action.optionId }) ||
          !verify(null, Buffer.from(canonicalJson(unsigned)), profile.receiptPublicKey, Buffer.from(signature, "base64url"))) return reject();
      if (await this.options.projectForAction(action.taskId, action.scope === "room") !== receipt.projectId) return reject();
      const prior = db.prepare("SELECT digest,body FROM commands WHERE id=?").get(command.id);
      if (prior) return prior.digest === command.digest ? ResultSchema.parse(JSON.parse(String(prior.body))) : reject();
      if (db.prepare("SELECT id FROM commands WHERE receipt_id=?").get(receipt.id)) return reject();
      if (Number(db.prepare("SELECT count(*) AS count FROM commands").get()?.count) >= 2000) return reject("unavailable");
      const current = await this.options.authority.readAction(action);
      if (!current || actionDigest(current) !== digest) return reject("stale");
      const claim: Claim = { profileId: input.profileId, deviceId: command.deviceId, generation: command.generation,
        serverEpoch: command.serverEpoch, projectId: receipt.projectId, actionRef: receipt.actionRef, room: action.scope === "room", handoffComplete: false };
      // A crash after this durable claim is deliberately unknown and cannot replay.
      db.prepare("INSERT INTO commands(id,digest,receipt_id,body,claim) VALUES (?,?,?,?,?)").run(command.id, command.digest, receipt.id, JSON.stringify(uncertain), JSON.stringify(claim));
      try {
        await this.options.authority.executeAction(current);
        claim.handoffComplete = true;
        db.prepare("UPDATE commands SET claim=? WHERE id=?").run(JSON.stringify(claim), command.id);
        return await this.observe(command.id, claim);
      } catch { return uncertain; }
    });
  }
  /** Reconcile an earlier command without checking expiry or executing anything. */
  async result(raw: unknown): Promise<Result> {
    const input = z.strictObject({ version: z.literal(1), profileId: CloudId, commandId: CloudId,
      commandDigest: z.string().regex(/^[a-f0-9]{64}$/), originalGeneration: z.number().int().positive(), originalServerEpoch: z.number().int().positive() }).parse(raw);
    return this.serial(async () => {
      const db = this.store(), pair = db.prepare("SELECT body FROM profiles WHERE id=?").get(input.profileId);
      if (!pair) throw new BridgeError("Device pairing is unavailable.", 403);
      const profile = PairSchema.parse(JSON.parse(String(pair.body)));
      const row = db.prepare("SELECT digest,body,claim FROM commands WHERE id=?").get(input.commandId);
      if (!row) return uncertain;
      if (row.digest !== input.commandDigest) throw new BridgeError("Command identity does not match its durable receipt.", 409);
      if (!row.claim) return uncertain;
      const claim = ClaimSchema.parse(JSON.parse(String(row.claim)));
      if (claim.profileId !== input.profileId || claim.deviceId !== profile.deviceId || claim.generation !== input.originalGeneration ||
          claim.serverEpoch !== input.originalServerEpoch || claim.generation > profile.generation || claim.serverEpoch > profile.serverEpoch) throw new BridgeError("Command binding does not match the paired device.", 409);
      const current = ResultSchema.parse(JSON.parse(String(row.body)));
      if (current.status !== "unknown" || !claim.handoffComplete) return current;
      return this.observe(input.commandId, claim);
    });
  }
  private async observe(commandId: string, claim: Claim): Promise<Result> {
    try {
      if (!claim.handoffComplete || await this.options.projectForAction(claim.actionRef.taskId, claim.room) !== claim.projectId) return uncertain;
      const observed = await this.options.observeAction?.(claim.actionRef.taskId, claim.room, claim.actionRef.optionId, claim.actionRef) ?? "unknown";
      const result = ResultSchema.parse({ version: 1, status: observed, code: observed === "completed" ? "ok" : observed === "failed" ? "rejected" : "unknown" });
      this.store().prepare("UPDATE commands SET body=? WHERE id=?").run(JSON.stringify(result), commandId);
      return result;
    } catch { return uncertain; }
  }
  async close() { await this.queue; this.db?.close(); this.db = undefined; }
}
