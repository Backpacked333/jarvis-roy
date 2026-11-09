import { z } from "zod";
import { BridgeError } from "./errors.ts";
import type { ObjectiveRuntime } from "./objective-runtime.ts";
import type { ContinuityService } from "./continuity/index.ts";
import type { JarvisService } from "./service.ts";
import type { AssistantAdapters } from "./assistant/coordinator.ts";
import { ActionRefSchema } from "./assistant/contracts.ts";
import type { NativeCloudRuntime } from "./native-cloud-runtime.ts";

const Input = z.strictObject({ version: z.literal(1), operation: z.enum(["objectives", "reserve", "settle", "stop", "read_action", "bind_executor", "execute_action", "checkpoint", "readiness"]), payload: z.unknown() });
export type CloudRuntimeBroker = (input: unknown) => Promise<unknown>;
export function createCloudRuntimeBroker(options: {
  objectives: ObjectiveRuntime; continuity: ContinuityService; service: JarvisService;
  authority: Required<Pick<AssistantAdapters, "readAction" | "executeAction">>; nativeCloud?: NativeCloudRuntime;
}): CloudRuntimeBroker {
  return async raw => {
    const { operation, payload } = Input.parse(raw);
    if (operation === "readiness") return { version: 1, profile: "cloud", objectives: options.objectives.service.readiness() };
    if (operation === "objectives") {
      const input = z.strictObject({ method: z.enum(["GET", "POST", "PATCH"]), path: z.string().max(2048), body: z.unknown().optional() }).parse(payload);
      const url = new URL(input.path, "http://127.0.0.1");
      if (url.origin !== "http://127.0.0.1" || !/^\/v1\/objectives(?:\/|$)/.test(url.pathname)) throw new BridgeError("Invalid objective route.", 400);
      return options.objectives.route(input.method, url, input.body, { nativeAuthenticated: false, ownerAuthenticated: true });
    }
    if (operation === "reserve") return options.objectives.service.reserve(payload);
    if (operation === "settle") {
      const input = z.strictObject({ id: z.string(), accounting: z.enum(["measured", "unknown"]), estimatedUsd: z.number().finite().nonnegative().nullable() }).parse(payload);
      return options.objectives.service.settle(input.id, { accounting: input.accounting, estimatedUsd: input.estimatedUsd });
    }
    if (operation === "stop") { await options.objectives.service.stop(); await options.service.stop(); return { version: 1, stopped: true }; }
    if (operation === "read_action") {
      const input = z.strictObject({ ref: ActionRefSchema, projectId: z.string() }).parse(payload);
      if (options.service.projectForTask(input.ref.taskId) !== input.projectId && input.ref.taskId !== input.projectId) return null;
      return options.authority.readAction(input.ref);
    }
    if (operation === "bind_executor" || operation === "execute_action") {
      if (!options.nativeCloud) throw new BridgeError("Remote approval verifier is unavailable.", 503);
      return operation === "bind_executor" ? options.nativeCloud.pair(payload) : options.nativeCloud.execute(payload);
    }
    const input = z.strictObject({ projectId: z.string(), query: z.string().max(1000).default("") }).parse(payload);
    return options.continuity.checkpoint(input.projectId, "cloud", input.query);
  };
}

/** Narrow gateway-to-bridge channel; never uses or forwards native UI credentials. */
export function cloudRuntimeClient(options: { baseUrl?: string; localToken: string; runtimeToken: string; fetch?: typeof fetch }) {
  const base = new URL(options.baseUrl ?? "http://127.0.0.1:39202");
  if (base.origin !== "http://127.0.0.1:39202" || options.localToken.length < 32 || options.runtimeToken.length < 32) throw new Error("Invalid private cloud runtime configuration");
  return async (operation: string, payload: unknown = {}): Promise<any> => {
    const response = await (options.fetch ?? fetch)(new URL("/v1/cloud/runtime", base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(35000),
      headers: { authorization: `Bearer ${options.localToken}`, "x-jarvis-cloud-runtime-token": options.runtimeToken, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, operation, payload }) });
    if (!response.ok) { await response.body?.cancel(); throw new BridgeError(`Private runtime request failed (${response.status}).`, response.status); }
    const reader = response.body?.getReader(); if (!reader) throw new Error("Missing runtime response");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("Runtime response exceeds limit"); } chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}
