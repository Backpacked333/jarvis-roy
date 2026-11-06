import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "eve/client";
import { getDataDirectory } from "../agent/lib/persistence.ts";
import { bearerTokenMatches, isValidLocalToken } from "../agent/lib/local-auth.ts";
import { BridgeError, errorMessage } from "./errors.ts";
import { redactText } from "./redaction.ts";
import { JarvisService } from "./service.ts";
import type { EveClient } from "./types.ts";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 39_202;
const MAX_BODY_BYTES = 32 * 1_024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    const hostname = parsed.hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.has(hostname) || parsed.username || parsed.password) return false;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    return !parsed.port || (Number(parsed.port) >= 1 && Number(parsed.port) <= 65_535);
  } catch {
    return false;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new BridgeError("Content-Type must be application/json.", 415);
  }
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    throw new BridgeError("Request body exceeds 32 KiB.", 413);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BODY_BYTES) throw new BridgeError("Request body exceeds 32 KiB.", 413);
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("Request body must be valid JSON.", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeError("Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BridgeError("Invalid path.", 404);
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  service: JarvisService,
): Promise<void> {
  const host = request.headers.host;
  const remoteAddress = request.socket.remoteAddress;
  if (!isLoopbackHost(host) || (remoteAddress && remoteAddress !== "127.0.0.1" &&
    remoteAddress !== "::ffff:127.0.0.1")) {
    json(response, 403, { error: "Loopback requests only." });
    return;
  }
  if (request.headers.origin !== undefined) {
    json(response, 403, { error: "Requests with an Origin header are not accepted." });
    return;
  }
  const token = process.env.JARVIS_LOCAL_TOKEN;
  if (!bearerTokenMatches(request.headers.authorization, token)) {
    json(response, 401, { error: "Unauthorized." });
    return;
  }

  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    json(response, 404, { error: "Not found." });
    return;
  }
  const method = request.method ?? "GET";
  try {
    if (pathname === "/v1/state") {
      if (method !== "GET") throw new BridgeError("Method not allowed.", 405);
      json(response, 200, await service.state());
      return;
    }
    if (pathname === "/v1/tasks") {
      if (method !== "POST") throw new BridgeError("Method not allowed.", 405);
      const body = await readJson(request);
      if (typeof body.message !== "string") {
        throw new BridgeError("message must be a string.", 400);
      }
      if (body.conversationId !== undefined && typeof body.conversationId !== "string") {
        throw new BridgeError("conversationId must be a string.", 400);
      }
      json(response, 202, await service.createTask(body.message, body.conversationId));
      return;
    }
    if (pathname === "/v1/conversations") {
      if (method !== "POST") throw new BridgeError("Method not allowed.", 405);
      const body = await readJson(request);
      if (body.title !== undefined && typeof body.title !== "string") {
        throw new BridgeError("title must be a string.", 400);
      }
      json(response, 201, await service.createConversation(body.title));
      return;
    }
    if (pathname === "/v1/stop") {
      if (method !== "POST") throw new BridgeError("Method not allowed.", 405);
      json(response, 200, { tasks: await service.stop() });
      return;
    }

    const taskAction = /^\/v1\/tasks\/([^/]+)\/(respond|cancel)$/.exec(pathname);
    if (taskAction) {
      const taskId = decodePathSegment(taskAction[1]);
      if (method !== "POST") throw new BridgeError("Method not allowed.", 405);
      if (taskAction[2] === "cancel") {
        json(response, 200, await service.cancel(taskId));
      } else {
        const body = await readJson(request);
        if (typeof body.interactionId !== "string" || typeof body.optionId !== "string") {
          throw new BridgeError("interactionId and optionId must be strings.", 400);
        }
        json(response, 200, await service.respond(taskId, body.interactionId, body.optionId));
      }
      return;
    }

    const memoryAction = /^\/v1\/memories\/([^/]+)$/.exec(pathname);
    if (memoryAction) {
      const id = decodePathSegment(memoryAction[1]);
      if (method !== "DELETE") throw new BridgeError("Method not allowed.", 405);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new BridgeError("Memory not found.", 404);
      }
      const deleted = await service.removeMemory(id);
      if (!deleted) throw new BridgeError("Memory not found.", 404);
      json(response, 200, { id, deleted: true });
      return;
    }
    throw new BridgeError("Not found.", 404);
  } catch (cause) {
    const status = cause instanceof BridgeError ? cause.status : 500;
    const message = cause instanceof BridgeError
      ? redactText(cause.message)
      : "Internal server error.";
    if (!response.headersSent) json(response, status, { error: message });
    else response.destroy();
  }
}

export function createBridgeServer(
  service: JarvisService,
  host = BRIDGE_HOST,
  port = BRIDGE_PORT,
): Server {
  return createServer((request, response) => {
    void route(request, response, service).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "Internal server error." });
      else response.destroy();
    });
  }).listen(port, host);
}

export function isDirectEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && moduleUrl === pathToFileURL(resolve(argvPath)).href;
}

function eveBaseUrl(value: string | undefined): string {
  const base = new URL(value ?? "http://127.0.0.1:39201");
  const hostname = base.hostname.toLowerCase();
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(hostname) ||
    base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("JARVIS_EVE_URL must be an HTTP loopback URL without a path or credentials.");
  }
  return base.origin;
}

export async function startJarvisBridge(): Promise<Server> {
  const token = process.env.JARVIS_LOCAL_TOKEN;
  if (!isValidLocalToken(token)) {
    throw new Error("JARVIS_LOCAL_TOKEN must contain at least 32 characters.");
  }
  const client = new Client({
    baseUrl: eveBaseUrl(process.env.JARVIS_EVE_URL),
    auth: { bearer: token },
    redirect: "error",
  }) as unknown as EveClient;
  const service = await JarvisService.create({
    client,
    dataDirectory: getDataDirectory(),
    model: process.env.JARVIS_MODEL ?? "openai/gpt-4.1-mini",
  });
  const server = createBridgeServer(service);
  server.on("listening", () => {
    process.stdout.write(`Jarvis bridge listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}\n`);
  });
  return server;
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  void startJarvisBridge().catch((cause) => {
    process.stderr.write(`${redactText(errorMessage(cause))}\n`);
    process.exitCode = 1;
  });
}
