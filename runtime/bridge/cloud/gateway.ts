import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { BridgeError } from "../errors.ts";
import { CloudControlPlane, type CloudActor } from "./control.ts";
import { CloudId } from "./contracts.ts";
import { cloudReviewCss, cloudReviewHtml, cloudReviewJs } from "./web.ts";

export interface CloudRouteReply { status: number; body: unknown }
export interface CloudGatewayOptions {
  /** Only explicit cloud routes. The extension must authenticate its own provider callbacks. */
  routeExtension?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
}
const VerificationSchema = z.strictObject({ challengeId: CloudId, response: z.record(z.string(), z.unknown()) });
const mutation = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method);
const token = (request: IncomingMessage) => { const header = request.headers.authorization; return typeof header === "string" && /^Bearer [A-Za-z0-9_-]+$/.test(header) ? header.slice(7) : undefined; };

export function createCloudGateway(control: CloudControlPlane, options: CloudGatewayOptions = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  const expiryTimer = setInterval(() => { void control.purgeExpired().catch(() => {}); }, 60_000); expiryTimer.unref();
  const rates = new Map<string, { since: number; count: number }>();
  const secure = control.publicOrigin.startsWith("https:"), cookieName = secure ? "__Host-jarvis_cloud" : "jarvis_cloud_test";
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...(secure ? { "strict-transport-security": "max-age=31536000" } : {}) };
  function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }
  function owner(request: IncomingMessage) {
    const cookies = request.headers.cookie?.split(";").map(value => value.trim()) ?? [], cookie = cookies.find(value => value.startsWith(`${cookieName}=`));
    return control.authenticateOwner(cookie?.slice(cookieName.length + 1));
  }
  function actor(request: IncomingMessage): CloudActor { return token(request) ? control.authenticateDevice(token(request)) : owner(request); }
  async function body(request: IncomingMessage): Promise<unknown> {
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) throw new BridgeError("JSON request required.", 415);
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += Buffer.byteLength(chunk); if (length > 2 * 1024 * 1024) throw new BridgeError("Request too large.", 413); chunks.push(Buffer.from(chunk)); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new BridgeError("Invalid JSON.", 400); }
  }
  function origin(request: IncomingMessage, path: string) {
    if (mutation(request.method ?? "GET") && request.headers.origin !== undefined && request.headers.origin !== control.publicOrigin) throw new BridgeError("Cross-origin request denied.", 403);
    if (mutation(request.method ?? "GET") && !token(request) && !request.headers["x-jarvis-enrollment-token"] && !path.startsWith("/v1/cloud/integrations/") && request.headers.origin !== control.publicOrigin) throw new BridgeError("Same-origin browser request required.", 403);
  }
  function limited(request: IncomingMessage) {
    const key = request.socket.remoteAddress ?? "unknown", now = Date.now();
    if (rates.size > 1000) for (const [key, entry] of rates) if (now - entry.since > 60_000) rates.delete(key);
    const entry = rates.get(key); if (!entry || now - entry.since >= 60_000) { rates.set(key, { since: now, count: 1 }); return; }
    if (++entry.count > 30) throw new BridgeError("Too many authentication requests.", 429);
  }
  async function route(request: IncomingMessage, response: ServerResponse) {
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new BridgeError("Unknown cloud route.", 404);
    const url = new URL(request.url, control.publicOrigin), path = url.pathname, method = request.method ?? "GET";
    if (!path.startsWith("/v1/cloud/")) throw new BridgeError("Unknown cloud route.", 404);
    if (path === "/v1/cloud/health" && method === "GET") { const state = control.health(); json(response, state.status === "ready" ? 200 : 503, state); return; }
    const expectedHost = new URL(control.publicOrigin).host;
    if (request.headers.host !== expectedHost) throw new BridgeError("Unexpected public gateway host.", 421);
    origin(request, path);
    if (path.startsWith("/v1/cloud/integrations/") && options.routeExtension && await options.routeExtension(request, response, url)) return;
    if (method === "GET" && ["/v1/cloud/review", "/v1/cloud/enroll", "/v1/cloud/review.js", "/v1/cloud/review.css"].includes(path)) {
      const js = path.endsWith(".js"), css = path.endsWith(".css");
      response.writeHead(200, { ...headers, "content-type": js ? "application/javascript; charset=utf-8" : css ? "text/css; charset=utf-8" : "text/html; charset=utf-8" }); response.end(js ? cloudReviewJs : css ? cloudReviewCss : cloudReviewHtml); return;
    }
    if (path === "/v1/cloud/session" && method === "GET") { owner(request); json(response, 200, { version: 1, authenticated: true }); return; }
    if (path === "/v1/cloud/overview" && method === "GET") { const identity = owner(request); await control.reconcileLocalExecutions(identity); json(response, 200, control.overview(identity)); return; }
    if (path === "/v1/cloud/logout" && method === "POST") { await control.logout(owner(request)); response.setHeader("set-cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`); json(response, 200, { version: 1, signedOut: true }); return; }
    if (path === "/v1/cloud/pairing/start" && method === "POST") { limited(request); json(response, 201, await control.startPairing(await body(request), token(request))); return; }
    if (path === "/v1/cloud/pairing/complete" && method === "POST") { limited(request); json(response, 201, await control.completePairing(await body(request), token(request))); return; }
    if (path === "/v1/cloud/enrollment/start" && method === "POST") { json(response, 201, await control.startEnrollment(actor(request))); return; }
    if (path === "/v1/cloud/device/actions" && method === "POST") { json(response, 201, await control.offerAction(control.authenticateDevice(token(request)), await body(request))); return; }
    if (path === "/v1/cloud/webauthn/registration/options" && method === "POST") {
      limited(request); const invitation = request.headers["x-jarvis-enrollment-token"];
      if (typeof invitation !== "string") throw new BridgeError("Native enrollment required.", 403);
      json(response, 200, await control.registrationOptions(invitation)); return;
    }
    if (path === "/v1/cloud/webauthn/registration/verify" && method === "POST") {
      limited(request); const invitation = request.headers["x-jarvis-enrollment-token"];
      if (typeof invitation !== "string") throw new BridgeError("Native enrollment required.", 403);
      const data = VerificationSchema.parse(await body(request)); json(response, 200, await control.finishRegistration(invitation, data.challengeId, data.response as unknown as RegistrationResponseJSON)); return;
    }
    if (path === "/v1/cloud/webauthn/authentication/options" && method === "POST") { limited(request); json(response, 200, await control.authenticationOptions()); return; }
    if (path === "/v1/cloud/webauthn/authentication/verify" && method === "POST") {
      limited(request); const data = VerificationSchema.parse(await body(request)), result = await control.finishAuthentication(data.challengeId, data.response as unknown as AuthenticationResponseJSON);
      response.setHeader("set-cookie", `${cookieName}=${result.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${secure ? "; Secure" : ""}`);
      json(response, 200, { version: 1, authenticated: true, expiresAt: result.expiresAt }); return;
    }
    const action = /^\/v1\/cloud\/actions\/([A-Za-z0-9_-]+)(?:\/(options|verify))?$/.exec(path);
    if (action) {
      const identity = owner(request);
      if (method === "GET" && !action[2]) { await control.reconcileLocalExecutions(identity, action[1]); json(response, 200, control.proposal(action[1], identity)); return; }
      if (method === "POST" && action[2] === "options") { json(response, 200, await control.approvalOptions(action[1], identity)); return; }
      if (method === "POST" && action[2] === "verify") { const data = VerificationSchema.parse(await body(request)); json(response, 200, await control.finishApproval(action[1], data.challengeId, data.response as unknown as AuthenticationResponseJSON, identity)); return; }
    }
    const call = /^\/v1\/cloud\/calls\/(CA[0-9a-fA-F]{32})\/(options|verify)$/.exec(path);
    if (call && method === "POST") {
      const identity = owner(request);
      if (call[2] === "options") { json(response, 200, await control.callOptions(call[1], identity)); return; }
      const data = VerificationSchema.parse(await body(request)); json(response, 200, await control.finishCall(call[1], data.challengeId, data.response as unknown as AuthenticationResponseJSON, identity)); return;
    }
    if (path === "/v1/cloud/retention/grants") {
      const identity = actor(request);
      if (method === "GET") { json(response, 200, { version: 1, grants: control.listRetentionGrants(identity) }); return; }
      if (method === "POST") { json(response, 201, await control.createRetentionGrant(await body(request), identity)); return; }
    }
    const revokeGrant = /^\/v1\/cloud\/retention\/grants\/([A-Za-z0-9_-]+)\/revoke$/.exec(path);
    if (revokeGrant && method === "POST") { const identity = actor(request), data = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(await body(request)); json(response, 200, await control.revokeRetentionGrant(revokeGrant[1], data.expectedRevision, identity)); return; }
    if (path === "/v1/cloud/snapshots/sync" && method === "POST") { const identity = control.authenticateDevice(token(request)); json(response, 200, await control.syncSnapshots(await body(request), identity)); return; }
    if (path === "/v1/cloud/channel-policies" && method === "POST") { const identity = actor(request); json(response, 201, await control.createChannelPolicy(await body(request), identity)); return; }
    const revokePolicy = /^\/v1\/cloud\/channel-policies\/([A-Za-z0-9_-]+)\/revoke$/.exec(path);
    if (revokePolicy && method === "POST") { json(response, 200, await control.revokeChannelPolicy(revokePolicy[1], actor(request))); return; }
    const revokeDevice = /^\/v1\/cloud\/devices\/([A-Za-z0-9_-]+)\/revoke$/.exec(path);
    if (revokeDevice && method === "POST") { json(response, 200, await control.revokeDevice(revokeDevice[1], actor(request))); return; }
    if (options.routeExtension && await options.routeExtension(request, response, url)) return;
    throw new BridgeError("Unknown cloud route.", 404);
  }
  const handler = (request: IncomingMessage, response: ServerResponse) => { void route(request, response).catch(error => {
    const status = error instanceof BridgeError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
    const messages: Record<number, string> = { 400: "Request data is invalid.", 401: "Passkey sign-in required.", 403: "Request is not authorized.", 404: "Cloud route or resource not found.", 409: "State changed. Refresh and review again.", 413: "Request is too large.", 415: "JSON request required.", 421: "Unexpected gateway host.", 429: "Too many authentication requests.", 503: "Cloud control is unavailable. Reconcile its durable state." };
    if (!response.headersSent) json(response, status, { error: messages[status] ?? "Cloud request failed." }); else response.destroy();
  }); };
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(request.url ?? "/", control.publicOrigin);
      if (url.pathname !== "/v1/cloud/device/connect" || request.headers.host !== new URL(control.publicOrigin).host || request.headers.origin !== undefined) throw new BridgeError("Unknown device upgrade.", 403);
      const identity = control.authenticateDevice(token(request), url.searchParams.get("deviceId") ?? "");
      if (!url.searchParams.get("deviceId") || [...url.searchParams.keys()].some(key => key !== "deviceId")) throw new BridgeError("Invalid device identity.", 403);
      wss.handleUpgrade(request, socket, head, ws => {
        let generation: number | undefined; let ready = false;
        const send = (frame: unknown) => { const encoded = JSON.stringify(frame); if (Buffer.byteLength(encoded) > 384 * 1024 || ws.readyState !== WebSocket.OPEN) throw new Error("Device send unavailable"); ws.send(encoded); };
        void control.connectDevice(identity, send, () => ws.close(4001, "ownership changed")).then(welcome => { generation = welcome.generation; ready = true; }).catch(() => ws.close(4003, "device unavailable"));
        ws.on("message", (data, binary) => { if (!ready || binary) { ws.close(4003, "invalid frame"); return; }
          let parsed: unknown; try { parsed = JSON.parse(data.toString()); } catch { ws.close(4003, "invalid frame"); return; }
          void control.receiveDeviceFrame(identity, parsed).then(send).catch(() => ws.close(4003, "stale or invalid frame")); });
        ws.on("close", () => { if (generation !== undefined) control.disconnectDevice(identity.deviceId, generation); }); ws.on("error", () => {});
      });
    } catch { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); socket.destroy(); }
  };
  return { handler, upgrade, close: async () => { clearInterval(expiryTimer); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); } };
}
