import { isValidLocalToken } from "../../agent/lib/local-auth.ts";
import { readBoundedJson } from "../harness-interactions/gateway.ts";

export function assistantAgentPort(context: { sessionId: string; delegated: boolean; signal: AbortSignal }, fetcher: typeof fetch = fetch) {
  const call = async (route: string, body?: unknown) => {
    if (context.delegated) throw new Error("Route assistant requests through the root session");
    const token = process.env.JARVIS_LOCAL_TOKEN;
    if (!isValidLocalToken(token)) throw new Error("Local bridge authentication unavailable");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
    const response = await fetcher(`http://127.0.0.1:39202${route}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "x-jarvis-eve-session": context.sessionId,
        ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Assistant request refused (HTTP ${response.status}). Keep the original project and request a fresh review if needed.`); }
    return readBoundedJson(response, signal, 2 * 1_024 * 1_024);
  };
  return {
    context: () => call("/v1/assistant/tool-context"),
    assembleContext: (input: unknown) => call("/v1/context/recall", input),
    recallMemory: (query?: string) => call("/v1/memory/recall-current", query ? { query } : {}),
    proposeMemory: (input: unknown) => call("/v1/memory/propose-current", input),
    present: (input: unknown) => call("/v1/assistant/present", input),
    readContext: (input: object) => call("/v1/context/read", { ...input, purpose: "cloud" }),
    readArtifact: (input: unknown) => call("/v1/assistant/artifact", input),
    startResearch: (input: unknown) => call("/v1/research/runs", input),
    researchStatus: (projectId: string, runId?: string, result = false) => call(runId
      ? `/v1/research/runs/${encodeURIComponent(runId)}${result ? "/result" : ""}?projectId=${encodeURIComponent(projectId)}`
      : `/v1/research/runs?projectId=${encodeURIComponent(projectId)}`),
    cancelResearch: (projectId: string, runId: string) => call(`/v1/research/runs/${encodeURIComponent(runId)}/cancel`, { projectId }),
  };
}
