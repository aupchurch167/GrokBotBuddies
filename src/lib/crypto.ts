import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

function encKey(): Buffer {
  return Buffer.from(config.ENCRYPTION_KEY, "base64");
}

/** AES-256-GCM. Output: v1:<b64 iv>:<b64 tag>:<b64 ciphertext>. AAD binds the ciphertext to its row. */
export function aesGcmEncrypt(plaintext: string, aad: string, key: Buffer = encKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function aesGcmDecrypt(blob: string, aad: string, key: Buffer = encKey()): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported ciphertext format");
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export const aad = {
  webhookKey: (botId: string) => `bot-bridge:webhookKey:${botId}`,
  setupKey: (setupLinkId: string) => `bot-bridge:setupKey:${setupLinkId}`,
};

export function hmacHex(key: Buffer | string, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length * 2 !== a.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Constant-time string comparison (hashes both sides first so lengths never leak). */
export function safeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
