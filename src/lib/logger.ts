import { Writable } from "node:stream";
import pino from "pino";
import { config } from "../config.js";

type Sink = { write(chunk: string): void };
let sink: Sink = { write: (chunk) => void process.stdout.write(chunk) };

/** Tests swap the sink to capture log lines in memory. */
export function setLogSink(s: Sink | null): void {
  sink = s ?? { write: (chunk) => void process.stdout.write(chunk) };
}

const destination = new Writable({
  write(chunk: Buffer | string, _enc, cb) {
    try {
      sink.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    } finally {
      cb();
    }
  },
});

export const log = pino(
  {
    level: config.LOG_LEVEL,
    base: { service: "bot-bridge" },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-automation-key"]',
        "headers.authorization",
        'headers["x-automation-key"]',
        "headers.cookie",
        "*.apiKey",
        "*.key",
        "*.token",
        "*.senderKey",
        "*.webhookKey",
        "*.webhookKeyEnc",
        "*.apiKeyEnc",
        "*.password",
        "*.passwordHash",
        "*.body",
        "*.subject",
        "*.webhookUrl",
      ],
      censor: "[REDACTED]",
    },
  },
  destination,
);
