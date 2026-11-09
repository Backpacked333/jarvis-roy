import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getDataDirectory } from "../agent/lib/persistence.ts";
import { bearerTokenMatches } from "../agent/lib/local-auth.ts";
import { CloudControlPlane, createCloudGateway, cloudCommandDigest } from "./cloud/index.ts";
import { cloudRuntimeClient } from "./cloud-runtime-broker.ts";
import { IntegrationService, ExistingVoiceSpeechAdapter, type ApprovedEffect, type IntegrationPrices } from "./integrations/index.ts";
import { canonicalJson } from "./harness-contracts/validation.ts";
import { createCloudConversationRuntime } from "./cloud-conversation-runtime.ts";
import { ObjectiveSchema } from "./objectives/contracts.ts";
import { BridgeError } from "./errors.ts";

const yes = (env: NodeJS.ProcessEnv, key: string) => env[key] === "1";
const required = (env: NodeJS.ProcessEnv, key: string) => { const value = env[key]; if (!value) throw new Error(`Configure ${key} before enabling this service.`); return value; };
function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); }
async function body(request: IncomingMessage): Promise<any> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of request) { bytes += part.length; if (bytes > 512 * 1024) throw new BridgeError("Request exceeds limit.", 413); parts.push(Buffer.from(part)); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch { throw new BridgeError("Invalid JSON.", 400); }
}
export async function createCloudApplication(options: { env?: NodeJS.ProcessEnv; dataDirectory?: string; rpc?: ReturnType<typeof cloudRuntimeClient>; fetch?: typeof fetch }) {
  const env = options.env ?? process.env;
  if (!yes(env, "JARVIS_ENABLE_CLOUD") || env.JARVIS_RUNTIME_PROFILE !== "cloud") throw new Error("Select the cloud profile and explicitly enable cloud transport.");
  const origin = required(env, "JARVIS_CLOUD_ORIGIN"), runtimeToken = required(env, "JARVIS_CLOUD_RUNTIME_TOKEN"), localToken = required(env, "JARVIS_LOCAL_TOKEN");
  if (runtimeToken.length < 32 || localToken.length < 32 || runtimeToken === localToken) throw new Error("Distinct private runtime credentials required.");
  const rpc = options.rpc ?? cloudRuntimeClient({ localToken, runtimeToken });
  const dataDirectory = options.dataDirectory ?? getDataDirectory();
  const approvedEffect = new AsyncLocalStorage<ApprovedEffect>();
  let integrations: IntegrationService;
  let lifecycleGeneration = 0;
  async function stopWork(includeIntegrations = true) {
    lifecycleGeneration++;
    const outcomes = await Promise.allSettled([
      ...(includeIntegrations ? [Promise.resolve().then(() => integrations.stop())] : []),
      Promise.resolve().then(() => control.stopAll()),
      Promise.resolve().then(() => rpc("stop")),
    ]);
    if (outcomes.some(outcome => outcome.status === "rejected")) throw new BridgeError("Stop is not fully confirmed. Admission remains paused; inspect active work and retry Stop to reconcile.", 503);
  }
  async function resumeWork(actor: Parameters<CloudControlPlane["resume"]>[0], outreachOnly = false) {
    const generation = lifecycleGeneration;
    const assertCurrent = () => { if (generation !== lifecycleGeneration) throw new BridgeError("Resume was superseded by Stop.", 409); };
    try {
      if (!outreachOnly) { await rpc("resume"); assertCurrent(); }
      await control.resume(actor); assertCurrent();
      if (integrations.enabled) integrations.resume();
      assertCurrent();
    } catch {
      await stopWork().catch(() => {});
      throw new BridgeError("Resume was not confirmed. Work and outreach have been paused again; inspect status before retrying.", 503);
    }
  }
  const control = await CloudControlPlane.open({ dataDirectory, publicOrigin: origin, bootstrapToken: env.JARVIS_CLOUD_BOOTSTRAP_TOKEN, localExecutorId: "cloud-runtime",
    readAction: (ref, scope) => rpc("read_action", { ref, projectId: scope.projectId }),
    async executeAction(action, receipt) {
      const binding = control.runtimeExecutorBinding();
      await rpc("bind_executor", { version: 1, profileId: "cloud-runtime", origin, ...binding });
      const fields = { version: 1 as const, type: "command" as const, id: receipt.id, ...binding, sequence: 1, payload: { kind: "action.execute" as const, proposalId: receipt.proposalId, action, receipt },
        createdAt: receipt.issuedAt, expiresAt: receipt.expiresAt, status: "sent" as const };
      const { receiptPublicKey: _key, ...command } = fields;
      const result = await rpc("execute_action", { version: 1, profileId: "cloud-runtime", command: { ...command, digest: cloudCommandDigest(command) } });
      return { outcome: result.status === "completed" ? "completed" : "unknown" };
    },
    readCall: sid => integrations.readCall(sid), authorizeCall: (sid, proof) => integrations.authorizeCall(sid, proof),
  });
  const integrationEnabled = yes(env, "JARVIS_ENABLE_INTEGRATIONS"), projectId = env.JARVIS_INTEGRATION_PROJECT_ID ?? "personal";
  const timezone = integrationEnabled ? required(env, "JARVIS_TIME_ZONE") : "UTC";
  const context = { projectId, objectiveId: null };
  const price = (key: string) => { const value = env[key]; if (value === undefined || value === "") return undefined; const amount = Number(value); if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid ${key}`); return amount; };
  const prices: IntegrationPrices = { telegramRequestUsd: price("JARVIS_PRICE_TELEGRAM_REQUEST_USD"), googleRequestUsd: price("JARVIS_PRICE_GOOGLE_REQUEST_USD"),
    twilioRequestUsd: price("JARVIS_PRICE_TWILIO_REQUEST_USD"), twilioMinuteUsd: price("JARVIS_PRICE_TWILIO_MINUTE_USD"),
    elevenLabsMinuteUsd: price("JARVIS_PRICE_ELEVENLABS_STT_MINUTE_USD"), elevenLabsCharacterUsd: price("JARVIS_PRICE_ELEVENLABS_TTS_CHARACTER_USD") };
  const objective = async (id: string, scope: string) => ObjectiveSchema.parse((await rpc("objectives", { method: "GET", path: `/v1/objectives/${id}?projectId=${encodeURIComponent(scope)}` })).body);
  const conversations = createCloudConversationRuntime({ rpc, integrations: () => integrations, control, origin, projectId,
    telegramDestination: env.JARVIS_TELEGRAM_OWNER_CHAT_ID ?? "", phoneDestination: env.JARVIS_OWNER_PHONE_NUMBER ?? "" });
  try {
    integrations = await IntegrationService.open({ dataDirectory, enabled: integrationEnabled, encryptionKey: env.JARVIS_INTEGRATION_KEY ? Buffer.from(env.JARVIS_INTEGRATION_KEY, "hex") : undefined,
      fetch: options.fetch, prices, ledger: { reserve: input => rpc("reserve", input), settle: (id, result) => rpc("settle", { id, ...result }) },
      telegram: integrationEnabled && yes(env, "JARVIS_ENABLE_TELEGRAM") ? { botToken: required(env, "JARVIS_TELEGRAM_BOT_TOKEN"), ownerChatId: required(env, "JARVIS_TELEGRAM_OWNER_CHAT_ID"), timeZone: timezone, context } : undefined,
      google: integrationEnabled && yes(env, "JARVIS_ENABLE_GOOGLE") ? { clientId: required(env, "JARVIS_GOOGLE_CLIENT_ID"), clientSecret: env.JARVIS_GOOGLE_CLIENT_SECRET, redirectUri: new URL("/v1/cloud/integrations/google/callback", origin).href } : undefined,
      twilio: integrationEnabled && yes(env, "JARVIS_ENABLE_PHONE") ? { accountSid: required(env, "JARVIS_TWILIO_ACCOUNT_SID"), authToken: required(env, "JARVIS_TWILIO_AUTH_TOKEN"), fromNumber: required(env, "JARVIS_TWILIO_FROM_NUMBER"), ownerNumber: required(env, "JARVIS_OWNER_PHONE_NUMBER"), publicBaseUrl: origin, timeZone: timezone } : undefined,
      speech: integrationEnabled && yes(env, "JARVIS_ENABLE_PHONE") ? new ExistingVoiceSpeechAdapter({ url: "ws://127.0.0.1:39202/v1/voice/stream", token: localToken }) : undefined,
      approvalAuthority: { async run(effect, execute) {
        if (canonicalJson(approvedEffect.getStore()) !== canonicalJson(effect)) throw new BridgeError("Existing exact execution authority required.", 403);
        return execute();
      } },
      hooks: {
        async onStop() { await stopWork(false); },
        onTelegramMessage: message => conversations.onTelegramMessage(message),
        async digest() { return `Your Jarvis status and pending reviews are ready: ${origin}/v1/cloud/review`; },
        authorizeDisclosure(input) { return control.authorizeDisclosure(input); },
        authorizeCallOutreach(input) { return control.authorizeDisclosure({ ...input, channel: "phone", proactive: true }); },
        readObjective: ({ objectiveId, projectId }) => objective(objectiveId, projectId),
        onVerifiedCallTranscript: input => conversations.onVerifiedCallTranscript(input),
      },
    });
  } catch (error) { await control.close(); throw error; }
  function owner(request: IncomingMessage, deviceAllowed = false) {
    const bearer = request.headers.authorization;
    if (deviceAllowed && bearer?.startsWith("Bearer ")) return control.authenticateDevice(bearer.slice(7));
    const cookie = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("__Host-jarvis_cloud="));
    return control.authenticateOwner(cookie?.slice("__Host-jarvis_cloud=".length));
  }
  const gateway = createCloudGateway(control, { async routeExtension(request, response, url) {
    const path = url.pathname, method = request.method ?? "GET";
    const conversationRoute = /^\/v1\/cloud\/conversations(?:\/([A-Za-z0-9_-]+))?$/.exec(path);
    if (conversationRoute && ["GET", "POST"].includes(method)) {
      owner(request, true);
      if (method === "POST" && conversationRoute[1]) throw new BridgeError("Invalid conversation route.", 404);
      const input = method === "POST" ? z.strictObject({ title: z.string().max(120).optional(), projectId: z.string() }).parse(await body(request)) : { ...(conversationRoute[1] ? { id: conversationRoute[1] } : {}), ...(url.searchParams.has("projectId") ? { projectId: url.searchParams.get("projectId")! } : {}) };
      json(response, method === "POST" ? 201 : 200, await rpc("conversations", { method, ...input })); return true;
    }
    const questionRoute = /^\/v1\/cloud\/tasks\/([A-Za-z0-9_-]+)\/respond$/.exec(path);
    if (questionRoute && method === "POST") {
      owner(request, true); const input = z.strictObject({ interactionId: z.string(), expectedRevision: z.number().int().positive(), optionId: z.string().max(100).optional(), text: z.string().min(1).max(4000).optional() }).parse(await body(request));
      json(response, 200, await rpc("respond_question", { taskId: questionRoute[1], ...input })); return true;
    }
    const taskRoute = /^\/v1\/cloud\/tasks(?:\/([A-Za-z0-9_-]+))?$/.exec(path);
    if (taskRoute && ["GET", "POST"].includes(method)) {
      owner(request, true);
      if (method === "GET" && !taskRoute[1] || method === "POST" && taskRoute[1]) throw new BridgeError("Invalid task route.", 404);
      const input = method === "POST" ? z.strictObject({ message: z.string().min(1).max(16000), conversationId: z.string(), projectId: z.string() }).parse(await body(request)) : { id: taskRoute[1] };
      const task = await rpc("tasks", { method, ...input });
      if (task.status === "waiting") for (const approval of task.approvals ?? []) {
        if (approval.kind !== "approval" || !approval.reviewable || !approval.options?.some((option: { id: string }) => option.id === "approve")) continue;
        await control.createActionProposal({ projectId: task.projectId ?? (input as { projectId?: string }).projectId, deviceId: "cloud-runtime", ref: { taskId: task.id, interactionId: approval.id, revision: approval.revision, optionId: "approve" } }).catch(() => {});
      }
      json(response, method === "POST" ? 202 : 200, { ...task, remoteReviewUrl: `${origin}/v1/cloud/review` }); return true;
    }
    if (path === "/v1/cloud/objectives" || path.startsWith("/v1/cloud/objectives/")) {
      owner(request, true); const result = await rpc("objectives", { method, path: path.replace("/v1/cloud/", "/v1/") + url.search, ...(method === "GET" ? {} : { body: await body(request) }) });
      json(response, result.status, result.body); return true;
    }
    if (path === "/v1/cloud/setup/status" && method === "GET") { owner(request, true); json(response, 200, { ...integrations.status(), runtime: await rpc("readiness") }); return true; }
    if (path.startsWith("/v1/cloud/setup/integrations/")) {
      owner(request, true); json(response, 200, await integrations.setup(method, path.replace("/v1/cloud/setup/", "/v1/"), method === "GET" ? (url.searchParams.has("projectId") ? { projectId: url.searchParams.get("projectId") } : undefined) : await body(request))); return true;
    }
    if (path === "/v1/cloud/stop" && method === "POST") { owner(request, true); await stopWork(); json(response, 200, { version: 1, stopped: true }); return true; }
    if (path === "/v1/cloud/resume" && method === "POST") {
      const actor = owner(request, true); await resumeWork(actor);
      json(response, 200, { version: 1, resumed: true }); return true;
    }
    if (path === "/v1/cloud/resume-outreach" && method === "POST") { const actor = owner(request); await resumeWork(actor, true); json(response, 200, { version: 1, resumed: true }); return true; }
    return integrations.route(request, response, url);
  } });
  async function privateRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!url.pathname.startsWith("/v1/cloud/runtime/")) return false;
    if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
        !bearerTokenMatches(`Bearer ${request.headers["x-jarvis-cloud-runtime-token"] ?? ""}`, runtimeToken) || request.headers.origin || request.method !== "POST") throw new BridgeError("Private runtime authentication required.", 403);
    const input = await body(request);
    if (url.pathname === "/v1/cloud/runtime/retained") { const parsed = z.strictObject({ projectId: z.string(), processor: z.literal("context") }).parse(input); json(response, 200, { version: 1, snapshots: control.readSnapshots(parsed.projectId, parsed.processor) }); return true; }
    if (url.pathname === "/v1/cloud/runtime/retained/authorize") {
      const parsed = z.strictObject({ projectId: z.string(), processor: z.literal("context"), references: z.array(z.strictObject({ grantId: z.string(), grantRevision: z.number().int().positive(), kind: z.enum(["source", "memory"]), id: z.string(), revision: z.number().int().positive(), sha256: z.string() })).max(64) }).parse(input);
      json(response, 200, { version: 1, authorized: parsed.references.every(ref => control.authorizeSnapshot(ref, parsed.projectId, parsed.processor)) }); return true;
    }
    if (url.pathname === "/v1/cloud/runtime/google-context") {
      const parsed = z.strictObject({ projectId: z.string() }).parse(input);
      json(response, 200, integrations.google?.readGoogleContext(parsed.projectId) ?? { version: 1, entries: [] }); return true;
    }
    if (url.pathname === "/v1/cloud/runtime/google-context/authorize") {
      const parsed = z.strictObject({ projectId: z.string(), references: z.array(z.strictObject({ id: z.string(), sourceRevision: z.string() })).max(64) }).parse(input);
      json(response, 200, { version: 1, authorized: parsed.references.every(ref => integrations.google?.authorizeGoogleContext(ref, parsed.projectId) === true) }); return true;
    }
    if (url.pathname === "/v1/cloud/runtime/google/execute") {
      if (!integrations.google) throw new BridgeError("Google is disabled.", 503);
      const parsed = z.strictObject({ input: z.unknown(), approvalId: z.string(), projectId: z.string(), digest: z.string(), exactArguments: z.string() }).parse(input);
      const prepared = integrations.google.prepareGoogleAction(parsed.input);
      if (prepared.input.projectId !== parsed.projectId || prepared.digest !== parsed.digest || prepared.exactArguments !== parsed.exactArguments) throw new BridgeError("Approved Google action changed.", 403);
      const effect: ApprovedEffect = { approvalId: parsed.approvalId, projectId: parsed.projectId, kind: prepared.input.kind, digest: prepared.digest, exactArguments: prepared.exactArguments };
      json(response, 200, await approvedEffect.run(effect, () => integrations.google!.executeGoogleAction(prepared, parsed.approvalId))); return true;
    }
    throw new BridgeError("Private runtime route not found.", 404);
  }
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try { const url = new URL(request.url ?? "/", origin); if (!await privateRoute(request, response, url)) await gateway.handler(request, response); }
      catch (error) { if (!response.headersSent) json(response, error instanceof BridgeError ? error.status : 400, { error: error instanceof BridgeError ? error.message : "Cloud request failed validation or configuration." }); else response.destroy(); }
    })();
  };
  let timer: NodeJS.Timeout | undefined, tickActive = false;
  async function notifyObjectives() {
    if (tickActive || !integrations.telegram?.paired() || integrations.status().stopped) return; tickActive = true;
    try {
      await conversations.notifyPending();
      const after = integrations.readCursor<number>("objectives") ?? 0;
      let result;
      try { result = await rpc("objectives", { method: "GET", path: `/v1/objectives/events?projectId=${encodeURIComponent(projectId)}&after=${after}` }); }
      catch (error) {
        if (!(error instanceof BridgeError) || error.status !== 409) throw error;
        const snapshot = await rpc("objectives", { method: "GET", path: `/v1/objectives?projectId=${encodeURIComponent(projectId)}` });
        result = { body: { sequence: snapshot.body.sequence, events: snapshot.body.objectives.map((item: { id: string; projectId: string; revision: number; status: string; updatedAt: string }) => ({ objectiveId: item.id, projectId: item.projectId, revision: item.revision, status: item.status, at: item.updatedAt })) } };
      }
      for (const event of result.body.events) {
        if (!["completed", "failed", "waiting_for_user", "waiting_for_device"].includes(event.status)) continue;
        const current = await objective(event.objectiveId, event.projectId);
        const notificationId = `objective-${current.id}-${current.revision}`;
        if (integrations.telegram!.outbox().some(item => item.id === notificationId)) continue;
        const allowed = control.authorizeDisclosure({ projectId: current.projectId, channel: "telegram", destinationId: env.JARVIS_TELEGRAM_OWNER_CHAT_ID ?? "", proactive: true });
        const question = current.question ? { objectiveId: current.id, questionId: current.question.id, revision: current.question.revision, expiresAt: current.question.expiresAt } : null;
        integrations.telegram!.enqueue({ id: notificationId, projectId: current.projectId, objectiveId: current.id, kind: question ? "question" : "routine",
          text: allowed ? `${current.title}: ${current.status.replaceAll("_", " ")}.${question ? ` ${current.question!.prompt}` : ""}\n${origin}/v1/cloud/review` : `Jarvis has ${question ? "a question" : "a status update"}. ${origin}/v1/cloud/review`,
          question, disclosure: allowed ? "project_details" : "minimal", notBefore: current.updatedAt });
      }
      integrations.writeCursor("objectives", result.body.sequence);
      if (integrations.twilio) {
        const snapshot = await rpc("objectives", { method: "GET", path: `/v1/objectives?projectId=${encodeURIComponent(projectId)}` });
        for (const candidate of snapshot.body.objectives) await integrations.considerObjectiveCall(candidate);
      }
    } finally { tickActive = false; }
  }
  return { control, integrations, handler, upgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
    const url = new URL(request.url ?? "/", origin);
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) { socket.destroy(); return; }
    if (!integrations.upgrade(request, socket, head, url)) gateway.upgrade(request, socket, head);
  },
    start() { if (integrations.enabled) { integrations.start(); timer = setInterval(() => { void notifyObjectives().catch(() => {}); }, 5000); timer.unref(); } },
    async close() { if (timer) clearInterval(timer); await integrations.close(); await gateway.close(); await control.close(); },
  };
}

export async function startCloudGateway() {
  const host = process.env.JARVIS_CLOUD_HOST ?? "127.0.0.1", port = Number(process.env.JARVIS_CLOUD_PORT ?? 39300);
  if (host !== "127.0.0.1" || port !== 39300) throw new Error("Cloud gateway must use private 127.0.0.1:39300 behind Caddy.");
  const app = await createCloudApplication({});
  const server = createServer(app.handler); server.on("upgrade", app.upgrade);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); app.start();
  return { server, async close() { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startCloudGateway().then(runtime => {
    process.stdout.write("Jarvis private cloud gateway listening on 127.0.0.1:39300\n");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runtime.close().then(() => { process.exitCode = 0; }); });
  }).catch(() => { process.stderr.write("Cloud gateway startup failed. Verify cloud profile, origin, private credentials and enabled integrations.\n"); process.exitCode = 1; });
}
