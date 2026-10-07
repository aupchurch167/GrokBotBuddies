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
    serializers: { err: safeErr },
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

/**
 * Error summary safe to log: type, code, and only the first line of the message (Prisma puts
 * query arguments, which may include message bodies, on later lines), plus the stack frames.
 */
export function safeErr(e: unknown): { type: string; code?: string; message: string; stack?: string } {
  if (!(e instanceof Error)) return { type: typeof e, message: "non-error thrown" };
  const first = (e.message.split("\n").find((l) => l.trim()) ?? "").slice(0, 200);
  const frames = (e.stack ?? "").split("\n").filter((l) => l.trimStart().startsWith("at ")).slice(0, 8).join("\n");
  const code = (e as { code?: unknown }).code;
  return { type: e.name, ...(typeof code === "string" ? { code } : {}), message: first, ...(frames ? { stack: frames } : {}) };
}
