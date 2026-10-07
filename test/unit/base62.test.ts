import { describe, expect, it } from "vitest";
import { BASE62, randomBase62 } from "../../src/lib/base62.js";
import { BOT_ID_RE, nameKey, newId, orderPair } from "../../src/lib/ids.js";

describe("randomBase62", () => {
  it("returns the requested length using only base62 chars", () => {
    for (const n of [1, 8, 20, 43, 100]) {
      const s = randomBase62(n);
      expect(s).toHaveLength(n);
      expect(s).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  it("is roughly uniform across the alphabet", () => {
    const counts = new Map<string, number>();
    const s = randomBase62(62 * 2000);
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(62);
    for (const ch of BASE62) {
      const c = counts.get(ch) ?? 0;
      expect(c).toBeGreaterThan(1600);
      expect(c).toBeLessThan(2400);
    }
  });
});

describe("ids", () => {
  it("newId uses prefix + 20 base62 chars", () => {
    expect(newId("bot")).toMatch(BOT_ID_RE);
    expect(newId("msg")).toMatch(/^msg_[0-9A-Za-z]{20}$/);
  });
  it("nameKey trims, collapses whitespace and lowercases", () => {
    expect(nameKey("  MAC   Bridge ")).toBe("mac bridge");
  });
  it("orderPair sorts", () => {
    expect(orderPair("b", "a")).toEqual(["a", "b"]);
  });
});
