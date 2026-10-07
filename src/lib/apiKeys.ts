import { config } from "../config.js";
import { randomBase62 } from "./base62.js";
import { hmacHex } from "./crypto.js";

export const KEY_RE = /^bb_live_([0-9A-Za-z]{43})$/;

export interface GeneratedKey {
  key: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(): GeneratedKey {
  const secret = randomBase62(43);
  const key = `bb_live_${secret}`;
  return { key, prefix: secret.slice(0, 8), hash: hashApiKey(key) };
}

export function parseApiKey(token: string): { prefix: string } | null {
  const m = KEY_RE.exec(token);
  return m ? { prefix: m[1]!.slice(0, 8) } : null;
}

/** HMAC-SHA256(base64decode(KEY_PEPPER), fullKey) as 64-char lowercase hex. */
export function hashApiKey(fullKey: string): string {
  return hmacHex(Buffer.from(config.KEY_PEPPER, "base64"), fullKey);
}

export function displayPrefix(prefix: string): string {
  return `bb_live_${prefix}…`;
}
