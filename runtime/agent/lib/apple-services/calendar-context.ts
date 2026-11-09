import { z } from "zod";
import { runNativeHelper, type NativeHelperOptions } from "../native-helper.ts";
import { isoDate } from "./schemas.ts";
import { cancelled, ConnectedServiceError, safeText } from "./errors.ts";

const identifier = z.string().min(1).max(256).refine((value) => !value.includes("\0"));
export const calendarContextInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_calendars") }).strict(),
  z.object({ action: z.literal("list_events"), calendarId: identifier,
    start: isoDate, end: isoDate, limit: z.number().int().min(1).max(50) }).strict(),
]).refine((value) => value.action === "list_calendars" ||
  Date.parse(value.end) > Date.parse(value.start) && Date.parse(value.end) - Date.parse(value.start) <= 31 * 86_400_000,
"Select a positive calendar range of at most 31 days.");
export type CalendarContextInput = z.infer<typeof calendarContextInputSchema>;
const calendars = z.object({ kind: z.literal("calendars"), calendars: z.array(z.object({
  calendarId: identifier, title: z.string().max(256), sourceTitle: z.string().max(256),
}).strict()).max(100), truncated: z.boolean() }).strict();
const events = z.object({ kind: z.literal("calendar_events"), calendarId: identifier, start: isoDate, end: isoDate,
  events: z.array(z.object({ occurrenceId: z.string().regex(/^[a-f0-9]{64}$/), eventId: identifier, calendarId: identifier,
    title: z.string().max(500), start: isoDate, end: isoDate, isAllDay: z.boolean() }).strict()).max(50),
  truncated: z.boolean(),
}).strict();
const response = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.union([calendars, events]) }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().max(80), message: z.string().max(2000) }).strict() }).strict(),
]);

/** EventKit identifiers are intentionally separate from the legacy Calendar JXA write adapter. */
export async function readCalendarContext(raw: unknown, signal?: AbortSignal, options: NativeHelperOptions = {}) {
  cancelled(signal);
  const input = calendarContextInputSchema.parse(raw);
  const request = input.action === "list_calendars" ? { operation: "list_calendars" }
    : { operation: "list_calendar_events", calendarId: input.calendarId, start: input.start, end: input.end, limit: input.limit };
  const parsed = response.safeParse(await runNativeHelper(request, signal, options, "calendar"));
  if (!parsed.success) throw new ConnectedServiceError("invalid_response", "JarvisControl returned an invalid calendar response; no event content was returned.");
  if (!parsed.data.ok) throw new ConnectedServiceError("calendar_unavailable", safeText(`${parsed.data.error.code}: ${parsed.data.error.message}`, 2000));
  const result = parsed.data.result;
  if (input.action === "list_calendars") {
    if (result.kind !== "calendars" || new Set(result.calendars.map((calendar) => calendar.calendarId)).size !== result.calendars.length) {
      throw new ConnectedServiceError("invalid_response", "JarvisControl returned invalid calendar identities.");
    }
    return { ...result, calendars: result.calendars.map((calendar) => ({ ...calendar, title: safeText(calendar.title, 256), sourceTitle: safeText(calendar.sourceTitle, 256) })) };
  }
  if (result.kind !== "calendar_events" || result.calendarId !== input.calendarId || Date.parse(result.start) !== Date.parse(input.start) ||
      Date.parse(result.end) !== Date.parse(input.end) || result.events.length > input.limit ||
      new Set(result.events.map((event) => event.occurrenceId)).size !== result.events.length ||
      result.events.some((event) => event.calendarId !== input.calendarId || Date.parse(event.end) < Date.parse(event.start) ||
        Date.parse(event.start) >= Date.parse(input.end) ||
        !(Date.parse(event.end) > Date.parse(input.start) || event.start === event.end && Date.parse(event.start) >= Date.parse(input.start)))) {
    throw new ConnectedServiceError("invalid_response", "JarvisControl returned events outside the selected calendar or date range; no event content was returned.");
  }
  return { ...result, events: result.events.map((event) => ({ ...event, title: safeText(event.title, 500) })),
    recurrence: "EventKit occurrences expanded within the selected calendar and date range." };
}
