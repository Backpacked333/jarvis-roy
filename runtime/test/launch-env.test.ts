import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The launch module is JavaScript so it runs before any project transpilation.
const { environmentFor } = await import(new URL("../../scripts/launch-env.mjs", import.meta.url).href);

test("native launch allows only minimal OS context and ephemeral loopback credential", () => {
  const source = { HOME: "/fixture", TMPDIR: "/fixture/tmp", JARVIS_LOCAL_TOKEN: "fixture-local", AI_GATEWAY_API_KEY: "fixture-gateway",
    TAVILY_API_KEY: "fixture-tavily", HOME_ASSISTANT_TOKEN: "fixture-home", JARVIS_ENABLE_TERMINAL: "1", RANDOM_SECRET: "fixture-secret",
    NODE_OPTIONS: "--inspect", DYLD_INSERT_LIBRARIES: "/fixture/injection", PATH: "/untrusted" };
  const ui = environmentFor("ui", source);
  assert.deepEqual(ui, { HOME: "/fixture", TMPDIR: "/fixture/tmp", JARVIS_LOCAL_TOKEN: "fixture-local", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" });
  const runtime = environmentFor("runtime", source);
  assert.equal(runtime.AI_GATEWAY_API_KEY, source.AI_GATEWAY_API_KEY);
  assert.equal(runtime.TAVILY_API_KEY, source.TAVILY_API_KEY);
  assert.equal(runtime.JARVIS_ENABLE_TERMINAL, "1");
  assert.equal(runtime.HOST, "127.0.0.1");
  assert.equal(runtime.PORT, "39201");
  for (const key of ["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "RANDOM_SECRET"]) assert.equal(runtime[key], undefined);
  assert.equal(environmentFor("bridge", source).AI_GATEWAY_API_KEY, source.AI_GATEWAY_API_KEY);
  const voice = { ELEVENLABS_API_KEY: "fixture-eleven", ELEVENLABS_VOICE_ID: "fixture-voice" };
  assert.equal(environmentFor("bridge", voice).ELEVENLABS_API_KEY, voice.ELEVENLABS_API_KEY);
  assert.equal(environmentFor("runtime", voice).ELEVENLABS_API_KEY, undefined);
  assert.equal(environmentFor("ui", voice).ELEVENLABS_API_KEY, undefined);
  assert.equal(environmentFor("runtime", {}).JARVIS_ENABLE_DESKTOP, undefined);
  assert.throws(() => environmentFor("unknown", source));
});

test("launcher uses filtered environments and the absolute bundled helper", async () => {
  const script = await readFile(new URL("../../scripts/run-macos.sh", import.meta.url), "utf8");
  assert.match(script, /JARVIS_NATIVE_HELPER="\$ROOT\/dist\/Jarvis.app\/Contents\/Helpers\/JarvisControl.app\/Contents\/MacOS\/JarvisControl"/);
  for (const target of ["ui", "runtime", "bridge"]) assert.ok(script.includes(`launch-env.mjs" ${target}`));
});
