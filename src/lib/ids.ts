import { randomBase62 } from "./base62.js";

export type IdPrefix = "bot" | "con" | "msg" | "dbj" | "sl" | "ses" | "aud";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBase62(20)}`;
}

export const BOT_ID_RE = /^bot_[0-9A-Za-z]{20}$/;
export const MSG_ID_RE = /^msg_[0-9A-Za-z]{20}$/;

/** trim + collapse whitespace + lowercase */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function orderPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}
