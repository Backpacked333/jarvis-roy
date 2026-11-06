import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createBridgeServer, isDirectEntrypoint } from "../bridge/server.ts";
import { JarvisService } from "../bridge/service.ts";
import { FakeEveClient } from "./helpers.ts";

const TOKEN = "test-local-token-that-is-at-least-32-chars";

test("bridge entrypoint detection supports paths with spaces", () => {
  const entry = path.resolve("/checkout with spaces/runtime/bridge/server.ts");
  assert.equal(isDirectEntrypoint(pathToFileURL(entry).href, entry), true);
  assert.equal(isDirectEntrypoint("file:///different/path/server.ts", entry), false);
});

async function startServer() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "jarvis-server-"));
  const service = await JarvisService.create({
    client: new FakeEveClient(),
    dataDirectory,
    model: "test/model",
  });
  process.env.JARVIS_LOCAL_TOKEN = TOKEN;
  const server = createBridgeServer(service, "127.0.0.1", 0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

function requestWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      headers: { host, authorization: `Bearer ${TOKEN}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("bridge enforces bearer auth, Origin rejection, loopback Host, body limits, and routes", async (t) => {
  const server = await startServer();
  t.after(server.close);

  const unauthorized = await fetch(`${server.baseUrl}/v1/state`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "Unauthorized." });

  const originRejected = await fetch(`${server.baseUrl}/v1/state`, {
    headers: { authorization: `Bearer ${TOKEN}`, origin: "http://localhost" },
  });
  assert.equal(originRejected.status, 403);

  const badHost = await requestWithHost(`${server.baseUrl}/v1/state`, "attacker.example");
  assert.equal(badHost.status, 403);

  const wrongMethod = await fetch(`${server.baseUrl}/v1/state`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(wrongMethod.status, 405);

  const missingRoute = await fetch(`${server.baseUrl}/v1/not-a-route`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(missingRoute.status, 404);

  const missingContentType = await fetch(`${server.baseUrl}/v1/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  assert.equal(missingContentType.status, 415);

  const oversized = await fetch(`${server.baseUrl}/v1/tasks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "x".repeat(33_000) }),
  });
  assert.equal(oversized.status, 413);

  const state = await fetch(`${server.baseUrl}/v1/state`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(state.status, 200);
  assert.equal(state.headers.get("access-control-allow-origin"), null);
  assert.equal((await state.json() as { ready: boolean }).ready, true);
});
