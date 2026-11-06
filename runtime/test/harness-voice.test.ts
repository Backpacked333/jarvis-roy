import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { ClientOptions } from "ws";
import { createVoiceBridge, createVoiceBridgeWithTransport } from "../bridge/harness-voice/index.ts";
import { PCMQueue, TokenBucket } from "../bridge/harness-voice/limits.ts";
import { VoiceServerFrameSchema } from "../bridge/harness-contracts/voice.ts";
import type { VoiceBridgeOptions, VoiceServerFrame } from "../bridge/harness-contracts/voice.ts";

const context = { roomId: "room-a", conversationId: null, question: null };
const header = { version: 1, sessionId: "session-a", generation: 1 };
const start = { ...header, type: "start", cloudConsent: true, context };
const speak = { ...header, type: "speak", text: "A short voice fixture.", context, final: true };
const ready = { message_type: "session_started", config: { model_id: "scribe_v2_realtime", sample_rate: 16000, audio_format: "pcm_16000", commit_strategy: "manual" } };
const pcm = Buffer.alloc(8_000, 1).toString("base64");

async function until(predicate: () => boolean, message = "condition", timeout = 2_000): Promise<void> {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > end) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t: TestContext, options: VoiceBridgeOptions = { apiKey: "fixture-not-a-secret", voiceId: "fixture-voice" }, failedConnections = 0) {
  const provider = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: false });
  await once(provider, "listening");
  const providerPort = (provider.address() as { port: number }).port;
  const peers: WebSocket[] = [];
  const providerFrames: Record<string, unknown>[][] = [];
  provider.on("connection", (peer) => {
    peers.push(peer);
    const frames: Record<string, unknown>[] = [];
    providerFrames.push(frames);
    peer.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  });
  let time = 0;
  const connections: { url: string; options: ClientOptions }[] = [];
  const bridge = createVoiceBridgeWithTransport(options, {
    now: () => time,
    connect: (url, config) => {
      connections.push({ url, options: config });
      return new WebSocket(`ws://127.0.0.1:${connections.length <= failedConnections ? 1 : providerPort}`, config);
    },
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/voice/stream`;
  const client = new WebSocket(url);
  const frames: VoiceServerFrame[] = [];
  client.on("message", (raw) => frames.push(VoiceServerFrameSchema.parse(JSON.parse(raw.toString()))));
  await once(client, "open");
  t.after(async () => {
    client.terminate();
    await bridge.close();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { bridge, client, url, frames, peers, providerFrames, connections,
    advance: (ms: number) => { time += ms; },
    send: (value: unknown) => client.send(JSON.stringify(value)),
    async peer(index = 0) { await until(() => peers.length > index, "provider connect"); return peers[index]; },
    async frame(type: string) { await until(() => frames.some((frame) => frame.type === type), type); return frames.find((frame) => frame.type === type)!; },
  };
}

test("bounded PCM queue preserves exact sample bytes and clears on interrupt", () => {
  const queue = new PCMQueue(8);
  queue.push(Buffer.from([1, 2, 3, 4]));
  queue.push(Buffer.from([5, 6]));
  assert.throws(() => queue.push(Buffer.alloc(4)));
  assert.throws(() => queue.push(Buffer.alloc(1)));
  assert.deepEqual(queue.take(2), Buffer.from([1, 2]));
  assert.deepEqual(queue.take(8), Buffer.from([3, 4]));
  assert.deepEqual(queue.take(8), Buffer.from([5, 6]));
  assert.equal(queue.bytes, 0);
  queue.push(Buffer.alloc(8)); queue.clear();
  assert.equal(queue.take(8), undefined);
});

test("rate limiter has bounded burst and no clock rollback windfall", () => {
  const rate = new TokenBucket(2, 1, 0);
  assert.equal(rate.take(2, 0), true);
  assert.equal(rate.take(1, 0), false);
  assert.equal(rate.take(1, 1000), true);
  assert.equal(rate.take(1, 999), false);
});

test("no key or invalid voice visibly unavailable; no provider downgrade", async (t) => {
  for (const options of [{ voiceId: "fixture" }, { apiKey: "fixture", voiceId: "bad/voice" }]) {
    const f = await fixture(t, options);
    assert.equal(f.bridge.status().status, "unavailable");
    f.send(start);
    assert.equal((await f.frame("error")).type, "error");
    assert.equal(f.connections.length, 0);
  }
  const bridge = createVoiceBridge({});
  assert.equal(bridge.status().model, "eleven_v4_turbo");
  await bridge.close();
});

test("actual local sockets stream Scribe PCM; committed transcript retains captured room", async (t) => {
  const f = await fixture(t);
  f.send(start);
  const peer = await f.peer(); peer.send(JSON.stringify(ready));
  await until(() => f.frames.some((frame) => frame.type === "state" && frame.state === "listening"));
  assert.equal(f.bridge.status().status, "connected");
  const url = new URL(f.connections[0].url);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/v1/speech-to-text/realtime");
  assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(url.searchParams.get("commit_strategy"), "manual");
  assert.equal(url.href.includes("fixture-not-a-secret"), false);
  f.send({ ...header, type: "audio", sequence: 0, sampleRate: 16_000, pcm });
  f.send({ ...header, type: "commit" });
  await until(() => f.providerFrames[0].length === 2);
  assert.deepEqual(f.providerFrames[0][0], { message_type: "input_audio_chunk", audio_base_64: pcm, sample_rate: 16000, commit: false });
  assert.equal(f.providerFrames[0][1].commit, true);
  peer.send(JSON.stringify({ message_type: "partial_transcript", text: "yes" }));
  await until(() => f.frames.some((frame) => frame.type === "transcript" && !frame.final));
  peer.send(JSON.stringify({ message_type: "committed_transcript", text: "yes exactly" }));
  await until(() => f.frames.some((frame) => frame.type === "transcript" && frame.final));
  const final = f.frames.find((frame) => frame.type === "transcript" && frame.final);
  assert.deepEqual(final, { ...header, type: "transcript", text: "yes exactly", final: true, context });
  assert.equal(f.frames.some((frame) => JSON.stringify(frame).includes("fixture-not-a-secret")), false);
});

test("TTD registers exactly one voice, streams text and splits exact PCM with turn end", async (t) => {
  const f = await fixture(t);
  f.send({ ...speak, text: "First ", final: false });
  const peer = await f.peer();
  f.send({ ...speak, text: "second.", final: true });
  await until(() => f.providerFrames[0].length === 4);
  assert.deepEqual(f.providerFrames[0][0], { voices: ["fixture-voice"] });
  assert.deepEqual(f.providerFrames[0][1], { inputs: [{ text: "First ", voice_id: "fixture-voice", new_turn: true }], flush: false });
  assert.deepEqual(f.providerFrames[0][2], { inputs: [{ text: "second.", voice_id: "fixture-voice", new_turn: false }], flush: true });
  assert.deepEqual(f.providerFrames[0][3], { close_socket: true });
  assert.equal(f.connections[0].url, "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000");
  assert.deepEqual(f.connections[0].options.headers, { "xi-api-key": "fixture-not-a-secret" });
  const audio = Buffer.from(Array.from({ length: 18_000 }, (_, i) => i % 256));
  peer.send(JSON.stringify({ audio: audio.toString("base64") }));
  peer.send(JSON.stringify({ is_final_audio_for_turn: true }));
  peer.send(JSON.stringify({ is_final: true }));
  await f.frame("audio_end");
  const chunks = f.frames.filter((frame) => frame.type === "audio");
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.pcm, "base64"))), audio);
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), chunks.map((_, i) => i));
  assert.equal(chunks.every((chunk) => chunk.sampleRate === 24000 && Buffer.from(chunk.pcm, "base64").length <= 16000), true);
});

test("interrupt tears down output and queued audio; stale callbacks cannot restart it", async (t) => {
  const f = await fixture(t); f.send(speak);
  const peer = await f.peer();
  peer.send(JSON.stringify({ audio: Buffer.alloc(80_000).toString("base64") }));
  await f.frame("audio");
  f.send({ ...header, generation: 2, type: "interrupt" });
  await until(() => f.frames.some((frame) => frame.type === "state" && frame.state === "interrupted"));
  const marker = f.frames.length;
  await until(() => peer.readyState === WebSocket.CLOSED);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.frames.slice(marker).some((frame) => frame.type === "audio"), false);
  f.send({ ...start, generation: 3 });
  (await f.peer(1)).send(JSON.stringify(ready));
  await until(() => f.frames.some((frame) => frame.type === "state" && frame.state === "listening" && frame.generation === 3));
});

test("provider unsupported format, permission errors and malformed audio fail closed without echoing details", async (t) => {
  for (const payload of [
    { error: "model_not_found", message: "fixture-not-a-secret private text", code: 1008 },
    { audio: "not pcm!" }, { mystery: true },
  ]) {
    const f = await fixture(t); f.send(speak);
    (await f.peer()).send(JSON.stringify(payload));
    await f.frame("error");
    assert.equal(f.frames.some((frame) => JSON.stringify(frame).includes("fixture-not-a-secret")), false);
    assert.equal(f.connections.length, 1);
  }
  const f = await fixture(t); f.send(start);
  (await f.peer()).send(JSON.stringify({ ...ready, config: { ...ready.config, audio_format: "pcm_24000" } }));
  await f.frame("error");
});

test("two second PCM overflow is explicit and bounded", async (t) => {
  const f = await fixture(t); f.send(speak);
  (await f.peer()).send(JSON.stringify({ audio: Buffer.alloc(96_002).toString("base64") }));
  const frame = await f.frame("error");
  assert.equal(frame.type === "error" && frame.code, "overflow");
  assert.equal(f.frames.some((frame) => frame.type === "audio"), false);
});

test("gap/duplicate/wrong rate/consent/session and stale generation are rejected", async (t) => {
  for (const frame of [
    { ...header, type: "audio", sequence: 1, sampleRate: 16000, pcm },
    { ...header, type: "audio", sequence: 0, sampleRate: 24000, pcm },
    { ...start, cloudConsent: false }, { ...start, sessionId: "different-session", generation: 2 }, start,
  ]) {
    const f = await fixture(t); f.send(start);
    (await f.peer()).send(JSON.stringify(ready));
    await until(() => f.frames.some((value) => value.type === "state" && value.state === "listening"));
    f.send(frame); await f.frame("error");
  }
});

test("uncommitted provider finals are never dispatched", async (t) => {
  const f = await fixture(t); f.send(start);
  const peer = await f.peer(); peer.send(JSON.stringify(ready));
  peer.send(JSON.stringify({ message_type: "committed_transcript", text: "yes" }));
  await f.frame("error");
  assert.equal(f.frames.some((frame) => frame.type === "transcript" && frame.final), false);
});

test("disconnect after text submission never reconnects or replays", async (t) => {
  const f = await fixture(t); f.send(speak);
  const peer = await f.peer();
  await until(() => f.providerFrames[0].length >= 3);
  peer.terminate(); await f.frame("error");
  assert.equal(f.connections.length, 1);
});

test("keepalive, turn timeout and no capture after stop use real lifecycle", async (t) => {
  const f = await fixture(t); f.send({ ...speak, final: false });
  await f.peer(); await until(() => f.providerFrames[0].length >= 2);
  f.advance(10_001);
  await until(() => f.providerFrames[0].some((value) => value.keep_alive));
  f.advance(10_001); await f.frame("error");
  const g = await fixture(t); g.send(start); await g.peer();
  g.send({ ...header, generation: 2, type: "stop" });
  await until(() => g.frames.some((frame) => frame.type === "state" && frame.state === "idle"));
  g.send({ ...header, type: "audio", sequence: 0, sampleRate: 16000, pcm });
  await g.frame("error");
});

test("upgrade rejects origins, query credentials and excess connections", async (t) => {
  const f = await fixture(t);
  for (const [url, options] of [[f.url, { origin: "https://evil.example" }], [f.url + "?token=not-accepted", {}]] as const) {
    const denied = new WebSocket(url, options);
    denied.on("error", () => {});
    const [, response] = await once(denied, "unexpected-response");
    assert.equal(response.statusCode, 403); response.resume(); denied.terminate();
  }
  const second = new WebSocket(f.url); second.on("error", () => {}); await once(second, "open");
  const third = new WebSocket(f.url); third.on("error", () => {});
  const [, response] = await once(third, "unexpected-response");
  assert.equal(response.statusCode, 403); response.resume(); third.terminate(); second.terminate();
});

test("oversized and binary local frames close the connection", async (t) => {
  for (const binary of [true, false]) {
    const f = await fixture(t);
    const closed = once(f.client, "close");
    f.client.send(binary ? Buffer.alloc(4) : "x".repeat(32_769));
    await closed;
    assert.equal(f.connections.length, 0);
  }
});

test("only unopened provider handshakes retry, at most once, without replay", async (t) => {
  const f = await fixture(t, undefined, 1); f.send(speak);
  await f.peer();
  await until(() => f.providerFrames[0].length === 3);
  assert.equal(f.connections.length, 2);
  assert.equal(f.providerFrames[0].filter((frame) => frame.inputs).length, 1);
  const g = await fixture(t, undefined, 99); g.send(speak);
  await g.frame("error");
  assert.equal(g.connections.length, 2);
  assert.equal(g.peers.length, 0);
});

test("stop during pending retry does not reopen provider capture", async (t) => {
  const f = await fixture(t, undefined, 99); f.send(start);
  await until(() => f.connections.length === 1);
  f.send({ ...header, generation: 2, type: "stop" });
  await until(() => f.frames.some((frame) => frame.type === "state" && frame.state === "idle"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.connections.length, 1);
});

test("microphone realtime input budget prevents burst accumulation", async (t) => {
  const f = await fixture(t); f.send(start);
  (await f.peer()).send(JSON.stringify(ready));
  await until(() => f.frames.some((frame) => frame.type === "state" && frame.state === "listening"));
  for (let sequence = 0; sequence < 5; sequence++) f.send({ ...header, type: "audio", sequence, sampleRate: 16_000, pcm: Buffer.alloc(16_000).toString("base64") });
  const error = await f.frame("error");
  assert.equal(error.type === "error" && error.code, "overflow");
});

test("question bindings survive exact context transport; a different question cannot append speech", async (t) => {
  const question = { questionId: "q-a", revision: 2, target: { scope: "node", roomId: "room-a", runId: "run-a", nodeId: "node-a", attemptId: "attempt-a" } };
  const scoped = { ...context, question };
  const f = await fixture(t); f.send({ ...start, context: scoped });
  const peer = await f.peer(); peer.send(JSON.stringify(ready));
  await until(() => f.frames.some((frame) => frame.type === "state" && frame.state === "listening"));
  f.send({ ...header, type: "audio", sequence: 0, sampleRate: 16_000, pcm });
  f.send({ ...header, type: "commit" });
  await until(() => f.providerFrames[0].length === 2);
  peer.send(JSON.stringify({ message_type: "committed_transcript", text: "yes" }));
  const transcript = await f.frame("transcript");
  assert.deepEqual(transcript.type === "transcript" && transcript.context.question, question);
  const g = await fixture(t); g.send({ ...speak, context: scoped, final: false }); await g.peer();
  g.send({ ...speak, context: { ...scoped, question: { ...question, revision: 3 } } });
  await g.frame("error");
});

test("a new local connection cannot reuse an old session identity", async (t) => {
  const f = await fixture(t); f.send(start); await f.peer();
  const closed = once(f.client, "close"); f.client.close(); await closed;
  const fresh = new WebSocket(f.url);
  fresh.on("error", () => {});
  const stopped = once(fresh, "close");
  await once(fresh, "open"); fresh.send(JSON.stringify(start)); await stopped;
  assert.equal(f.connections.length, 1);
});

test("provider socket backpressure paces a faster-than-realtime multi-second response", async (t) => {
  const f = await fixture(t); f.send(speak);
  const peer = await f.peer();
  const audio = Buffer.alloc(24_000, 2);
  for (let chunk = 0; chunk < 6; chunk++) peer.send(JSON.stringify({ audio: audio.toString("base64") }));
  peer.send(JSON.stringify({ is_final: true }));
  await until(() => f.frames.some((frame) => frame.type === "audio_end"), "paced output", 5_000);
  assert.equal(f.frames.some((frame) => frame.type === "error"), false);
  const chunks = f.frames.filter((frame) => frame.type === "audio");
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.pcm, "base64"))), Buffer.concat(Array.from({ length: 6 }, () => audio)));
});
