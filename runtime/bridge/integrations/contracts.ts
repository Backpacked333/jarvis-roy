import { z } from "zod";

export const IntegrationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const NumericOwnerId = z.string().regex(/^[1-9][0-9]{0,15}$/);
export const PhoneNumber = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
export const CallSid = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
export const ContextSchema = z.strictObject({ projectId: IntegrationId, objectiveId: IntegrationId.nullable() });
export type IntegrationContext = z.infer<typeof ContextSchema>;
export interface IntegrationLedger {
  /** Shared objective ledger enforces $300/month, $10/day and $5/objective. */
  reserve(input: IntegrationContext & { requestId: string; authority: string; estimatedUsd: number }): Promise<{ id: string }> | { id: string };
  settle(id: string, result: { accounting: "measured" | "unknown"; estimatedUsd: number | null }): Promise<unknown> | unknown;
}
export interface ApprovedEffect {
  approvalId: string; projectId: string; kind: "gmail_send" | "calendar_write";
  digest: string; exactArguments: string;
}
export interface IntegrationApprovalAuthority {
  /** Consume an existing exact approval before invoking its sole effect callback. */
  run<T>(effect: ApprovedEffect, execute: () => Promise<T>): Promise<T>;
}
export interface IntegrationPrices {
  telegramRequestUsd?: number; googleRequestUsd?: number; twilioRequestUsd?: number;
  twilioMinuteUsd?: number; elevenLabsMinuteUsd?: number; elevenLabsCharacterUsd?: number;
}
const questionFields = { questionId: IntegrationId, revision: z.number().int().positive(), expiresAt: z.iso.datetime() };
export const QuestionBindingSchema = z.union([
  z.strictObject({ kind: z.literal("objective").default("objective"), objectiveId: IntegrationId, ...questionFields }),
  z.strictObject({ kind: z.literal("task"), taskId: IntegrationId, projectId: IntegrationId, ...questionFields }),
]);
export type QuestionBinding = z.infer<typeof QuestionBindingSchema>;
export const OutboxInputSchema = z.strictObject({
  id: IntegrationId, projectId: IntegrationId, objectiveId: IntegrationId.nullable(),
  kind: z.enum(["digest", "routine", "question", "reply"]), text: z.string().trim().min(1).max(4000),
  disclosure: z.enum(["minimal", "project_details"]).default("minimal"),
  notBefore: z.iso.datetime(), question: QuestionBindingSchema.nullable().default(null),
});
export type OutboxInput = z.infer<typeof OutboxInputSchema>;
export type OutboxRecord = OutboxInput & { version: 1; status: "queued" | "sending" | "sent" | "unknown" | "cancelled"; createdAt: string; sentAt: string | null; messageId: number | null };
export interface CallProof { credentialId: string; ownerSessionId: string; verifiedAt: string; expiresAt: string }
export interface CallRecord extends IntegrationContext {
  version: 1; id: string; issueId: string; callSid: string | null;
  status: "initiating" | "ringing" | "in_progress" | "completed" | "failed" | "unknown";
  createdAt: string; deadlineAt: string; verifiedUntil: string | null;
  verification: CallProof | null; mediaTokenHash: string; streamSid: string | null;
  reservationId: string | null; estimatedUsd: number; chargedUsd: number | null;
  speechInputBytes: number; speechOutputChars: number;
  authorizationGeneration?: number;
}
export interface InboundTelegram {
  updateId: number; messageId: number; text: string; chatId: string;
  question: QuestionBinding | null;
}
export type GoogleChange = { provider: "gmail" | "calendar"; accountId: string; projectId: string; resourceId: string; externalId: string; content: unknown; cloudAllowed?: boolean; retentionAllowed?: boolean };
export interface IntegrationHooks {
  authorizeDisclosure?(input: { projectId: string; channel: "telegram" | "phone"; destinationId: string; proactive: boolean }): boolean;
  authorizeCallOutreach?(input: { projectId: string; destinationId: string; category?: "blocking_deadline" | "call_when_ready" }): boolean;
  readObjective?(input: { projectId: string; objectiveId: string }): Promise<unknown>;
  onTelegramMessage?(message: InboundTelegram): Promise<void>;
  onStop(): Promise<void>;
  onGoogleChange?(change: GoogleChange): Promise<void>;
  digest?(slot: "09" | "18", context: IntegrationContext): Promise<string | null>;
  onVerifiedCallTranscript?(input: IntegrationContext & { callSid: string; text: string }): Promise<string | null>;
}
