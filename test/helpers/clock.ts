import { clock } from "../../src/lib/clock.js";

let fakeNow: number | null = null;

/** Freeze the in-memory clock (limiters, throttles) at `ms`. */
export function setNow(ms: number): void {
  fakeNow = ms;
  clock.now = () => fakeNow!;
}
export function advance(ms: number): void {
  if (fakeNow === null) setNow(Date.now());
  fakeNow! += ms;
}
export function resetClock(): void {
  fakeNow = null;
  clock.now = () => Date.now();
}
