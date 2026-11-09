import { z } from "zod";
import { BridgeError } from "./errors.ts";
import { IdSchema } from "./harness-contracts/domain.ts";
import type { HarnessService } from "./harness-contracts/service.ts";

export interface ArchiveRouteContext {
  nativeAuthenticated: boolean;
  enabled: boolean;
  /** Root conversations and approvals are projected outside the room kernel. */
  hasUnsettledProjectWork: (roomId: string) => boolean | Promise<boolean>;
}
export interface ArchiveReply { status: number; body: unknown }

/** Call after loopback/bearer validation and through the shared mutation barrier. */
export async function archiveRoute(method: string, url: URL, body: unknown, harness: HarnessService,
  context: ArchiveRouteContext): Promise<ArchiveReply | null> {
  const list = url.pathname === "/v1/harness/archives";
  const read = /^\/v1\/harness\/archives\/([^/]+)$/.exec(url.pathname);
  const move = /^\/v1\/harness\/rooms\/([^/]+)\/archive$/.exec(url.pathname);
  if (!list && !read && !move) return null;
  if (!context.nativeAuthenticated) throw new BridgeError("Room history archives require the trusted native controls.", 403);
  if (!context.enabled) throw new BridgeError("Enable the assistant workspace before using room history archives.", 503);
  if (list && method === "GET") {
    if (!harness.listArchives) throw new BridgeError("Room history archives are unavailable.", 503);
    const roomId = url.searchParams.has("roomId") ? IdSchema.parse(url.searchParams.get("roomId")) : undefined;
    return { status: 200, body: { version: 1, archives: await harness.listArchives(roomId) } };
  }
  if (read && method === "GET") {
    if (!harness.readArchive) throw new BridgeError("Room history archives are unavailable.", 503);
    const id = IdSchema.parse(read[1]), roomId = IdSchema.parse(url.searchParams.get("roomId"));
    return { status: 200, body: await harness.readArchive(id, roomId) };
  }
  if (move && method === "POST") {
    if (!harness.archiveRoom) throw new BridgeError("Room history archives are unavailable.", 503);
    const roomId = IdSchema.parse(move[1]);
    const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(body);
    if (await context.hasUnsettledProjectWork(roomId)) throw new BridgeError("This room still has active root work or unresolved approvals. Settle it before archiving history.", 409);
    return { status: 201, body: await harness.archiveRoom(roomId, input.expectedRevision) };
  }
  throw new BridgeError("Unsupported archive operation.", 405);
}
