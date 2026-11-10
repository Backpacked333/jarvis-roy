import { defineDynamic, type DynamicModelContext } from "eve";
import { createGateway } from "ai";
import { budgetCloudModel, bridgeModelBudgetTransport, ModelBudgetDenied } from "./cloud-budget.ts";

export const DEFAULT_MODEL = "openai/gpt-6-sol-fast";

export function configuredModel(value = process.env.JARVIS_MODEL): string {
  return value || DEFAULT_MODEL;
}

/**
 * The local profile's application context cap. Supplying it with every
 * selection means a build made without access to the AI Gateway catalog, or a
 * model published after the build, can still be selected; and a provider's
 * very large maximum window never becomes the per-turn spend ceiling.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const MIN_CONTEXT_WINDOW_TOKENS = 16_384;
const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000;

export function configuredContextWindowTokens(value = process.env.JARVIS_CONTEXT_WINDOW_TOKENS): number {
  const text = value?.trim();
  if (!text) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (!/^[1-9][0-9]{0,8}$/.test(text)) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const tokens = Number(text);
  return tokens >= MIN_CONTEXT_WINDOW_TOKENS && tokens <= MAX_CONTEXT_WINDOW_TOKENS ? tokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function selectModel(context: DynamicModelContext) {
  if (process.env.JARVIS_RUNTIME_PROFILE !== "cloud") {
    return { model: configuredModel(), modelContextWindowTokens: configuredContextWindowTokens() };
  }
  if (!context.turn) throw new ModelBudgetDenied();
  // Reject a known configuration failure before creating a cost reservation.
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) throw new ModelBudgetDenied();
  // Delegated analysts share their root task's project and cumulative cap.
  const sessionId = context.session.parent?.rootSessionId ?? context.session.id;
  return { model: budgetCloudModel(createGateway({ apiKey })(configuredModel()), bridgeModelBudgetTransport(sessionId)),
    // An application context cap, never a claim about an unknown provider's
    // maximum. Explicit metadata also keeps offline-built cloud agents usable.
    modelContextWindowTokens: 16_384 };
}
export const modelSelection = defineDynamic(selectModel);
