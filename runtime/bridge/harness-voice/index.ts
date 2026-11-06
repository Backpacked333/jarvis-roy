import WebSocket, { WebSocketServer } from "ws";
import type { ClientOptions, RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import {
  MAX_VOICE_FRAME_BYTES, RECOGNITION_MODEL, VOICE_MODEL, VOICE_SOCKET_PATH,
  VoiceGenerationGate, parseVoiceClientFrame,
} from "../harness-contracts/voice.ts";
import type { VoiceBridge, VoiceBridgeOptions, VoiceClientFrame, VoiceContext, VoiceServerFrame } from "../harness-contracts/voice.ts";
import {
  dialogueWebSocketUrl, recognitionWebSocketUrl, DialogueInitializeSchema, DialogueTextSchema,
  DialogueAudioSchema, DialogueTurnEndSchema, DialogueClosedSchema, DialogueErrorSchema, RecognitionTranscriptSchema,
} from "../harness-contracts/elevenlabs.ts";
import { PCMQueue, TokenBucket } from "./limits.ts";

const PROVIDER_MAX_BYTES = 1_450_000;
const OUTPUT_BUFFER_BYTES = 96_000;
const INPUT_WIRE_BYTES = 88_000;
const websocketBounds = { maxFragments: 64, maxBufferedChunks: 256, closeTimeout: 1_000 };
const sessionStarted = z.object({
  message_type: z.literal("session_started"),
  config: z.object({ model_id: z.literal(RECOGNITION_MODEL), audio_format: z.literal("pcm_16000"), sample_rate: z.literal(16_000), commit_strategy: z.literal("manual") }),
});

export interface VoiceTransportDependencies {
  connect(url: string, options: ClientOptions): WebSocket;
  now(): number;
}

type FrameBody = VoiceServerFrame extends infer F ? F extends VoiceServerFrame ? Omit<F, "version" | "sessionId" | "generation"> : never : never;
type Turn = {
  sessionId: string; generation: number; context: VoiceContext; mode: "listen" | "speak";
  started: number; deadline: number; provider?: WebSocket; ready: boolean; opened: boolean;
  retry?: ReturnType<typeof setTimeout>; retries: number; closed: boolean;
  committed: boolean; finalText: boolean; ended: boolean; audioSequence: number; inputBytes: number;
  text: { text: string; final: boolean }[]; textLength: number; sentText: boolean;
  queue: PCMQueue; audioRate: TokenBucket; lastKeepAlive: number;
};

function bytesOf(raw: RawData): Buffer {
  return Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
}

class VoiceConnection {
  private readonly gate = new VoiceGenerationGate();
  private readonly frames: TokenBucket;
  private readonly turns: TokenBucket;
  private turn?: Turn;
  private header?: { sessionId: string; generation: number };
  private lastActivity: number;
  private readonly started: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private failed = false;
  private sessionId?: string;
  private readonly client: WebSocket;
  private readonly options: VoiceBridgeOptions;
  private readonly deps: VoiceTransportDependencies;
  private readonly unavailable: string | null;
  private readonly claimSession: (id: string) => boolean;

  constructor(client: WebSocket, options: VoiceBridgeOptions,
    deps: VoiceTransportDependencies, unavailable: string | null, claimSession: (id: string) => boolean) {
    this.client = client;
    this.options = options;
    this.deps = deps;
    this.unavailable = unavailable;
    this.claimSession = claimSession;
    this.started = this.lastActivity = deps.now();
    this.frames = new TokenBucket(180, 100, this.started);
    this.turns = new TokenBucket(12, 0.5, this.started);
    client.on("message", (raw, binary) => {
      if (this.failed || this.disposed) return;
      try {
        if (binary || !this.frames.take(1, deps.now())) throw new Error("Invalid frame or rate");
        const frame = parseVoiceClientFrame(bytesOf(raw).toString("utf8"));
        if (this.sessionId && frame.sessionId !== this.sessionId) throw new Error("Wrong session");
        if (!this.sessionId && !this.claimSession(frame.sessionId)) throw new Error("Session was already used");
        this.sessionId = frame.sessionId;
        this.lastActivity = deps.now();
        this.receive(frame);
      } catch { this.fail("protocol", "Invalid, stale, out-of-order or excessive voice frame.", false); }
    });
    client.on("close", () => this.dispose());
    client.on("error", () => this.dispose());
    this.timer = setInterval(() => this.tick(), 20);
    this.timer.unref();
  }

  get connected(): boolean { return !!this.turn?.ready && !this.turn.closed; }

  private receive(frame: VoiceClientFrame): void {
    const same = this.gate.accepts(frame.sessionId, frame.generation);
    if (frame.type === "audio" || frame.type === "commit") {
      const turn = this.turn;
      if (!same || !turn || turn.mode !== "listen" || !turn.ready || turn.committed) throw new Error("No active capture");
      if (frame.type === "audio") {
        const size = Buffer.from(frame.pcm, "base64").length;
        if (!this.gate.acceptAudio(frame.sessionId, frame.generation, frame.sequence)) throw new Error("Sequence gap");
        if (!turn.audioRate.take(size, this.deps.now())) return this.fail("overflow", "Microphone audio exceeded the realtime buffer limit.", false);
        turn.inputBytes += size;
        this.sendProvider(turn, { message_type: "input_audio_chunk", audio_base_64: frame.pcm, sample_rate: 16_000, commit: false });
      } else {
        // Scribe rejects very short commits. Do not submit guessed or partial text.
        if (turn.inputBytes < 8_000) return this.fail("protocol", "Capture at least 250 ms of audio before committing.", false);
        turn.committed = true;
        turn.deadline = this.deps.now() + 12_000;
        this.sendProvider(turn, { message_type: "input_audio_chunk", audio_base_64: "", sample_rate: 16_000, commit: true });
        this.send({ type: "state", state: "thinking", detail: "Finalizing ElevenLabs transcript" });
      }
      return;
    }
    if (frame.type === "speak" && same) {
      const turn = this.turn;
      if (!turn || turn.mode !== "speak" || turn.finalText || JSON.stringify(frame.context) !== JSON.stringify(turn.context)) throw new Error("Changed turn");
      this.addText(turn, frame.text, frame.final);
      return;
    }
    this.gate.advance(frame.sessionId, frame.generation);
    this.header = { sessionId: frame.sessionId, generation: frame.generation };
    this.closeTurn();
    if (frame.type === "interrupt" || frame.type === "stop") {
      this.send({ type: "state", state: frame.type === "stop" ? "idle" : "interrupted", detail: null });
      return;
    }
    if (!this.turns.take(1, this.deps.now())) return this.fail("overflow", "Too many voice turns. Wait before starting another.", true);
    if (this.unavailable) return this.fail("unavailable", this.unavailable, false);
    const now = this.deps.now();
    const turn: Turn = {
      ...this.header, context: structuredClone(frame.context), mode: frame.type === "start" ? "listen" : "speak",
      started: now, deadline: now + 8_000, ready: false, opened: false, retries: 0, closed: false,
      committed: false, finalText: false, ended: false, audioSequence: 0, inputBytes: 0,
      text: [], textLength: 0, sentText: false, queue: new PCMQueue(OUTPUT_BUFFER_BYTES),
      audioRate: new TokenBucket(64_000, 32_000, now), lastKeepAlive: now,
    };
    this.turn = turn;
    this.send({ type: "state", state: "connecting", detail: "Connecting to ElevenLabs; no fallback provider" });
    if (frame.type === "speak") this.addText(turn, frame.text, frame.final);
    this.openProvider(turn);
  }

  private current(turn: Turn): boolean {
    return !this.failed && !this.disposed && this.turn === turn && !turn.closed && this.gate.accepts(turn.sessionId, turn.generation);
  }

  private openProvider(turn: Turn): void {
    if (!this.current(turn)) return;
    let provider: WebSocket;
    try {
      provider = this.deps.connect(turn.mode === "listen" ? recognitionWebSocketUrl() : dialogueWebSocketUrl(), {
        ...websocketBounds,
        headers: { "xi-api-key": this.options.apiKey! }, maxPayload: PROVIDER_MAX_BYTES,
        perMessageDeflate: false, handshakeTimeout: 5_000, followRedirects: false,
      });
    } catch { this.fail("provider", "ElevenLabs connection could not be created.", true); return; }
    turn.provider = provider;
    let retryScheduled = false;
    const broken = () => {
      if (!this.current(turn) || turn.provider !== provider || retryScheduled || turn.ended) return;
      if (!turn.opened && turn.retries < 1) {
        // Retry only an unopened socket: no audio/text has reached the provider.
        retryScheduled = true;
        turn.retries += 1;
        provider.terminate();
        turn.retry = setTimeout(() => this.openProvider(turn), 250);
      } else this.fail("provider", "ElevenLabs disconnected. This turn was not replayed; start a new turn explicitly.", true);
    };
    provider.on("open", () => {
      if (!this.current(turn) || turn.provider !== provider) { provider.terminate(); return; }
      turn.opened = true;
      if (turn.mode === "speak") {
        turn.ready = true;
        turn.deadline = this.deps.now() + 20_000;
        this.sendProvider(turn, DialogueInitializeSchema.parse({ voices: [this.options.voiceId] }));
        this.flushText(turn);
      }
    });
    provider.on("message", (raw, binary) => {
      if (!this.current(turn) || turn.provider !== provider) return;
      try {
        const data = bytesOf(raw);
        if (binary || data.length > PROVIDER_MAX_BYTES) throw new Error("Invalid provider frame");
        const value: unknown = JSON.parse(data.toString("utf8"));
        this.providerMessage(turn, value);
      } catch { this.fail("provider", "ElevenLabs returned an unsupported or malformed voice format. No fallback was used.", false); }
    });
    provider.on("unexpected-response", (_request, response) => {
      response.resume();
      if (!this.current(turn)) return;
      this.fail("unavailable", "ElevenLabs rejected this voice/model connection. Verify account access to eleven_v4_turbo, Scribe and PCM formats.", false);
    });
    provider.on("error", broken);
    provider.on("close", broken);
  }

  private providerMessage(turn: Turn, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid payload");
    const record = value as Record<string, unknown>;
    if ("error" in record || typeof record.message_type === "string" && /error|insufficient|exceeded|failed|throttled/.test(record.message_type)) {
      // Never echo provider text: it can contain submitted text or credentials.
      DialogueErrorSchema.safeParse(value);
      this.fail("provider", "ElevenLabs rejected the request or reached an account limit. Check voice/model access; no fallback was used.", false);
      return;
    }
    if (turn.mode === "listen") {
      if (record.message_type === "session_started") {
        sessionStarted.parse(value);
        if (turn.ready) throw new Error("Duplicate session");
        turn.ready = true;
        turn.deadline = turn.started + 60_000;
        this.send({ type: "state", state: "listening", detail: "Microphone audio is sent to ElevenLabs Scribe" });
        return;
      }
      const transcript = RecognitionTranscriptSchema.parse(value);
      if (!turn.ready) throw new Error("Transcript before ready");
      const final = transcript.message_type === "committed_transcript";
      if (final && !turn.committed) throw new Error("Unrequested commit");
      this.send({ type: "transcript", text: transcript.text, final, context: turn.context });
      if (final) {
        this.closeTurn();
        this.send({ type: "state", state: "idle", detail: null });
      }
      return;
    }
    let recognized = false;
    if ("audio" in record && record.audio !== null && record.audio !== "") {
      if (turn.ended) throw new Error("Audio after final");
      const audio = Buffer.from(DialogueAudioSchema.parse(value).audio, "base64");
      if (turn.queue.bytes + audio.length + Math.ceil(this.client.bufferedAmount * 0.75) > OUTPUT_BUFFER_BYTES) {
        this.fail("overflow", "ElevenLabs audio exceeded the two-second playback buffer. This turn was stopped.", true);
        return;
      }
      turn.queue.push(audio);
      turn.provider?.pause();
      turn.deadline = this.deps.now() + 20_000;
      recognized = true;
    }
    if (DialogueTurnEndSchema.safeParse(value).success || DialogueClosedSchema.safeParse(value).success) {
      if (!turn.finalText && DialogueClosedSchema.safeParse(value).success) throw new Error("Unexpected socket final");
      if (turn.finalText) {
        turn.ended = true;
        turn.deadline = this.deps.now() + 4_000;
      }
      recognized = true;
    }
    if (!recognized) throw new Error("Unknown message");
  }

  private addText(turn: Turn, text: string, final: boolean): void {
    turn.textLength += text.length;
    if (turn.textLength > 4_000 || turn.text.length >= 64) { this.fail("overflow", "Speech text exceeded the turn limit.", false); return; }
    turn.text.push({ text, final });
    turn.finalText = final;
    if (turn.ready) this.flushText(turn);
  }
  private flushText(turn: Turn): void {
    for (const chunk of turn.text.splice(0)) {
      this.sendProvider(turn, DialogueTextSchema.parse({ inputs: [{ text: chunk.text, voice_id: this.options.voiceId, new_turn: !turn.sentText }], flush: chunk.final }));
      turn.sentText = true;
      if (chunk.final) this.sendProvider(turn, { close_socket: true });
    }
  }
  private sendProvider(turn: Turn, value: unknown): void {
    const provider = turn.provider;
    const encoded = JSON.stringify(value);
    if (!this.current(turn) || provider?.readyState !== WebSocket.OPEN) return;
    if (provider.bufferedAmount + Buffer.byteLength(encoded) > INPUT_WIRE_BYTES) { this.fail("overflow", "ElevenLabs input backpressure exceeded the buffer limit.", true); return; }
    provider.send(encoded, (error) => { if (error && this.current(turn)) this.fail("provider", "ElevenLabs send failed. This turn was not replayed.", true); });
  }
  private send(body: FrameBody): void {
    if (!this.header || this.client.readyState !== WebSocket.OPEN) return;
    const encoded = JSON.stringify({ version: 1, ...this.header, ...body });
    if (this.client.bufferedAmount + Buffer.byteLength(encoded) > 128_000) { this.client.terminate(); this.dispose(); return; }
    this.client.send(encoded, (error) => { if (error) this.dispose(); });
  }
  private tick(): void {
    if (this.disposed || this.failed) return;
    const now = this.deps.now();
    if (now - this.started > 600_000 || !this.turn && now - this.lastActivity > 30_000) { this.fail("timeout", "Voice connection expired. Start a new connection explicitly.", true); return; }
    const turn = this.turn;
    if (!turn) return;
    if (now > turn.deadline || now - turn.started > 90_000) { this.fail("timeout", "Voice turn timed out. Nothing was replayed.", true); return; }
    if (turn.mode !== "speak" || !turn.ready) return;
    if (now - turn.lastKeepAlive >= 10_000 && !turn.finalText) {
      turn.lastKeepAlive = now;
      this.sendProvider(turn, { keep_alive: true });
    }
    const audio = turn.queue.take(960);
    if (audio) {
      if (turn.audioSequence === 0) this.send({ type: "state", state: "speaking", detail: null });
      this.send({ type: "audio", sequence: turn.audioSequence++, pcm: audio.toString("base64"), sampleRate: 24_000 });
    }
    if (turn.ended && turn.queue.bytes === 0) {
      this.send({ type: "audio_end" });
      this.closeTurn();
      this.send({ type: "state", state: "idle", detail: null });
    } else if (turn.queue.bytes === 0 && this.client.bufferedAmount < 16_000) {
      turn.provider?.resume();
    }
  }
  private fail(code: "unavailable" | "protocol" | "overflow" | "provider" | "timeout", message: string, retryable: boolean): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.closeTurn();
    this.send({ type: "error", code, message, retryable });
    this.send({ type: "state", state: "unavailable", detail: message });
    this.client.close(1008, "Voice stopped");
    const timeout = setTimeout(() => this.client.terminate(), 250);
    timeout.unref();
  }
  private closeTurn(): void {
    const turn = this.turn;
    this.turn = undefined;
    if (!turn) return;
    turn.closed = true;
    clearTimeout(turn.retry);
    turn.queue.clear();
    turn.text = [];
    // Closing the socket, not an undocumented cancel message, invalidates generation.
    turn.provider?.terminate();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.closeTurn();
  }
}

export function createVoiceBridge(options: VoiceBridgeOptions): VoiceBridge {
  return createVoiceBridgeWithTransport(options, { connect: (url, config) => new WebSocket(url, config), now: () => performance.now() });
}

// Test seam changes only transport/clock; production URLs, codecs and state machine stay identical.
export function createVoiceBridgeWithTransport(options: VoiceBridgeOptions, deps: VoiceTransportDependencies): VoiceBridge {
  const unavailable = !options.apiKey?.trim() ? "ElevenLabs API key is not configured. Text remains available."
    : !options.voiceId || !/^[A-Za-z0-9_-]{1,128}$/.test(options.voiceId) ? "An ElevenLabs voice ID must be configured. No fallback voice is used." : null;
  const server = new WebSocketServer({ ...websocketBounds, noServer: true, maxPayload: MAX_VOICE_FRAME_BYTES, perMessageDeflate: false, clientTracking: true });
  const sessions = new Map<WebSocket, VoiceConnection>();
  const connections = new TokenBucket(10, 1 / 3, deps.now());
  const usedSessions = new Map<string, number>();
  const claimSession = (id: string) => {
    const now = deps.now();
    for (const [key, at] of usedSessions) if (now - at > 600_000) usedSessions.delete(key);
    if (usedSessions.has(id) || usedSessions.size >= 500) return false;
    usedSessions.set(id, now);
    return true;
  };
  let closed = false;
  return {
    status: () => ({ version: 1, provider: "elevenlabs", model: VOICE_MODEL, recognitionModel: RECOGNITION_MODEL,
      status: unavailable || closed ? "unavailable" : [...sessions.values()].some((session) => session.connected) ? "connected" : "configured",
      reason: closed ? "Voice bridge is shut down." : unavailable }),
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      // The caller MUST authenticate token/Host/remote address before passing an upgrade.
      if (closed || request.url !== VOICE_SOCKET_PATH || request.headers.origin !== undefined || sessions.size >= 2 || !connections.take(1, deps.now())) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      server.handleUpgrade(request, socket, head, (client) => {
        const session = new VoiceConnection(client, options, deps, unavailable, claimSession);
        sessions.set(client, session);
        client.once("close", () => { session.dispose(); sessions.delete(client); });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const [client, session] of sessions) { session.dispose(); client.terminate(); }
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
