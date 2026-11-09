import { defineDynamic, type DynamicModelContext } from "eve";
import { createGateway } from "ai";
import { budgetCloudModel, bridgeModelBudgetTransport, ModelBudgetDenied } from "./cloud-budget.ts";

export const DEFAULT_MODEL = "openai/gpt-6-sol-fast";

export function configuredModel(value = process.env.JARVIS_MODEL): string {
  return value || DEFAULT_MODEL;
}

export function selectModel(context: DynamicModelContext) {
  if (process.env.JARVIS_RUNTIME_PROFILE !== "cloud") return configuredModel();
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
