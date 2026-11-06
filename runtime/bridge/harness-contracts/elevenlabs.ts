import { z } from "zod";
import { RECOGNITION_MODEL, VOICE_MODEL } from "./voice.ts";

export function dialogueWebSocketUrl(): string {
  const url = new URL("wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input");
  url.searchParams.set("model_id", VOICE_MODEL);
  url.searchParams.set("output_format", "pcm_24000");
  return url.href;
}

export function recognitionWebSocketUrl(): string {
  const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  url.searchParams.set("model_id", RECOGNITION_MODEL);
  url.searchParams.set("audio_format", "pcm_16000");
  url.searchParams.set("commit_strategy", "manual");
  return url.href;
}

const voiceId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const DialogueInitializeSchema = z.strictObject({ voices: z.array(voiceId).length(1) });
export const DialogueTextSchema = z.strictObject({
  inputs: z.array(z.strictObject({ text: z.string().min(1).max(4_000), voice_id: voiceId, new_turn: z.boolean().optional() })).min(1).max(8),
  flush: z.boolean().optional(),
});
export const DialogueAudioSchema = z.object({
  audio: z.string().max(1_398_104).refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.length <= 1_048_576 && bytes.length % 2 === 0 && bytes.toString("base64") === value;
  }, "Expected bounded PCM16 audio"),
});
export const DialogueTurnEndSchema = z.object({ is_final_audio_for_turn: z.literal(true) });
export const DialogueClosedSchema = z.object({ is_final: z.literal(true) });
export const DialogueErrorSchema = z.object({ error: z.string().max(200), message: z.string().max(2_000), code: z.number().int() });
export const RecognitionTranscriptSchema = z.object({
  message_type: z.enum(["partial_transcript", "committed_transcript"]),
  text: z.string().max(16_000),
});
