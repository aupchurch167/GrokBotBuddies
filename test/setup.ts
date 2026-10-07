import { afterEach, beforeEach } from "vitest";
import { setLogSink } from "../src/lib/logger.js";
import { resetLimiters } from "../src/lib/rateLimit.js";
import { truncateAll } from "./helpers/db.js";
import { resetClock } from "./helpers/clock.js";

// Keep test output quiet; logCapture swaps in its own sink when a test needs logs.
setLogSink({ write: () => {} });

beforeEach(async () => {
  await truncateAll();
  resetLimiters();
  resetClock();
});

afterEach(() => {
  resetClock();
});
