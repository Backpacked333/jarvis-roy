import { z } from "zod";
import { IdSchema, TimestampSchema } from "../harness-contracts/domain.ts";
import { DatabaseSchema } from "./model.ts";

export const RoomArchiveSummarySchema = z.strictObject({
  version: z.literal(1), id: IdSchema, roomId: IdSchema, title: z.string().max(120), archivedAt: TimestampSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), counts: z.strictObject({ plans: z.number().int().nonnegative(), runs: z.number().int().nonnegative(), artifacts: z.number().int().nonnegative() }),
});
export type RoomArchiveSummary = z.infer<typeof RoomArchiveSummarySchema>;
export const RoomArchiveSchema = z.strictObject({ summary: RoomArchiveSummarySchema, snapshot: DatabaseSchema });
export type RoomArchive = z.infer<typeof RoomArchiveSchema>;
export interface ArchivedRequest { key: string; digest: string; entityId: string; archiveId: string }
