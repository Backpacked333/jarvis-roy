import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createCloudApplication } from "../bridge/cloud-main.ts";

test("cloud composition routes paired objectives to the single runtime and never exposes private brokers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-cloud-app-"));
  const runtimeToken = randomBytes(32).toString("base64url"), bootstrap = randomBytes(32).toString("base64url");
  const seen: unknown[] = [];
  const app = await createCloudApplication({ dataDirectory: directory, env: {
    JARVIS_ENABLE_CLOUD: "1", JARVIS_RUNTIME_PROFILE: "cloud", JARVIS_CLOUD_ORIGIN: "https://jarvis.example",
    JARVIS_LOCAL_TOKEN: randomBytes(32).toString("base64url"), JARVIS_CLOUD_RUNTIME_TOKEN: runtimeToken, JARVIS_CLOUD_BOOTSTRAP_TOKEN: bootstrap,
  }, rpc: async (operation, payload) => { seen.push({ operation, payload }); return { status: 200, body: { version: 1, objectives: [] } }; } });
  const server = createServer(app.handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
  const request = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: address.port, path, method: init.method ?? "GET", headers: { host: "jarvis.example", ...init.headers as Record<string, string> } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
    }); req.on("error", reject); req.end(init.body as string | undefined);
  });
  try {
    assert.equal((await request("/v1/cloud/health")).status, 200);
    assert.equal((await request("/v1/cloud/objectives")).status, 401);
    assert.equal(seen.length, 0);
    const pairing = await app.control.startPairing({ deviceId: "mac", label: "Mac" }, bootstrap);
    const paired = await app.control.completePairing({ pairingId: pairing.pairingId, deviceId: "mac" }, pairing.pairingToken);
    const authorized = await request("/v1/cloud/objectives?projectId=project", { headers: { authorization: `Bearer ${paired.deviceToken}` } });
    assert.equal(authorized.status, 200); assert.deepEqual(await authorized.json(), { version: 1, objectives: [] });
    assert.deepEqual(seen[0], { operation: "objectives", payload: { method: "GET", path: "/v1/objectives?projectId=project" } });
    const payload = JSON.stringify({ projectId: "project", processor: "context" });
    assert.equal((await request("/v1/cloud/runtime/retained", { method: "POST", body: payload, headers: { authorization: `Bearer ${paired.deviceToken}`, "content-type": "application/json" } })).status, 403);
    const retained = await request("/v1/cloud/runtime/retained", { method: "POST", body: payload, headers: { "x-jarvis-cloud-runtime-token": runtimeToken, "content-type": "application/json" } });
    assert.equal(retained.status, 200); assert.deepEqual(await retained.json(), { version: 1, snapshots: [] });
    assert.equal((await request("/v1/cloud/runtime/retained", { method: "POST", body: payload, headers: { "x-jarvis-cloud-runtime-token": runtimeToken, origin: "https://jarvis.example" } })).status, 403);
    assert.equal((await request("/v1/cloud/objectives", { method: "POST", body: "{}", headers: { authorization: `Bearer ${paired.deviceToken}`, origin: "https://attacker.example", "content-type": "application/json" } })).status, 403);
    assert.equal((await request("/v1/tasks")).status, 404);
    assert.equal((await request("/v1/cloud/setup/status", { headers: { authorization: `Bearer ${paired.deviceToken}` } })).status, 200);
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
