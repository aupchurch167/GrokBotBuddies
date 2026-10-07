import { setLogSink } from "../../src/lib/logger.js";

export function captureLogs(): { lines: string[]; text: () => string; stop: () => void } {
  const lines: string[] = [];
  setLogSink({ write: (chunk) => void lines.push(chunk) });
  return {
    lines,
    text: () => lines.join(""),
    stop: () => setLogSink({ write: () => {} }),
  };
}
