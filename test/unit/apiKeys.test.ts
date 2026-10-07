import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { displayPrefix, generateApiKey, hashApiKey, KEY_RE, parseApiKey } from "../../src/lib/apiKeys.js";

const pepper = () => Buffer.from(process.env["KEY_PEPPER"]!, "base64");

describe("API keys (§7.1)", () => {
  it("generates bb_live_ + 43 base62 chars", () => {
    for (let i = 0; i < 50; i++) {
      const { key } = generateApiKey();
      expect(key).toMatch(/^bb_live_[0-9A-Za-z]{43}$/);
      expect(key).toHaveLength(8 + 43);
      expect(KEY_RE.test(key)).toBe(true);
    }
  });

  it("KEY_RE rejects wrong prefixes, lengths and alphabets", () => {
    const good = "bb_live_" + "a".repeat(43);
    expect(KEY_RE.test(good)).toBe(true);
    expect(KEY_RE.test("bb_live_" + "a".repeat(42))).toBe(false);
    expect(KEY_RE.test("bb_live_" + "a".repeat(44))).toBe(false);
    expect(KEY_RE.test("bb_test_" + "a".repeat(43))).toBe(false);
    expect(KEY_RE.test("bb_live_" + "a".repeat(42) + "-")).toBe(false);
    expect(KEY_RE.test("bb_live_" + "a".repeat(42) + "_")).toBe(false);
    expect(KEY_RE.test(" " + good)).toBe(false);
    expect(KEY_RE.test(good + "\n")).toBe(false);
  });

  it("prefix is the first 8 chars of the random part", () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toBe(key.slice("bb_live_".length, "bb_live_".length + 8));
    expect(prefix).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(displayPrefix(prefix)).toBe(`bb_live_${prefix}…`);
  });

  it("keys are unique", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it("hash is 64-char lowercase hex HMAC-SHA256(pepper, fullKey) and deterministic", () => {
    const { key, hash } = generateApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(hash);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    const expected = createHmac("sha256", pepper()).update(key, "utf8").digest("hex");
    expect(hash).toBe(expected);
    // Hashes the full key string, not just the secret part.
    const secretOnly = createHmac("sha256", pepper()).update(key.slice(8), "utf8").digest("hex");
    expect(hash).not.toBe(secretOnly);
    // A one-character change gives a different hash.
    const other = key.slice(0, -1) + (key.endsWith("a") ? "b" : "a");
    expect(hashApiKey(other)).not.toBe(hash);
  });

  it("parseApiKey returns the prefix for valid keys and null otherwise", () => {
    const { key, prefix } = generateApiKey();
    expect(parseApiKey(key)).toEqual({ prefix });
    expect(parseApiKey("")).toBeNull();
    expect(parseApiKey("bb_live_short")).toBeNull();
    expect(parseApiKey(key + "x")).toBeNull();
    expect(parseApiKey("Bearer " + key)).toBeNull();
    expect(parseApiKey(key.replace("bb_live_", "bb_LIVE_"))).toBeNull();
  });
});
