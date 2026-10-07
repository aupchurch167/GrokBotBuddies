import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aad, aesGcmDecrypt, aesGcmEncrypt, safeEqualHex, sha256Hex } from "../../src/lib/crypto.js";

describe("AES-256-GCM", () => {
  it("round trips with the v1 format", () => {
    const blob = aesGcmEncrypt("sender-key-123", aad.webhookKey("bot_x"));
    expect(blob).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(blob).not.toContain("sender-key-123");
    expect(aesGcmDecrypt(blob, aad.webhookKey("bot_x"))).toBe("sender-key-123");
  });

  it("throws with the wrong AAD", () => {
    const blob = aesGcmEncrypt("secret", aad.webhookKey("bot_a"));
    expect(() => aesGcmDecrypt(blob, aad.webhookKey("bot_b"))).toThrow();
    expect(() => aesGcmDecrypt(blob, aad.setupKey("bot_a"))).toThrow();
  });

  it("throws on a tampered tag or ciphertext", () => {
    const blob = aesGcmEncrypt("secret", "x");
    const [v, iv, tag, ct] = blob.split(":");
    const badTag = Buffer.from(tag!, "base64");
    badTag[0] = badTag[0]! ^ 1;
    expect(() => aesGcmDecrypt([v, iv, badTag.toString("base64"), ct].join(":"), "x")).toThrow();
    const badCt = Buffer.from(ct!, "base64");
    badCt[0] = badCt[0]! ^ 1;
    expect(() => aesGcmDecrypt([v, iv, tag, badCt.toString("base64")].join(":"), "x")).toThrow();
  });

  it("throws with a different key", () => {
    const blob = aesGcmEncrypt("secret", "x");
    expect(() => aesGcmDecrypt(blob, "x", randomBytes(32))).toThrow();
  });
});

describe("safeEqualHex", () => {
  it("compares hex in constant time and handles length mismatch", () => {
    const a = sha256Hex("a");
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, sha256Hex("b"))).toBe(false);
    expect(safeEqualHex(a, a.slice(2))).toBe(false);
  });
});
