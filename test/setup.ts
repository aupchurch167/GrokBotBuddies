import { afterEach, beforeEach } from "vitest";
import { setLogSink } from "../src/lib/logger.js";
import { resetLimiters } from "../src/lib/rateLimit.js";
import { flushTouches, resetTouches } from "../src/mcp/auth.js";
import { flushUsage } from "../src/services/usage.js";
import { truncateAll } from "./helpers/db.js";
import { resetClock } from "./helpers/clock.js";

// Keep test output quiet; logCapture swaps in its own sink when a test needs logs.
setLogSink({ write: () => {} });

beforeEach(async () => {
  await flushUsage();
  await flushTouches();
  resetTouches();
  await truncateAll();
  resetLimiters();
  resetClock();
});

afterEach(() => {
  resetClock();
});
