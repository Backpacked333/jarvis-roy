import assert from "node:assert/strict";
import test from "node:test";
import { bearerTokenMatches, isValidLocalToken } from "../agent/lib/local-auth.ts";
import { errorMessage } from "../bridge/errors.ts";
import { redactText, safeJson } from "../bridge/redaction.ts";

test("local bearer tokens require 32 characters and use exact token matching", () => {
  const token = "01234567890123456789012345678901";
  assert.equal(isValidLocalToken(token), true);
  assert.equal(isValidLocalToken(token.slice(1)), false);
  assert.equal(bearerTokenMatches(`Bearer ${token}`, token), true);
  assert.equal(bearerTokenMatches(`Bearer ${token}x`, token), false);
  assert.equal(bearerTokenMatches(`Basic ${token}`, token), false);
  assert.equal(bearerTokenMatches(`Bearer ${token}`, undefined), false);
  assert.equal(errorMessage("Eve returned a string error."), "Eve returned a string error.");
  assert.equal(errorMessage(""), "An unexpected error occurred.");
});

test("task and approval output redact credential-bearing text and fields", () => {
  assert.doesNotThrow(() => redactText("Prefix sk-12345678901234567890 suffix."));
  assert.equal(redactText("Prefix sk-12345678901234567890 suffix."),
    "Prefix [REDACTED] suffix.");
  assert.equal(redactText("Prefix Bearer fake-token-value suffix."),
    "Prefix [REDACTED] suffix.");
  assert.equal(redactText("https://example.test/?token=abc&x=1"), "https://example.test/?token=[REDACTED]&x=1");
  assert.equal(safeJson({ token: "not-a-real-token", message: "client_secret=not-real" }),
    '{"token":"[REDACTED]","message":"client_secret=[REDACTED]"}');
  assert.equal(safeJson({ message: '"password": "not-real"' }),
    '{"message":"password=[REDACTED]"}');
});
