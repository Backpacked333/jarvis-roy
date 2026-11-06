import { isIP } from "node:net";
import type { z } from "zod";
import { cancelled, ConnectedServiceError } from "./errors.ts";
import { homeRequestSchema, isoDate, parseInput } from "./schemas.ts";
import { executeOnce, type ServiceExecutionContext } from "./once.ts";

export interface HomeConfiguration { origin: string; token: string }
export type HomeInput = z.infer<typeof homeRequestSchema>;
export interface HomeDependencies {
  env: NodeJS.ProcessEnv;
  directory: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

export function homeConfiguration(env: NodeJS.ProcessEnv): HomeConfiguration | undefined {
  if (!env.HOME_ASSISTANT_URL && !env.HOME_ASSISTANT_TOKEN) return undefined;
  const bad = () => new ConnectedServiceError("invalid_configuration", "Configure HOME_ASSISTANT_URL as a fixed HTTP(S) origin without credentials, path, query or fragment, and HOME_ASSISTANT_TOKEN as its access token. LAN HTTP additionally requires JARVIS_ALLOW_HOME_ASSISTANT_HTTP=1 and a private/loopback IP literal.");
  if (!env.HOME_ASSISTANT_URL || !env.HOME_ASSISTANT_TOKEN) throw bad();
  let url: URL;
  try { url = new URL(env.HOME_ASSISTANT_URL); } catch { throw bad(); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || /[?#\s]/.test(env.HOME_ASSISTANT_URL) || /^https?:\/\/[^/]*@/i.test(env.HOME_ASSISTANT_URL)) throw bad();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && env.JARVIS_ALLOW_HOME_ASSISTANT_HTTP === "1" && isPrivateHost(url.hostname))) throw bad();
  const token = env.HOME_ASSISTANT_TOKEN;
  if (token.length > 8_192 || !/^[\x21-\x7e]+$/.test(token)) throw bad();
  return { origin: url.origin, token };
}

function isPrivateHost(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "");
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(address) === 6 && (address === "::1" || /^f[cd][0-9a-f]{2}:/i.test(address));
}

const serviceParameters: Record<string, Record<string, readonly string[]>> = {
  light: { turn_on: ["brightness"], turn_off: [] },
  switch: { turn_on: [], turn_off: [] },
  fan: { turn_on: [], turn_off: [], set_percentage: ["percentage"] },
  climate: { set_temperature: ["temperature"], set_hvac_mode: ["hvac_mode"] },
  media_player: { turn_on: [], turn_off: [], media_play: [], media_pause: [], media_stop: [], volume_set: ["volume_level"] },
};

function validateService(input: Extract<HomeInput, { action: "call_service" }>): void {
  const allowed = serviceParameters[input.domain]?.[input.service];
  if (!allowed || input.entityId.split(".")[0] !== input.domain || Object.keys(input.data).some((key) => !allowed.includes(key)) || (input.service.startsWith("set_") || input.service === "volume_set") && allowed.some((key) => !(key in input.data))) {
    throw new ConnectedServiceError("unsupported_service", "Only explicitly supported Home Assistant services with matching entity domains and exact service parameters are allowed. Locks, alarms, doors, scripts and automations are not supported.");
  }
}

export async function runHomeService(raw: unknown, context: ServiceExecutionContext, dependencies: HomeDependencies): Promise<unknown> {
  const input = parseInput(homeRequestSchema, raw);
  cancelled(context.signal);
  const config = homeConfiguration(dependencies.env);
  if (!config) throw new ConnectedServiceError("not_configured", "Home Assistant is not connected. The operator must configure HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN; Jarvis does not create accounts or discover credentials.");
  if (input.action === "call_service") {
    validateService(input);
    return executeOnce(dependencies.directory, `home:${config.origin}`, input, context, async () => {
      const response = await request(`/api/services/${input.domain}/${input.service}`, { entity_id: input.entityId, ...input.data }, config, context.signal, dependencies);
      if (!Array.isArray(response)) throw new ConnectedServiceError("invalid_response", "Home Assistant did not return the documented service result. The action may have executed; inspect the device and do not retry.", true);
      return { status: "submitted", effect: "unconfirmed", entityId: input.entityId, domain: input.domain, service: input.service };
    });
  }
  const response = await request(input.action === "list_entities" ? "/api/states" : `/api/states/${encodeURIComponent(input.entityId)}`, undefined, config, context.signal, dependencies);
  if (input.action === "read_state") {
    const state = sanitizeState(response, config.token);
    if (!state || state.entityId !== input.entityId) throw new ConnectedServiceError("invalid_response", "Home Assistant returned an invalid or mismatched entity state.");
    return state;
  }
  if (!Array.isArray(response)) throw new ConnectedServiceError("invalid_response", "Home Assistant returned an invalid entity list.");
  const result = [];
  let truncated = false;
  for (const entry of response) {
    const state = sanitizeState(entry, config.token);
    if (!state || input.domain && !state.entityId.startsWith(`${input.domain}.`)) continue;
    if (result.length >= input.limit) { truncated = true; break; }
    result.push(state);
  }
  return { entities: result, truncated, scope: "light, switch, fan, climate and media_player only; provider attributes omitted" };
}

const validStates: Record<string, readonly string[]> = {
  light: ["on", "off"], switch: ["on", "off"], fan: ["on", "off"],
  climate: ["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"],
  media_player: ["off", "on", "idle", "playing", "paused", "standby", "buffering"],
};

function sanitizeState(value: unknown, token: string) {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const entity = entry.entity_id;
  if (typeof entity !== "string" || entity.length > 160 || entity.includes(token) || !/^(light|switch|fan|climate|media_player)\.[a-z0-9_]+$/.test(entity)) return undefined;
  const state = typeof entry.state === "string" && [...validStates[entity.split(".")[0]], "unknown", "unavailable"].includes(entry.state) ? entry.state : "unrecognized";
  const date = isoDate.safeParse(entry.last_changed);
  return { entityId: entity, state, lastChanged: date.success ? date.data : null };
}

async function request(endpoint: string, body: unknown | undefined, config: HomeConfiguration, signal: AbortSignal | undefined, dependencies: HomeDependencies): Promise<unknown> {
  cancelled(signal);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, dependencies.timeoutMs ?? 10_000);
  const mutation = body !== undefined;
  const failure = (code: string, text: string) => {
    const uncertain = mutation && code !== "permission_denied" && code !== "not_found";
    return new ConnectedServiceError(code, text + (uncertain ? " The service may already have executed; inspect the device and do not retry automatically." : ""), uncertain);
  };
  try {
    const response = await dependencies.fetch(`${config.origin}${endpoint}`, {
      method: mutation ? "POST" : "GET",
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json", ...(mutation ? { "Content-Type": "application/json" } : {}) },
      body: mutation ? JSON.stringify(body) : undefined,
      redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
    });
    if (response.redirected || response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw failure("redirect_denied", "Home Assistant redirects are refused. Configure its final trusted origin directly.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw failure("permission_denied", "Home Assistant rejected access. Check its configured token and permissions.");
      if (response.status === 404) throw failure("not_found", "Home Assistant could not find that entity or service. Check the operator-configured instance.");
      throw failure("provider_error", "Home Assistant could not complete the request. Check the service and instance; its private error body was withheld.");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0].trim();
    if (contentType !== "application/json") {
      await response.body?.cancel();
      throw failure("invalid_response", "Home Assistant did not return JSON. Verify the configured API origin.");
    }
    const data = await readBoundedBody(response, controller.signal);
    try { return JSON.parse(data); } catch { throw failure("invalid_response", "Home Assistant returned invalid JSON."); }
  } catch (error) {
    if (error instanceof ConnectedServiceError) throw failure(error.code, error.message.replace(/ The service may already have executed;.*$/, ""));
    if (controller.signal.aborted) throw failure(timedOut ? "timeout" : "cancelled", timedOut ? "Home Assistant request timed out." : "Home Assistant request was cancelled.");
    throw failure("network_error", "Home Assistant could not be reached securely. Check its final origin, trusted TLS certificate and network. Redirects are not followed.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const limit = 512_000;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new ConnectedServiceError("output_limit", "Home Assistant response exceeds 512 KB. Prefer read_state with a known entity instead of listing this instance.");
  }
  if (!response.body) throw new ConnectedServiceError("invalid_response", "Home Assistant returned no body.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ConnectedServiceError("output_limit", "Home Assistant response exceeds 512 KB. Prefer read_state with a known entity instead of listing this instance.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
