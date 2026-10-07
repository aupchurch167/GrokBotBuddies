export const DEFAULT_SCHEDULE_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const MAX_ATTEMPTS = 5;
const CAP_MS = 60 * 60_000;

/**
 * Delay before the next attempt after `attempts` failed attempts (1-based), with ±10% jitter.
 * A Retry-After hint wins when it is longer, capped at 1 hour.
 */
export function backoff(
  attempts: number,
  retryAfterMs?: number | null,
  schedule: number[] = DEFAULT_SCHEDULE_MS,
  random: () => number = Math.random,
): number {
  const base = schedule[Math.min(Math.max(attempts, 1), schedule.length) - 1]!;
  const jittered = Math.round(base * (0.9 + 0.2 * random()));
  if (retryAfterMs && retryAfterMs > 0) return Math.min(Math.max(jittered, retryAfterMs), Math.max(CAP_MS, jittered));
  return jittered;
}

/** Parses Retry-After (delta seconds or HTTP date) into ms; null if absent/invalid. */
export function parseRetryAfter(value: string | undefined | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, CAP_MS);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.min(Math.max(0, t - now), CAP_MS);
}
