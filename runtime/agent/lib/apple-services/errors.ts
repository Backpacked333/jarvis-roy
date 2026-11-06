export class ConnectedServiceError extends Error {
  readonly code: string;
  readonly uncertain: boolean;

  constructor(code: string, message: string, uncertain = false) {
    super(message);
    this.name = "ConnectedServiceError";
    this.code = code;
    this.uncertain = uncertain;
  }
}

export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ConnectedServiceError("cancelled", "Connected service action was cancelled before execution.");
  }
}

export function safeText(value: string, limit: number, secret?: string): string {
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
  if (secret) text = text.split(secret).join("[redacted]");
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization)\s*[=:]\s*)[^\s"<>]+/gi, "$1[redacted]");
  return text.slice(0, limit);
}
