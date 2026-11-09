import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { VoiceServerFrameSchema, type VoiceContext } from "../harness-contracts/voice.ts";

export interface TelephonySpeechSession { acceptPcm(pcm16k: Buffer): void; close(): void }
export interface TelephonySpeechAdapter {
  open(options: { callSid: string; context: VoiceContext; signal: AbortSignal;
    onAudio(pcm24k: Buffer): void; onTranscript(text: string): Promise<string | null>; onError(): void }): Promise<TelephonySpeechSession>;
}
/** Reuses the existing authenticated loopback ElevenLabs bridge and its model,
 * generation, overflow, and no-replay checks. No second speech provider client. */
export class ExistingVoiceSpeechAdapter implements TelephonySpeechAdapter {
  private readonly url: string; private readonly token: string;
  private readonly connect: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  constructor(options: { url: string; token: string; connect?: (url: string, options: WebSocket.ClientOptions) => WebSocket }) {
    const url = new URL(options.url);
    if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/v1/voice/stream" || url.username || url.password || url.search || url.hash) throw new Error("Speech bridge must be the fixed loopback voice endpoint");
    this.url = url.href; this.token = options.token; this.connect = options.connect ?? ((url, config) => new WebSocket(url, config));
  }
  async open(options: Parameters<TelephonySpeechAdapter["open"]>[0]): Promise<TelephonySpeechSession> {
    options.signal.throwIfAborted();
    const socket = this.connect(this.url, { headers: { authorization: `Bearer ${this.token}` }, followRedirects: false, handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 32768 });
    const sessionId = randomUUID(); let generation = 0, sequence = 0, ready = false, closed = false, mode: "listen" | "speak" = "listen";
    let bytes = 0, silentBytes = 0, pending = Buffer.alloc(0);
    const send = (body: Record<string, unknown>) => {
      if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 96_000) throw new Error("Voice bridge unavailable or overflowing");
      socket.send(JSON.stringify({ version: 1, sessionId, generation, ...body }));
    };
    const close = () => { if (closed) return; closed = true; pending = Buffer.alloc(0); socket.close(); options.signal.removeEventListener("abort", close); };
    const fail = () => { close(); options.onError(); };
    const listen = () => { generation++; sequence = 0; ready = false; mode = "listen"; bytes = 0; silentBytes = 0; pending = Buffer.alloc(0); send({ type: "start", context: options.context, cloudConsent: true }); };
    const flush = () => {
      while (ready && pending.length) {
        const chunk = pending.subarray(0, 16000); pending = pending.subarray(chunk.length);
        send({ type: "audio", sequence: sequence++, pcm: chunk.toString("base64"), sampleRate: 16000 }); bytes += chunk.length;
      }
      if (ready && bytes >= 8000 && (silentBytes >= 16000 || bytes >= 256000)) { ready = false; send({ type: "commit" }); }
    };
    await new Promise<void>((resolve, reject) => {
      const abort = () => { close(); reject(new Error("Voice session stopped")); };
      options.signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => { options.signal.removeEventListener("abort", abort); if (options.signal.aborted) return abort(); resolve(); });
      socket.once("error", () => { options.signal.removeEventListener("abort", abort); reject(new Error("Shared voice bridge unavailable")); });
    });
    options.signal.addEventListener("abort", close, { once: true });
    socket.on("error", fail); socket.on("close", close);
    socket.on("message", (raw, binary) => {
      if (closed) return;
      try {
        if (binary) throw new Error("Unexpected binary voice frame");
        const frame = VoiceServerFrameSchema.parse(JSON.parse(raw.toString()));
        if (frame.sessionId !== sessionId || frame.generation !== generation) return;
        if (frame.type === "error") return fail();
        if (frame.type === "state" && frame.state === "listening") { ready = true; flush(); }
        if (frame.type === "audio") options.onAudio(Buffer.from(frame.pcm, "base64"));
        if (frame.type === "audio_end" && mode === "speak") listen();
        if (frame.type === "transcript" && frame.final) {
          ready = false;
          void options.onTranscript(frame.text).then(text => {
            if (closed || options.signal.aborted) return;
            if (!text) return listen();
            if (text.length > 4000) throw new Error("Call speech response exceeds turn limit");
            generation++; mode = "speak"; send({ type: "speak", context: options.context, text, final: true });
          }).catch(fail);
        }
      } catch { fail(); }
    });
    listen();
    return { close, acceptPcm(pcm) {
      if (closed || mode !== "listen") return;
      if (pcm.length % 2 || pcm.length > 32000 || pending.length + pcm.length > 64000) return fail();
      let energy = 0; for (let offset = 0; offset < pcm.length; offset += 2) energy += Math.abs(pcm.readInt16LE(offset));
      silentBytes = energy / Math.max(1, pcm.length / 2) < 300 ? silentBytes + pcm.length : 0;
      pending = Buffer.concat([pending, pcm]); try { flush(); } catch { fail(); }
    } };
  }
}
