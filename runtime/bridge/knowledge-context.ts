import { z } from "zod";
import { createConnectedServices } from "../agent/lib/connected-services.ts";
import { listWindows, readWindow, windowListInputSchema, windowReadInputSchema } from "../agent/lib/desktop.ts";
import { readCalendarContext } from "../agent/lib/apple-services/calendar-context.ts";
import { emailRequestSchema, isoDate } from "../agent/lib/apple-services/schemas.ts";
import { BridgeError } from "./errors.ts";
import { KnowledgeId, PurposeSchema, type KnowledgeService } from "./knowledge/index.ts";

const identifier = z.string().min(1).max(256).refine((value) => !value.includes("\0"));
const common = { projectId: KnowledgeId, grantId: KnowledgeId, resourceId: z.string().min(1).max(1024), purpose: PurposeSchema };
const mailRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list_inbox"), accountId: identifier, since: isoDate, limit: z.number().int().min(1).max(25) }),
  z.strictObject({ action: z.literal("read_message"), accountId: identifier, messageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
]);
export const ScopedContextInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("window"), target: windowReadInputSchema }),
  z.strictObject({ ...common, kind: z.literal("calendar"), calendarId: identifier, start: isoDate, end: isoDate, limit: z.number().int().min(1).max(50) }),
  z.strictObject({ ...common, kind: z.literal("mail_account"), request: mailRequest }),
]);
export type ScopedContextInput = z.infer<typeof ScopedContextInputSchema>;
export const ContextResourcesInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ projectId: KnowledgeId, kind: z.literal("window"), ...windowListInputSchema.shape }),
  z.strictObject({ projectId: KnowledgeId, kind: z.literal("calendar") }),
  z.strictObject({ projectId: KnowledgeId, kind: z.literal("mail_account") }),
]);

export interface ContextDependencies {
  windows?: typeof listWindows;
  window?: typeof readWindow;
  calendar?: typeof readCalendarContext;
  mail?: ReturnType<typeof createConnectedServices>["email"];
  now?: () => Date;
}

export function windowResourceId(target: z.infer<typeof windowReadInputSchema>): string {
  const input = windowReadInputSchema.parse(target);
  return `window:${input.bundleId}:${input.processId}:${input.launchTimestamp}:${input.windowId}`;
}
export function calendarResourceId(calendarId: string): string { return `calendar:${identifier.parse(calendarId)}`; }
export function mailResourceId(accountId: string): string { return `mail_account:${identifier.parse(accountId)}`; }

/** The caller must enforce native authentication for resource discovery. No private content is read here. */
export async function discoverContextResources(raw: unknown, signal?: AbortSignal, dependencies: ContextDependencies = {}) {
  const input = ContextResourcesInputSchema.parse(raw);
  signal?.throwIfAborted();
  if (input.kind === "window") {
    const result = await (dependencies.windows ?? listWindows)({ bundleId: input.bundleId }, signal);
    return { version: 1, projectId: input.projectId, truncated: result.truncated, resources: result.windows.map((window) => {
      const target = { bundleId: result.bundleId, processId: result.processId, launchTimestamp: result.launchTimestamp, windowId: window.windowId };
      return { resourceKind: "window", resourceId: windowResourceId(target), label: (window.title || input.bundleId).slice(0, 240), target, onScreen: window.onScreen };
    }) };
  }
  if (input.kind === "calendar") {
    const result = await (dependencies.calendar ?? readCalendarContext)({ action: "list_calendars" }, signal);
    if (result.kind !== "calendars") throw new BridgeError("Calendar discovery returned the wrong response.", 502);
    return { version: 1, projectId: input.projectId, truncated: result.truncated, resources: result.calendars.map((calendar) => ({
      resourceKind: "calendar", resourceId: calendarResourceId(calendar.calendarId), label: (calendar.title || calendar.calendarId).slice(0, 240),
      target: { calendarId: calendar.calendarId }, sourceTitle: calendar.sourceTitle,
    })) };
  }
  const result = await (dependencies.mail ?? createConnectedServices().email)({ action: "list_accounts" }, { signal }) as {
    accounts: Array<{ accountId: string; name: string; enabled: boolean }>; truncated: boolean;
  };
  return { version: 1, projectId: input.projectId, truncated: result.truncated, resources: result.accounts.filter((account) => account.enabled).map((account) => ({
    resourceKind: "mail_account", resourceId: mailResourceId(account.accountId), label: (account.name || account.accountId).slice(0, 240), target: { accountId: account.accountId },
  })) };
}

/** Exact selectors and disclosure purpose are bound to the persisted grant before and after native I/O. */
export async function readScopedContext(raw: unknown, knowledge: Pick<KnowledgeService, "withGrant">, signal?: AbortSignal, dependencies: ContextDependencies = {}) {
  const input = ScopedContextInputSchema.parse(raw);
  const resourceId = input.kind === "window" ? windowResourceId(input.target)
    : input.kind === "calendar" ? calendarResourceId(input.calendarId) : mailResourceId(input.request.accountId);
  if (resourceId !== input.resourceId) throw new BridgeError("The selected context identity does not match its read grant.", 403);
  const operation = input.kind === "window" ? "inspect_window" : input.kind === "calendar" ? "read_calendar" : "read_mail";
  return knowledge.withGrant({ grantId: input.grantId, projectId: input.projectId, resourceId, purpose: input.purpose, operation }, async (combined) => {
    const data = input.kind === "window" ? await (dependencies.window ?? readWindow)(input.target, combined)
      : input.kind === "calendar" ? await (dependencies.calendar ?? readCalendarContext)({ action: "list_events", calendarId: input.calendarId,
        start: input.start, end: input.end, limit: input.limit }, combined)
      : await (dependencies.mail ?? createConnectedServices().email)(emailRequestSchema.parse(input.request), { signal: combined });
    combined.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(data)) > 128_000) throw new BridgeError("Selected context exceeds its bounded response size.", 413);
    return { version: 1, projectId: input.projectId, resourceKind: input.kind, resourceId,
      readAt: (dependencies.now ?? (() => new Date()))().toISOString(), contentTrust: "untrusted" as const, data };
  }, signal);
}
