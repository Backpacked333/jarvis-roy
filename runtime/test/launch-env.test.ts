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
  for (const target of ["ui", "runtime", "bridge"]) {
    const context = environmentFor(target, { JARVIS_ENABLE_MEMORY: "1", JARVIS_ENABLE_SEMANTIC_RETRIEVAL: "1" });
    assert.equal(context.JARVIS_ENABLE_MEMORY, "1");
    assert.equal(context.JARVIS_ENABLE_SEMANTIC_RETRIEVAL, "1");
    assert.equal(environmentFor(target, {}).JARVIS_ENABLE_MEMORY, undefined);
  }
  assert.throws(() => environmentFor("unknown", source));
});

test("launcher uses filtered environments and the absolute bundled helper", async () => {
  const script = await readFile(new URL("../../scripts/run-macos.sh", import.meta.url), "utf8");
  assert.match(script, /JARVIS_NATIVE_HELPER="\$ROOT\/dist\/Jarvis.app\/Contents\/Helpers\/JarvisControl.app\/Contents\/MacOS\/JarvisControl"/);
  for (const target of ["ui", "runtime", "bridge"]) assert.ok(script.includes(`launch-env.mjs" ${target}`));
});

test("model selection reaches both trusted services but not the native UI", () => {
  const source = { JARVIS_MODEL: "openai/gpt-6-sol-fast" };
  assert.equal(environmentFor("runtime", source).JARVIS_MODEL, source.JARVIS_MODEL);
  assert.equal(environmentFor("bridge", source).JARVIS_MODEL, source.JARVIS_MODEL);
  assert.equal(environmentFor("ui", source).JARVIS_MODEL, undefined);
});

test("native authority is unavailable to Eve while managed transport trust reaches backend services", () => {
  const source = { JARVIS_NATIVE_TOKEN: "fixture-native-authority", JARVIS_ENABLE_ASSISTANT: "1",
    HTTPS_PROXY: "http://fixture-proxy:8080", NODE_EXTRA_CA_CERTS: "/fixture/ca.pem", NODE_USE_ENV_PROXY: "1" };
  assert.equal(environmentFor("runtime", source).JARVIS_NATIVE_TOKEN, undefined);
  assert.equal(environmentFor("bridge", source).JARVIS_NATIVE_TOKEN, source.JARVIS_NATIVE_TOKEN);
  assert.equal(environmentFor("ui", source).JARVIS_NATIVE_TOKEN, source.JARVIS_NATIVE_TOKEN);
  for (const target of ["runtime", "bridge"]) {
    assert.equal(environmentFor(target, source).HTTPS_PROXY, source.HTTPS_PROXY);
    assert.equal(environmentFor(target, source).NODE_EXTRA_CA_CERTS, source.NODE_EXTRA_CA_CERTS);
    assert.equal(environmentFor(target, source).NODE_USE_ENV_PROXY, "1");
  }
  assert.equal(environmentFor("ui", source).HTTPS_PROXY, undefined);
});

test("native permission disclosures distinguish local wake detection from cloud transcription", async () => {
  const plist = await readFile(new URL("../../macos/Info.plist", import.meta.url), "utf8");
  const usage = (key: string) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1] ?? "";
  const microphone = usage("NSMicrophoneUsageDescription");
  assert.match(microphone, /local wake detection/);
  assert.match(microphone, /Cloud voice consent/);
  assert.match(microphone, /command audio is sent to ElevenLabs/);
  assert.match(microphone, /Hands-free is a separate opt-in/);
  const speech = usage("NSSpeechRecognitionUsageDescription");
  assert.match(speech, /on-device speech recognition only to detect Hey Jarvis/);
  assert.match(speech, /Command transcription uses ElevenLabs/);
});

test("backend-only tuning reaches both services and never the native UI", () => {
  const source = { JARVIS_CONTEXT_WINDOW_TOKENS: "128000", JARVIS_E5_MODEL_DIR: "/fixture/e5", JARVIS_ENABLE_OBJECTIVES: "1", JARVIS_RUNTIME_PROFILE: "cloud" };
  for (const target of ["runtime", "bridge"]) {
    const context = environmentFor(target, source);
    assert.equal(context.JARVIS_CONTEXT_WINDOW_TOKENS, "128000");
    assert.equal(context.JARVIS_E5_MODEL_DIR, target === "bridge" ? "/fixture/e5" : undefined);
    assert.equal(context.JARVIS_ENABLE_OBJECTIVES, "1");
    // The Mac launcher always runs the local profile; the cloud host has its own launcher.
    assert.equal(context.JARVIS_RUNTIME_PROFILE, undefined);
  }
  const ui = environmentFor("ui", source);
  assert.equal(ui.JARVIS_CONTEXT_WINDOW_TOKENS, undefined);
  assert.equal(ui.JARVIS_E5_MODEL_DIR, undefined);
});
