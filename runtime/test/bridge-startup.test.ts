import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startJarvisBridge, shutdownBridge } from "../bridge/server.ts";

test("actual bridge startup honors the objectives feature flag without provider credentials", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-actual-startup-")), saved = { ...process.env };
  const keys = new Set([...Object.keys(process.env).filter(key => key.startsWith("JARVIS_ENABLE_")), "JARVIS_ENABLE_OBJECTIVES", "JARVIS_LOCAL_TOKEN", "JARVIS_NATIVE_TOKEN",
    "JARVIS_DATA_DIR", "JARVIS_RUNTIME_PROFILE", "JARVIS_WORKER_IMAGE", "JARVIS_DOCKER_BINARY", "AI_GATEWAY_API_KEY", "ELEVENLABS_API_KEY", "TAVILY_API_KEY"]);
  t.after(async () => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } await rm(directory, { recursive: true, force: true }); });
  for (const key of keys) delete process.env[key];
  process.env.JARVIS_DATA_DIR = directory; process.env.JARVIS_RUNTIME_PROFILE = "local";
  process.env.JARVIS_LOCAL_TOKEN = "actual-startup-local-fixture-token-32-characters";
  process.env.JARVIS_NATIVE_TOKEN = "actual-startup-native-fixture-token-32-characters";
  process.env.JARVIS_DOCKER_BINARY = "jarvis-fixture-no-docker";
  for (const enabled of [false, true]) {
    process.env.JARVIS_ENABLE_OBJECTIVES = enabled ? "1" : "0";
    const server = await startJarvisBridge({ port: 0 });
    try {
      if (!server.listening) await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const response: Response = await fetch(base + "/v1/objectives/readiness", { headers: { authorization: `Bearer ${process.env.JARVIS_LOCAL_TOKEN}`, "x-jarvis-native-token": process.env.JARVIS_NATIVE_TOKEN }, signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200); const readiness = await response.json();
      assert.equal(readiness.enabled, enabled); assert.equal(readiness.ready, enabled);
    } finally { await shutdownBridge(server); }
  }
});
