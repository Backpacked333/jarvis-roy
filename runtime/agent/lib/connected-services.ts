import type { z } from "zod";
import { getDataDirectory } from "./persistence.ts";
import { cancelled, ConnectedServiceError, safeText } from "./apple-services/errors.ts";
import { createAppleRunner, type AppleRunner } from "./apple-services/process.ts";
import type { AppleScriptName } from "./apple-services/scripts.ts";
import { executeOnce, type ServiceExecutionContext } from "./apple-services/once.ts";
import { homeConfiguration, runHomeService } from "./apple-services/home-assistant.ts";
import { appleOutputSchemas, calendarRequestSchema, emailRequestSchema, messageRequestSchema, parseInput } from "./apple-services/schemas.ts";

export { calendarServiceSchema, emailServiceSchema, homeServiceSchema, messageServiceSchema } from "./apple-services/schemas.ts";
export { ConnectedServiceError } from "./apple-services/errors.ts";
export type { ServiceExecutionContext } from "./apple-services/once.ts";

export interface ConnectedServicesOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  directory?: string;
  appleRunner?: AppleRunner;
  fetch?: typeof fetch;
  now?: () => number;
  homeTimeoutMs?: number;
}

export function connectedServicesStatus(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  const appleState = env.JARVIS_ENABLE_APPLE_SERVICES !== "1" ? "disabled" : platform !== "darwin" ? "requires_macos" : "configured_unverified";
  const appleDetail = appleState === "disabled" ? "Opt in with JARVIS_ENABLE_APPLE_SERVICES=1. No local account has been inspected."
    : appleState === "requires_macos" ? "Native connectors require macOS Mail, Calendar and Messages."
      : "Opted in, not verified connected. Configured local accounts and Automation permissions are required; every read and write needs approval.";
  let homeState = "not_configured";
  let homeDetail = "Optional: configure HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN. No connection has been attempted.";
  try {
    if (homeConfiguration(env)) {
      homeState = "configured_unverified";
      homeDetail = "Operator configuration is present, not verified connected. Every read and service action needs approval.";
    }
  } catch {
    homeState = "invalid_configuration";
    homeDetail = "Use a credential-free fixed HTTPS origin and token. Private/loopback IP HTTP additionally needs JARVIS_ALLOW_HOME_ASSISTANT_HTTP=1. Paths, queries and fragments are forbidden.";
  }
  return {
    mail: { state: appleState, detail: appleDetail, supported: ["list_accounts", "list_inbox", "read_message", "send"], unsupported: ["attachments", "bulk_mail", "arbitrary_mailboxes", "delete"] },
    calendar: { state: appleState, detail: appleDetail, supported: ["list_calendars", "list_events", "create_event"], unsupported: ["delete", "attendees_or_invitations", "recurrence_expansion", "recurrence_creation"] },
    messages: { state: appleState, detail: appleDetail, supported: ["list_services", "send_imessage"], unsupported: ["read_history", "SMS", "attachments", "group_messages"] },
    homeAssistant: { state: homeState, detail: homeDetail, supported: ["list_entities", "read_state", "allowlisted_light_switch_fan_climate_media_player_services"], unsupported: ["locks", "alarms", "doors", "scripts", "automations", "arbitrary_services", "HomeKit"] },
  };
}

export function createConnectedServices(options: ConnectedServicesOptions = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const directory = options.directory ?? getDataDirectory();
  const runner = options.appleRunner ?? createAppleRunner();
  const now = options.now ?? Date.now;
  function requireApple(context: ServiceExecutionContext) {
    cancelled(context.signal);
    if (env.JARVIS_ENABLE_APPLE_SERVICES !== "1") throw new ConnectedServiceError("disabled", "Local account access is disabled. Explicitly set JARVIS_ENABLE_APPLE_SERVICES=1 and relaunch to enable approval-gated native services.");
    if (platform !== "darwin") throw new ConnectedServiceError("requires_macos", "Native connected services require macOS with configured Mail, Calendar or Messages and Automation permission.");
  }
  async function native(script: AppleScriptName, argv: string[], action: keyof typeof appleOutputSchemas, context: ServiceExecutionContext, mutation = false): Promise<unknown> {
    try {
      const raw = await runner(script, argv, { signal: context.signal, mutation });
      const parsed = appleOutputSchemas[action].safeParse(raw);
      if (!parsed.success) throw new ConnectedServiceError("invalid_response", "The local app returned an invalid or oversized response." + (mutation ? " The action may have taken effect; inspect the app and do not retry." : ""), mutation);
      return sanitizeNative(parsed.data);
    } catch (error) {
      if (error instanceof ConnectedServiceError) throw error;
      throw new ConnectedServiceError("native_error", "The local app could not complete the action. Verify its configuration and Automation permission." + (mutation ? " The outcome is uncertain; inspect the app and do not retry." : ""), mutation);
    }
  }
  return {
    status: () => connectedServicesStatus(env, platform),
    async email(raw: unknown, context: ServiceExecutionContext = {}) {
      const input = parseInput(emailRequestSchema, raw);
      requireApple(context);
      if (input.action === "list_inbox" && (Date.parse(input.since) > now() || now() - Date.parse(input.since) > 30 * 86_400_000)) {
        throw new ConnectedServiceError("invalid_range", "Inbox headers require an explicit since timestamp within the last 30 days, not in the future; at most 25 headers are returned.");
      }
      const execute = async () => {
        const result = await native("mail", [JSON.stringify(input)], input.action, context, input.action === "send");
        if (input.action === "read_message" && (result as { messageId: number }).messageId !== input.messageId) {
          throw new ConnectedServiceError("invalid_response", "Mail returned a different message than the explicitly selected ID. No message content was returned.");
        }
        return result;
      };
      return input.action === "send" ? executeOnce(directory, "mail", input, context, execute) : execute();
    },
    async calendar(raw: unknown, context: ServiceExecutionContext = {}) {
      const input = parseInput(calendarRequestSchema, raw);
      requireApple(context);
      const execute = () => native("calendar", [JSON.stringify(input)], input.action, context, input.action === "create_event");
      return input.action === "create_event" ? executeOnce(directory, "calendar", input, context, execute) : execute();
    },
    async message(raw: unknown, context: ServiceExecutionContext = {}) {
      const input = parseInput(messageRequestSchema, raw);
      cancelled(context.signal);
      if (input.action === "read_history") return { status: "unsupported", reason: "Messages does not provide a supported message-history scripting API. Jarvis will not read chat.db or scrape private databases. Select and share text yourself if you want it analyzed." };
      requireApple(context);
      if (input.action === "list_services") return native("message_services", [JSON.stringify(input)], input.action, context);
      return executeOnce(directory, "imessage", input, context, () => native("message_send", [input.serviceId, input.recipient, input.body], "send", context, true));
    },
    async home(raw: unknown, context: ServiceExecutionContext = {}) {
      return runHomeService(raw, context, { env, directory, fetch: options.fetch ?? fetch, timeoutMs: options.homeTimeoutMs });
    },
  };
}

function sanitizeNative(value: unknown): unknown {
  if (typeof value === "string") return safeText(value, 16_000);
  if (Array.isArray(value)) return value.map(sanitizeNative);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeNative(entry)]));
  return value;
}

export type EmailServiceInput = z.infer<typeof emailRequestSchema>;
export type CalendarServiceInput = z.infer<typeof calendarRequestSchema>;
export type MessageServiceInput = z.infer<typeof messageRequestSchema>;
