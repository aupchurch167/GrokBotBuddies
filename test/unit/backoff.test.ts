import { describe, expect, it } from "vitest";
import { backoff, DEFAULT_SCHEDULE_MS, parseRetryAfter } from "../../src/doorbell/backoff.js";
import { classify } from "../../src/doorbell/sender.js";

describe("backoff", () => {
  it("follows 1m, 5m, 15m, 1h with ±10% jitter", () => {
    expect(DEFAULT_SCHEDULE_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    for (let a = 1; a <= 4; a++) {
      const base = DEFAULT_SCHEDULE_MS[a - 1]!;
      expect(backoff(a, null, undefined, () => 0)).toBe(Math.round(base * 0.9));
      expect(backoff(a, null, undefined, () => 1)).toBe(Math.round(base * 1.1));
      const mid = backoff(a);
      expect(mid).toBeGreaterThanOrEqual(base * 0.9);
      expect(mid).toBeLessThanOrEqual(base * 1.1);
    }
  });

  it("honors a longer Retry-After, capped at 1 hour", () => {
    expect(backoff(1, 10 * 60_000, undefined, () => 0.5)).toBe(10 * 60_000);
    expect(backoff(1, 5_000, undefined, () => 0.5)).toBe(60_000);
    expect(backoff(1, 5 * 3_600_000, undefined, () => 0.5)).toBe(3_600_000);
  });

  it("supports an injected schedule", () => {
    expect(backoff(2, null, [100, 200, 300, 400], () => 0.5)).toBe(200);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(parseRetryAfter("Wed, 07 Oct 2026 12:05:00 GMT", now)).toBe(300_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe("classify (§10.5)", () => {
  const resp = (status: number) => classify({ kind: "response", status, retryAfterMs: null });
  it("2xx is success", () => {
    expect(resp(200).cls).toBe("success");
    expect(resp(202).cls).toBe("success");
  });
  it("408, 429, 5xx are retryable", () => {
    for (const s of [408, 429, 500, 502, 503]) expect(resp(s).cls).toBe("retryable");
  });
  it("3xx and other 4xx are permanent with summaries", () => {
    expect(resp(302)).toMatchObject({ cls: "permanent", summary: "redirect not allowed (HTTP 302)" });
    expect(resp(401)).toMatchObject({ cls: "permanent", summary: "HTTP 401 (sender key rejected)" });
    expect(resp(404)).toMatchObject({ cls: "permanent", summary: "HTTP 404 (webhook not found)" });
    for (const s of [400, 403, 405, 410, 413, 422]) expect(resp(s).cls).toBe("permanent");
  });
  it("network errors are retryable, SSRF blocks are permanent", () => {
    expect(classify({ kind: "error", code: "timeout", detail: "timeout after 8000ms" }).cls).toBe("retryable");
    expect(classify({ kind: "error", code: "network", detail: "network error (ECONNRESET)" }).cls).toBe("retryable");
    expect(classify({ kind: "error", code: "dns", detail: "DNS lookup failed" }).cls).toBe("retryable");
    expect(classify({ kind: "error", code: "blocked", detail: "blocked: private address" }).cls).toBe("permanent");
  });
});
