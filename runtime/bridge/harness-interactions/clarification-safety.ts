import { containsCredentialLikeData } from "../../agent/lib/memory.ts";
import type { QuestionPrompt } from "../harness-contracts/interactions.ts";

export function isSafeClarification(question: QuestionPrompt): boolean {
  const text = JSON.stringify(question);
  return !containsCredentialLikeData(text) &&
    !/\b(password|passphrase|api[ _-]?key|access[ _-]?token|private[ _-]?key|credentials?|2fa|mfa|one[ -]time[ -]code|credit[ -]card)\b/i.test(text);
}
