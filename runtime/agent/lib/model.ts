import { defineDynamic, type DynamicModelContext } from "eve";

export const DEFAULT_MODEL = "openai/gpt-6-sol-fast";

export function configuredModel(value = process.env.JARVIS_MODEL): string {
  return value || DEFAULT_MODEL;
}

export const modelSelection = defineDynamic((_context: DynamicModelContext) => configuredModel());
