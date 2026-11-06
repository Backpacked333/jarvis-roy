import { z } from "zod";

const InteractionSchema = z.object({ interactionId: z.string().min(1).max(256), request: z.object({ kind: z.string() }) });

export function inspectEveInteraction(value: unknown): { interactionId: string; kind: "approval" | "question" | "other" } {
  const { interactionId, request } = InteractionSchema.parse(value);
  return { interactionId, kind: request.kind === "approval" || request.kind === "question" ? request.kind : "other" };
}

export interface EveConversationPort<T> {
  inspect(sessionId: string): Promise<{ idle: boolean; interactions: readonly unknown[] }>;
  send(sessionId: string, text: string): Promise<T>;
}

/** Use one shared gate for all legacy ambient text/voice entry points; exact card responses bypass it. */
export function createEveConversationGate<T>(port: EveConversationPort<T>) {
  const sending = new Set<string>();
  return {
    async send(sessionId: string, text: string): Promise<T> {
      if (sending.has(sessionId)) throw new Error("Session is busy; message was not sent");
      sending.add(sessionId);
      try {
        const state = await port.inspect(sessionId);
        if (!state.idle || state.interactions.length) throw new Error("Session is busy or waiting for input; use the exact question or approval card");
        return await port.send(sessionId, z.string().trim().min(1).max(16_000).parse(text));
      } finally { sending.delete(sessionId); }
    },
  };
}
