import { describe, expect, it } from "vitest";
import { AttemptLimiter, SlidingWindowLimiter } from "../../src/lib/rateLimit.js";

function fakeClock(start: number) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => void (t = v),
    advance: (ms: number) => void (t += ms),
  };
}

const HOUR = 3_600_000;

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit in a fresh window, then blocks until the next window", () => {
    const clk = fakeClock(10 * HOUR); // window-aligned
    const l = new SlidingWindowLimiter(HOUR, clk.now);
    for (let i = 0; i < 5; i++) expect(l.hit("a", 5)).toEqual({ ok: true, retryAfterMs: 0 });
    clk.advance(10 * 60_000);
    const r = l.hit("a", 5);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(50 * 60_000); // curr already full → wait for next window
  });

  it("keys are independent", () => {
    const clk = fakeClock(10 * HOUR);
    const l = new SlidingWindowLimiter(HOUR, clk.now);
    expect(l.hit("a", 1).ok).toBe(true);
    expect(l.hit("a", 1).ok).toBe(false);
    expect(l.hit("b", 1).ok).toBe(true);
  });

  it("weights the previous window by the remaining overlap", () => {
    const clk = fakeClock(10 * HOUR);
    const l = new SlidingWindowLimiter(HOUR, clk.now);
    for (let i = 0; i < 10; i++) expect(l.hit("a", 10).ok).toBe(true);
    // 30 min into the next window: estimate = 10 * 0.5 + curr
    clk.set(11 * HOUR + 30 * 60_000);
    for (let i = 0; i < 5; i++) expect(l.hit("a", 10).ok).toBe(true);
    const r = l.hit("a", 10);
    expect(r.ok).toBe(false);
    // retry = (1 - (10-5-1)/10 - 0.5) * HOUR = 0.1h = 6 min
    expect(r.retryAfterMs).toBe(6 * 60_000);
    // after 6 more minutes the estimate is 10*0.4 + 5 = 9 → one more allowed
    clk.advance(6 * 60_000);
    expect(l.hit("a", 10).ok).toBe(true);
  });

  it("retryAfterMs is at least 1000 ms when blocked by the previous window", () => {
    const clk = fakeClock(10 * HOUR);
    const l = new SlidingWindowLimiter(HOUR, clk.now);
    for (let i = 0; i < 10; i++) l.hit("a", 10);
    clk.set(11 * HOUR); // elapsed 0: estimate = 10
    const r = l.hit("a", 10);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(1000);
  });

  it("forgets a window that is more than one window old", () => {
    const clk = fakeClock(10 * HOUR);
    const l = new SlidingWindowLimiter(HOUR, clk.now);
    for (let i = 0; i < 3; i++) l.hit("a", 3);
    expect(l.hit("a", 3).ok).toBe(false);
    clk.set(12 * HOUR); // two windows later → prev = 0
    for (let i = 0; i < 3; i++) expect(l.hit("a", 3).ok).toBe(true);
  });

  it("blocked hits do not count", () => {
    const clk = fakeClock(10 * HOUR);
    const l = new SlidingWindowLimiter(HOUR, clk.now);
    l.hit("a", 1);
    for (let i = 0; i < 5; i++) expect(l.hit("a", 1).ok).toBe(false);
    clk.set(12 * HOUR);
    expect(l.hit("a", 1).ok).toBe(true);
  });

  it("sweep drops stale keys and reset clears everything", () => {
    const clk = fakeClock(10 * HOUR);
    const l = new SlidingWindowLimiter(HOUR, clk.now);
    l.hit("a", 1);
    clk.set(13 * HOUR);
    l.sweep();
    clk.set(10 * HOUR + 1);
    // swept, so the old counter is gone even back in the same window
    expect(l.hit("a", 1).ok).toBe(true);
    l.reset();
    expect(l.hit("a", 1).ok).toBe(true);
  });
});

describe("AttemptLimiter", () => {
  it("blocks once max failures are inside the window", () => {
    const clk = fakeClock(1_000_000);
    const l = new AttemptLimiter(3, 10 * 60_000, clk.now);
    expect(l.isBlocked("ip")).toBe(false);
    l.fail("ip");
    l.fail("ip");
    expect(l.isBlocked("ip")).toBe(false);
    l.fail("ip");
    expect(l.isBlocked("ip")).toBe(true);
    expect(l.isBlocked("other")).toBe(false);
    expect(l.count("ip")).toBe(3);
  });

  it("old attempts age out of the window", () => {
    const clk = fakeClock(1_000_000);
    const l = new AttemptLimiter(3, 10 * 60_000, clk.now);
    l.fail("ip");
    clk.advance(5 * 60_000);
    l.fail("ip");
    l.hit("ip");
    expect(l.isBlocked("ip")).toBe(true);
    clk.advance(5 * 60_000 + 1); // first attempt now older than 10 min
    expect(l.isBlocked("ip")).toBe(false);
    expect(l.count("ip")).toBe(2);
    clk.advance(10 * 60_000);
    expect(l.count("ip")).toBe(0);
  });

  it("reset(key) clears one key; reset() clears all", () => {
    const clk = fakeClock(1_000_000);
    const l = new AttemptLimiter(1, 60_000, clk.now);
    l.fail("a");
    l.fail("b");
    l.reset("a");
    expect(l.isBlocked("a")).toBe(false);
    expect(l.isBlocked("b")).toBe(true);
    l.reset();
    expect(l.isBlocked("b")).toBe(false);
  });

  it("sweep prunes expired entries", () => {
    const clk = fakeClock(1_000_000);
    const l = new AttemptLimiter(2, 60_000, clk.now);
    l.fail("a");
    l.fail("a");
    clk.advance(60_001);
    l.sweep();
    expect(l.count("a")).toBe(0);
  });
});
