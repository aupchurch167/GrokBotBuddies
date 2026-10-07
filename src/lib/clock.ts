/** Injectable clock for in-memory limiters and throttles. Tests override `clock.now`. */
export const clock = {
  now: (): number => Date.now(),
};
