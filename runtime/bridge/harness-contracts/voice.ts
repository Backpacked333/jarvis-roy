import { z } from "zod";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { CounterSchema, IdSchema } from "./domain.ts";
import { QuestionBindingSchema } from "./interactions.ts";

export const VOICE_VERSION = 1 as const;
export const VOICE_SOCKET_PATH = "/v1/voice/stream";
export const VOICE_STATUS_PATH = "/v1/voice/status";
export const VOICE_MODEL = "eleven_v4_turbo" as const;
export const RECOGNITION_MODEL = "scribe_v2_realtime" as const;
export const MAX_VOICE_FRAME_BYTES = 32_768;
export const MAX_AUDIO_CHUNK_BYTES = 16_000;
export const MAX_AUDIO_BUFFER_MS = 2_000;
export const VoiceStateSchema = z.enum(["connecting", "listening", "thinking", "speaking", "idle", "interrupted", "unavailable"]);
export type VoiceState = z.infer<typeof VoiceStateSchema>;

export const VoiceContextSchema = z.strictObject({
  roomId: IdSchema.nullable(), conversationId: IdSchema.nullable(), question: QuestionBindingSchema.nullable(),
}).refine((value) => value.question === null || value.question.target.roomId === value.roomId, "Question and voice room must match");
export type VoiceContext = z.infer<typeof VoiceContextSchema>;
const header = { version: z.literal(VOICE_VERSION), sessionId: IdSchema, generation: CounterSchema };
const pcm = z.string().max(Math.ceil(MAX_AUDIO_CHUNK_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.length <= MAX_AUDIO_CHUNK_BYTES && bytes.length % 2 === 0 && bytes.toString("base64") === value;
  }, "Expected bounded canonical PCM16 base64");

export const VoiceClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...header, type: z.literal("start"), context: VoiceContextSchema, cloudConsent: z.literal(true) }),
  z.strictObject({ ...header, type: z.literal("audio"), sequence: CounterSchema, pcm, sampleRate: z.literal(16_000) }),
  z.strictObject({ ...header, type: z.literal("commit") }),
  z.strictObject({ ...header, type: z.literal("speak"), context: VoiceContextSchema, text: z.string().min(1).max(4_000), final: z.boolean() }),
  z.strictObject({ ...header, type: z.literal("interrupt") }),
  z.strictObject({ ...header, type: z.literal("stop") }),
]);
export type VoiceClientFrame = z.infer<typeof VoiceClientFrameSchema>;
export const VoiceServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...header, type: z.literal("state"), state: VoiceStateSchema, detail: z.string().max(2_000).nullable() }),
  z.strictObject({ ...header, type: z.literal("transcript"), text: z.string().max(16_000), final: z.boolean(), context: VoiceContextSchema }),
  z.strictObject({ ...header, type: z.literal("audio"), sequence: CounterSchema, pcm, sampleRate: z.literal(24_000) }),
  z.strictObject({ ...header, type: z.literal("audio_end") }),
  z.strictObject({ ...header, type: z.literal("error"), code: z.enum(["unavailable", "protocol", "overflow", "provider", "timeout"]), message: z.string().max(2_000), retryable: z.boolean() }),
]);
export type VoiceServerFrame = z.infer<typeof VoiceServerFrameSchema>;
export const VoiceStatusSchema = z.strictObject({
  version: z.literal(1), provider: z.literal("elevenlabs"), model: z.literal(VOICE_MODEL), recognitionModel: z.literal(RECOGNITION_MODEL),
  status: z.enum(["unavailable", "configured", "connected"]), reason: z.string().max(2_000).nullable(),
});
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;
export interface VoiceBridgeOptions { apiKey?: string; voiceId?: string; fetch?: typeof fetch }
export interface VoiceBridge {
  status(): VoiceStatus;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
}

export function parseVoiceClientFrame(json: string): VoiceClientFrame {
  if (Buffer.byteLength(json) > MAX_VOICE_FRAME_BYTES) throw new Error("Voice frame exceeds limit");
  return VoiceClientFrameSchema.parse(JSON.parse(json));
}

// This gate is per connection. Advancing invalidates every prior audio/transcript callback.
export class VoiceGenerationGate {
  private sessionId: string | null = null;
  private generation = -1;
  private lastSequence = -1;
  advance(sessionId: string, generation: number): void {
    IdSchema.parse(sessionId);
    CounterSchema.parse(generation);
    if (this.sessionId !== null && (sessionId !== this.sessionId || generation <= this.generation)) {
      throw new Error("Stale voice generation or wrong session");
    }
    this.sessionId = sessionId;
    this.generation = generation;
    this.lastSequence = -1;
  }
  accepts(sessionId: string, generation: number): boolean {
    return sessionId === this.sessionId && generation === this.generation;
  }
  acceptAudio(sessionId: string, generation: number, sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !this.accepts(sessionId, generation) || sequence !== this.lastSequence + 1) return false;
    this.lastSequence = sequence;
    return true;
  }
}
