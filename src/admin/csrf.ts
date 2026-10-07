import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { hmacHex, safeEqualStr } from "../lib/crypto.js";

export const CSRF_FAILED_TEXT = "Your session expired or the form was stale. Go back, refresh, and try again.";

const secret = () => Buffer.from(config.SESSION_SECRET, "base64");

export function newLoginNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function loginCsrf(nonce: string): string {
  return hmacHex(secret(), `login:${nonce}`);
}

export function setupCsrf(linkId: string): string {
  return hmacHex(secret(), `setup:${linkId}`);
}

export function csrfMatches(expected: string | null | undefined, given: unknown): boolean {
  if (!expected || typeof given !== "string" || !given) return false;
  return safeEqualStr(expected, given);
}
