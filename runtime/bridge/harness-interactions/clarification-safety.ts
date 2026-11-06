import { containsCredentialLikeData } from "../../agent/lib/memory.ts";
import type { AnswerQuestionRequest, QuestionPrompt } from "../harness-contracts/interactions.ts";
import { redactText } from "../redaction.ts";

export function isSafeClarificationText(value: string): boolean {
  const text = value.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "");
  return !containsCredentialLikeData(text) && redactText(text) === text &&
    !/\b(password|passwd|passphrase|api[ _-]?key|(?:access|refresh)[ _-]?token|(?:private[ _-]?key|client[ _-]?secret)|secrets?|credentials?|2fa|mfa|otp|one[ -]time[ -](?:code|password)|(?:recovery|backup)[ -]codes?|seed[ -]phrase|credit[ -]card)\b/i.test(text);
}

export function isSafeClarificationAnswer(answer: Pick<AnswerQuestionRequest, "text" | "choiceId">): boolean {
  return (answer.text === null || isSafeClarificationText(answer.text)) &&
    (answer.choiceId === null || isSafeClarificationText(answer.choiceId));
}

export function isSafeClarification(question: QuestionPrompt): boolean {
  return isSafeClarificationText(question.prompt) &&
    question.choices.every((choice) => isSafeClarificationText(choice.id) && isSafeClarificationText(choice.label));
}
