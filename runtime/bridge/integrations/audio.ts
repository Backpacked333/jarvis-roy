/** Twilio Media Streams uses G.711 µ-law mono at 8 kHz. The shared Scribe bridge
 * accepts signed little-endian PCM16 at 16 kHz; its TTS emits PCM16 at 24 kHz. */
export function muLaw8kToPcm16k(input: Uint8Array): Buffer {
  if (input.byteLength > 8000) throw new Error("Telephony audio frame too large");
  const output = Buffer.alloc(input.length * 4);
  for (let i = 0; i < input.length; i++) {
    const value = (~input[i]) & 255, sign = value & 128, exponent = value >> 4 & 7, mantissa = value & 15;
    const amplitude = ((mantissa << 3) + 132) << exponent, sample = sign ? 132 - amplitude : amplitude - 132;
    output.writeInt16LE(sample, i * 4); output.writeInt16LE(sample, i * 4 + 2);
  }
  return output;
}
function encodeMuLaw(sample: number): number {
  const sign = sample < 0 ? 128 : 0; let magnitude = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7; for (let mask = 16384; exponent > 0 && !(magnitude & mask); exponent--, mask >>= 1) {}
  const mantissa = magnitude >> (exponent + 3) & 15;
  return (~(sign | exponent << 4 | mantissa)) & 255;
}
export function pcmToMuLaw8k(input: Uint8Array, rate: 16000 | 24000 = 16000): Buffer {
  const stride = rate / 8000;
  if (input.byteLength % (2 * stride) !== 0 || input.byteLength > 192_000) throw new Error("Invalid bounded PCM telephony audio");
  const bytes = Buffer.from(input), output = Buffer.alloc(input.byteLength / 2 / stride);
  for (let i = 0; i < output.length; i++) {
    let total = 0; for (let j = 0; j < stride; j++) total += bytes.readInt16LE((i * stride + j) * 2);
    output[i] = encodeMuLaw(Math.round(total / stride));
  }
  return output;
}
