import { redactText, safeJson } from "./redaction.ts";

export const MAX_APPROVAL_CHARACTERS = 131_072;

export function reviewArguments(name: string | undefined, input: unknown) {
  let raw: string | undefined;
  try { raw = JSON.stringify(input); } catch { /* Unserializable input is deny-only. */ }
  const safe = safeJson(input);
  const reason = !name || !input || typeof input !== "object" || Array.isArray(input) || !raw
    ? "Exact tool arguments are unavailable. Deny this request and ask for a new, explicit action."
    : safe !== raw || redactText(name) !== name
      ? "Credential-like arguments cannot be fully displayed. Deny this request and remove sensitive values."
      : raw.length + name.length > MAX_APPROVAL_CHARACTERS
        ? "Exact arguments exceed the review display limit. Deny this request and request a smaller action."
        : undefined;
  const activation = name === "control_app" ? "\nThis action activates the named app before attempting the approved control interaction." : "";
  return reason
    ? { reviewable: false, blockedReason: reason, detail: reason }
    : { reviewable: true, detail: `Tool: ${name}${activation}\nExact arguments (JSON): ${raw}` };
}
