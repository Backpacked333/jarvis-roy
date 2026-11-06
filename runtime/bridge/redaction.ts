const FIELD_SECRET = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|credential|authorization|private[_-]?key)/i;
const INLINE_PATTERNS = [
  /["']?\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\b["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
  /["']?\b(token|client[_-]?secret|private[_-]?key|credential)\b["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /([?&](?:token|key|password|secret|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|credential)=)[^&#\s]+/gi,
];

export function redactText(value: string): string {
  return INLINE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (_match, key?: string) =>
      typeof key === "string"
        ? `${key}${key.endsWith("=") ? "" : "="}[REDACTED]`
        : "[REDACTED]"),
    value,
  );
}

export function redactValue(value: unknown, key = ""): unknown {
  if (FIELD_SECRET.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value)) ?? "[Arguments unavailable]";
  } catch {
    return "[Arguments unavailable]";
  }
}
