import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory } from "../persistence.ts";
import { cancelled, ConnectedServiceError } from "./errors.ts";

export interface ServiceExecutionContext {
  signal?: AbortSignal;
  // Supplied by eve, never by model input. Identical writes in a session are blocked.
  sessionId?: string;
}

export async function executeOnce<T>(directory: string, service: string, input: unknown, context: ServiceExecutionContext, execute: () => Promise<T>): Promise<T> {
  cancelled(context.signal);
  if (!context.sessionId) throw new ConnectedServiceError("missing_session", "A connected-service write requires an approved Jarvis session.");
  const ledger = path.join(directory, "connected-service-operations");
  const digest = createHash("sha256").update(JSON.stringify([service, input])).digest("hex");
  const sessionDigest = createHash("sha256").update(context.sessionId).update(digest).digest("hex");
  const pendingPath = path.join(ledger, `${digest}.pending`);
  const sessionPath = path.join(ledger, `${sessionDigest}.attempt`);
  try {
    await ensurePrivateDirectory(ledger);
    cancelled(context.signal);
    await reserve(pendingPath);
    try {
      await reserve(sessionPath);
    } catch (error) {
      await rm(pendingPath, { force: true });
      throw error;
    }
  } catch (error) {
    if (error instanceof ConnectedServiceError) throw error;
    throw new ConnectedServiceError("ledger_unavailable", "Cannot safely record this action in the private Jarvis data directory. Nothing was executed.");
  }
  if (context.signal?.aborted) {
    await rm(sessionPath, { force: true });
    await rm(pendingPath, { force: true });
    cancelled(context.signal);
  }
  let result: T;
  try {
    result = await execute();
  } catch (error) {
    // Only explicit pre-effect refusals can be safely tried after configuration is fixed.
    if (error instanceof ConnectedServiceError && !error.uncertain) {
      await rm(sessionPath, { force: true });
      await rm(pendingPath, { force: true });
    }
    throw error;
  }
  await rm(pendingPath, { force: true }).catch(() => {
    throw new ConnectedServiceError("ledger_uncertain", "The service accepted the action but its local receipt could not be finalized. Inspect the app; do not retry.", true);
  });
  return result;
}

async function reserve(file: string): Promise<void> {
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile("attempted\n", "utf8");
    await handle.sync();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new ConnectedServiceError("duplicate_action", "An identical action was already attempted in this session, or an earlier attempt has an uncertain outcome. Inspect the connected app. Jarvis will not retry it automatically.", true);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
