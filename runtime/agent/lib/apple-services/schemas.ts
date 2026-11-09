import { z } from "zod";
import { safeJson } from "../../../bridge/redaction.ts";
import { ConnectedServiceError } from "./errors.ts";

const text = (max: number) => z.string().max(max).refine((value) => !value.includes("\0"), "NUL is not allowed.");
const identifier = text(256).min(1);
const email = z.string().email().max(320).regex(/^[^\s\u0000-\u001f\u007f<>]+$/);
export const isoDate = z.string().max(40).datetime({ offset: true }).refine((value) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const day = value.slice(0, 10);
  const calendarDay = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(calendarDay) && new Date(calendarDay).toISOString().slice(0, 10) === day;
}, "Use a real ISO 8601 date/time with an explicit timezone.");

export const emailRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list_accounts") }),
  z.strictObject({ action: z.literal("list_inbox"), accountId: identifier.optional(), since: isoDate, limit: z.number().int().min(1).max(25) }),
  z.strictObject({ action: z.literal("read_message"), accountId: identifier.optional(), messageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ action: z.literal("send"), accountId: identifier, from: email, to: z.array(email).min(1).max(5).refine((values) => new Set(values.map((v) => v.toLowerCase())).size === values.length), subject: text(500).regex(/^[^\r\n]*$/), body: text(16_000).min(1) }),
]);

export const calendarRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list_calendars") }),
  z.strictObject({ action: z.literal("list_events"), calendarId: identifier, start: isoDate, end: isoDate, limit: z.number().int().min(1).max(50) }),
  z.strictObject({ action: z.literal("create_event"), calendarId: identifier, start: isoDate, end: isoDate, title: text(500).min(1), notes: text(4_000), location: text(500) }),
]).refine((input) => input.action === "list_calendars" || (Date.parse(input.end) > Date.parse(input.start) && Date.parse(input.end) - Date.parse(input.start) <= 31 * 86_400_000), "The end must follow the start and the range must not exceed 31 days.");

export const messageRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list_services") }),
  z.strictObject({ action: z.literal("send"), serviceId: identifier, recipient: z.union([email, z.string().regex(/^\+[1-9]\d{6,14}$/)]), body: text(4_000).min(1) }),
  z.strictObject({ action: z.literal("read_history") }),
]);

export const homeDomainSchema = z.enum(["light", "switch", "fan", "climate", "media_player"]);
export const homeRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list_entities"), domain: homeDomainSchema.optional(), limit: z.number().int().min(1).max(50) }),
  z.strictObject({ action: z.literal("read_state"), entityId: z.string().max(160).regex(/^(light|switch|fan|climate|media_player)\.[a-z0-9_]+$/) }),
  z.strictObject({
    action: z.literal("call_service"), domain: homeDomainSchema,
    service: z.enum(["turn_on", "turn_off", "set_percentage", "set_temperature", "set_hvac_mode", "media_play", "media_pause", "media_stop", "volume_set"]),
    entityId: z.string().max(160).regex(/^(light|switch|fan|climate|media_player)\.[a-z0-9_]+$/),
    data: z.strictObject({ brightness: z.number().int().min(0).max(255).optional(), percentage: z.number().int().min(0).max(100).optional(), temperature: z.number().min(-20).max(50).optional(), hvac_mode: z.enum(["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"]).optional(), volume_level: z.number().min(0).max(1).optional() }),
  }),
]);

// Model providers require an object root, not a top-level oneOf. Keep strict
// per-action validation while exposing the action enum and optional fields.
function toolObject(schema: z.ZodDiscriminatedUnion) {
  const fields: Record<string, z.ZodType> = {};
  const actions: string[] = [];
  for (const option of schema.options) {
    if (!(option instanceof z.ZodObject)) throw new Error("Service actions must have object schemas.");
    for (const [key, value] of Object.entries(option.shape as Record<string, z.ZodType>)) {
      if (key === "action" && value instanceof z.ZodLiteral) actions.push(String(value.value));
      else fields[key] = value.optional();
    }
  }
  return z.strictObject({ ...fields, action: z.enum(actions as [string, ...string[]]) }).refine((value) => schema.safeParse(value).success, "Use only the required fields for the selected action.");
}

export const emailServiceSchema = toolObject(emailRequestSchema);
export const calendarServiceSchema = toolObject(calendarRequestSchema);
export const messageServiceSchema = toolObject(messageRequestSchema);
export const homeServiceSchema = toolObject(homeRequestSchema);

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  let exact: string | undefined;
  try { exact = JSON.stringify(input); } catch { /* Refuse inputs that cannot be reviewed. */ }
  if (exact === undefined || safeJson(input) !== exact) {
    throw new ConnectedServiceError("unreviewable_input", "This connected-service request cannot be approved exactly because its arguments would be redacted or are not serializable. Remove credentials or sensitive credential-like text and submit a new request. Nothing was executed.");
  }
  const result = schema.safeParse(input);
  if (!result.success) throw new ConnectedServiceError("invalid_input", "Invalid connected-service input. Use the documented action and exact bounded fields; arbitrary scripts, paths, attendees, URLs and extra fields are not allowed.");
  return result.data;
}

export const submissionSchema = z.object({ status: z.literal("submitted"), delivery: z.literal("unconfirmed") });
const header = z.object({ accountId: identifier.optional(), messageId: z.number().int().positive(), subject: text(500), sender: text(500), receivedAt: isoDate });
export const appleOutputSchemas = {
  list_accounts: z.object({ accounts: z.array(z.object({ accountId: identifier, name: text(256), enabled: z.boolean(), addresses: z.array(text(320)).max(10) })).max(20), truncated: z.boolean() }),
  list_inbox: z.object({ accountId: identifier.optional(), messages: z.array(header).max(25), truncated: z.boolean(), ordering: text(200) }),
  read_message: header.extend({ body: text(16_000), truncated: z.boolean() }),
  send: submissionSchema,
  list_calendars: z.object({ calendars: z.array(z.object({ calendarId: identifier, name: text(256), writable: z.boolean() })).max(30), truncated: z.boolean() }),
  list_events: z.object({ events: z.array(z.object({ eventId: identifier, title: text(500), start: isoDate, end: isoDate, allDay: z.boolean(), location: text(500) })).max(50), truncated: z.boolean(), recurrence: text(200) }),
  create_event: z.object({ status: z.literal("created"), eventId: identifier }),
  list_services: z.object({ services: z.array(z.object({ serviceId: identifier, name: text(256) })).max(10), truncated: z.boolean() }),
};
