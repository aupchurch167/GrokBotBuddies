import { clock } from "./clock.js";

export class SlidingWindowLimiter {
  private m = new Map<string, { start: number; curr: number; prev: number }>();
  constructor(
    private windowMs: number,
    private now: () => number = () => clock.now(),
  ) {}
  hit(key: string, limit: number): { ok: boolean; retryAfterMs: number } {
    const now = this.now();
    const w = Math.floor(now / this.windowMs) * this.windowMs;
    let s = this.m.get(key) ?? { start: w, curr: 0, prev: 0 };
    if (s.start !== w) s = { start: w, prev: w - s.start === this.windowMs ? s.curr : 0, curr: 0 };
    const elapsed = (now - w) / this.windowMs; // 0..1
    const estimate = s.prev * (1 - elapsed) + s.curr;
    if (estimate + 1 > limit) {
      const retryAfterMs =
        s.curr + 1 > limit
          ? w + this.windowMs - now // wait for the next window
          : Math.max(1000, Math.ceil((1 - (limit - s.curr - 1) / s.prev - elapsed) * this.windowMs));
      this.m.set(key, s);
      return { ok: false, retryAfterMs };
    }
    s.curr += 1;
    this.m.set(key, s);
    return { ok: true, retryAfterMs: 0 };
  }
  sweep(): void {
    const now = this.now();
    for (const [k, s] of this.m) if (now - s.start > 2 * this.windowMs) this.m.delete(k);
  }
  reset(): void {
    this.m.clear();
  }
}

export class AttemptLimiter {
  private m = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = () => clock.now(),
  ) {}
  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const arr = (this.m.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length) this.m.set(key, arr);
    else this.m.delete(key);
    return arr;
  }
  fail(key: string): void {
    const arr = this.prune(key);
    arr.push(this.now());
    this.m.set(key, arr);
  }
  hit(key: string): void {
    this.fail(key);
  }
  isBlocked(key: string): boolean {
    return this.prune(key).length >= this.max;
  }
  count(key: string): number {
    return this.prune(key).length;
  }
  reset(key?: string): void {
    if (key === undefined) this.m.clear();
    else this.m.delete(key);
  }
  sweep(): void {
    for (const k of [...this.m.keys()]) this.prune(k);
  }
}

const MIN = 60_000;

/** Process-wide limiters (single replica; see packet §9). */
export const limiters = {
  mcpCalls: new SlidingWindowLimiter(60 * MIN),
  authFail: new AttemptLimiter(30, 10 * MIN),
  adminLoginIp: new AttemptLimiter(5, 15 * MIN),
  adminLoginGlobal: new AttemptLimiter(20, 60 * MIN),
  setupTokenIp: new AttemptLimiter(20, 10 * MIN),
  setupTest: new AttemptLimiter(5, 10 * MIN),
  adminTest: new AttemptLimiter(10, 10 * MIN),
};

export function resetLimiters(): void {
  for (const l of Object.values(limiters)) l.reset();
}

let sweeper: NodeJS.Timeout | null = null;
export function startLimiterSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    for (const l of Object.values(limiters)) l.sweep();
  }, 10 * MIN);
  sweeper.unref();
}
export function stopLimiterSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
