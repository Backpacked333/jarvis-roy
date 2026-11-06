import { timingSafeEqual } from "node:crypto";
import type { EveAuthFn } from "eve/channels/eve";

export const MIN_LOCAL_TOKEN_LENGTH = 32;

export function isValidLocalToken(token: string | undefined): token is string {
  return typeof token === "string" && token.length >= MIN_LOCAL_TOKEN_LENGTH && !/\s/.test(token);
}

export function bearerTokenMatches(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  if (!isValidLocalToken(expected) || !authorization) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const actual = Buffer.from(match[1], "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export const localBearerAuth: EveAuthFn = (request) => {
  const token = process.env.JARVIS_LOCAL_TOKEN;
  if (!bearerTokenMatches(request.headers.get("authorization") ?? undefined, token)) {
    return null;
  }

  return {
    attributes: {},
    authenticator: "jarvis-local-token",
    principalId: "jarvis-local",
    principalType: "service",
  };
};
