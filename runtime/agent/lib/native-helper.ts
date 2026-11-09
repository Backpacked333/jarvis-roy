import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runBoundedProcess } from "./desktop-process.ts";

export interface NativeHelperOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

let nativeBusy = false;
/** Executes only the operator-selected bundled helper; every caller validates its exact result DTO. */
export async function runNativeHelper(request: object, signal?: AbortSignal, options: NativeHelperOptions = {}, capability: "desktop" | "calendar" | "embedding" = "desktop"): Promise<unknown> {
  const environment = options.environment ?? process.env;
  if ((request as { operation?: unknown }).operation === "sentence_embeddings" && capability !== "embedding") {
    throw new Error("Sentence embeddings require the narrow embedding capability and its separate opt-in.");
  }
  const enabled = capability === "embedding" ? environment.JARVIS_ENABLE_SEMANTIC_RETRIEVAL === "1"
    : capability === "desktop" ? environment.JARVIS_ENABLE_DESKTOP === "1" : environment.JARVIS_ENABLE_APPLE_SERVICES === "1";
  if (capability === "embedding" && (!enabled || (request as { operation?: unknown }).operation !== "sentence_embeddings")) {
    throw new Error("On-device semantic retrieval is disabled or its narrow embedding operation was not selected.");
  }
  if (!enabled) throw new Error(capability === "desktop"
    ? "Desktop access is disabled. The operator must set JARVIS_ENABLE_DESKTOP=1; every read/action still requires approval."
    : "Calendar access is disabled. The operator must set JARVIS_ENABLE_APPLE_SERVICES=1; a selected-calendar grant or exact approval is required.");
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Native desktop and calendar reads require macOS 14 or newer.");
  const helper = environment.JARVIS_NATIVE_HELPER;
  if (!helper || !path.isAbsolute(helper) || helper.includes("\0")) throw new Error("Set JARVIS_NATIVE_HELPER to the absolute operator-configured JarvisControl executable path.");
  try { if (!(await stat(helper)).isFile()) throw new Error(); await access(helper, constants.X_OK); }
  catch { throw new Error("JarvisControl is unavailable. Build/bundle macos-control and configure JARVIS_NATIVE_HELPER to its absolute executable path."); }
  const stdin = JSON.stringify({ version: 1, ...request });
  if (Buffer.byteLength(stdin) > 65_536) throw new Error("Native helper request exceeds 65536 bytes.");
  if (nativeBusy) throw new Error("Another desktop read/action or calendar read is in progress. Wait for it to finish, then inspect again; concurrent native actions are refused.");
  nativeBusy = true;
  let response;
  try {
    response = await runBoundedProcess(helper, [], path.dirname(helper), {
      signal, stdin, environment, redactOutput: false, timeoutMs: Math.min(options.timeoutMs ?? 12_000, 12_000), maxOutputBytes: 524_288,
    });
  } finally { nativeBusy = false; }
  if (response.status !== "completed") throw new Error(`Native helper did not complete (${response.status}). No successful action is confirmed; inspect again before retrying. Permission setup: System Settings → Privacy & Security → Accessibility / Screen & System Audio Recording / Calendars.`);
  try { return JSON.parse(response.stdout); }
  catch { throw new Error("JarvisControl returned an invalid JSON response; rebuild the bundled helper."); }
}
