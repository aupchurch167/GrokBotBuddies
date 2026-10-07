import { randomBytes } from "node:crypto";

export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** n random base62 chars. Bytes >= 248 are discarded so `b % 62` has no modulo bias. */
export function randomBase62(n: number): string {
  let out = "";
  while (out.length < n) {
    const buf = randomBytes(Math.ceil((n - out.length) * 1.1) + 8);
    for (const b of buf) {
      if (b >= 248) continue;
      out += BASE62[b % 62];
      if (out.length === n) break;
    }
  }
  return out;
}
