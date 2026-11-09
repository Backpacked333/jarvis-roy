import { BridgeError } from "./errors.ts";
import type { ObjectiveService } from "./objectives/index.ts";

/** HTTP callers cannot create paid work outside the shared objective ledger.
 * Trusted objective adapters call the existing authorities in process. */
export function assertCloudPaidAdmission(method: string, pathname: string, body: unknown, objectives?: Pick<ObjectiveService, "hasReservedHarnessChild">,
  profile = process.env.JARVIS_RUNTIME_PROFILE): void {
  if (profile !== "cloud" || method !== "POST") return;
  const parts = pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
  const deny = () => { throw new BridgeError("Cloud paid work requires a capped objective in Today. Review its budget and exact plan before starting; direct research, plan authoring and unreserved worker continuations are unavailable.", 409); };
  const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (parts.join("/") === "v1/research/runs") deny();
  if (parts.join("/") === "v1/knowledge/extract" || parts.join("/") === "v1/knowledge/retrieve" && data.provider === "tavily") deny();
  if (parts[0] !== "v1" || parts[1] !== "harness") return;
  if (parts[2] === "rooms") {
    if (parts.length === 5 && ["author", "runs"].includes(parts[4])) deny();
    const continuation = parts[4] === "runs" && (parts.length === 7 && parts[6] === "resume" || parts.length === 9 && parts[6] === "nodes" && parts[8] === "retry");
    if (continuation && !objectives?.hasReservedHarnessChild(parts[3], parts[5])) deny();
  }
  if (parts[2] === "questions" && parts.length === 5 && ["answer", "voice-answer"].includes(parts[4])) {
    const binding = data.binding && typeof data.binding === "object" ? data.binding as Record<string, unknown> : {};
    const target = binding.target && typeof binding.target === "object" ? binding.target as Record<string, unknown> : {};
    if (target.scope !== "node" || typeof target.roomId !== "string" || typeof target.runId !== "string" || !objectives?.hasReservedHarnessChild(target.roomId, target.runId)) deny();
  }
}
