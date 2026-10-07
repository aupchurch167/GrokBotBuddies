import "dotenv/config";
import * as z from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be a whole number from ${min} to ${max}` });
        return z.NEVER;
      }
      return n;
    });

const secret32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, "base64").length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
  } catch {
    return false;
  }
}, "must be base64 that decodes to exactly 32 bytes (run npm run gen:secrets)");

const schema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: int(8080, 1, 65535),
  DATABASE_URL: z.string().min(1, "is required"),
  PUBLIC_BASE_URL: z
    .string()
    .min(1, "is required")
    .refine((v) => /^https?:\/\/[^/]+$/.test(v), "must be an http(s) origin with no path and no trailing slash"),
  ADMIN_EMAIL: z.string().min(3, "is required"),
  ADMIN_PASSWORD_HASH: z.string().startsWith("$argon2id$", "must be an argon2id hash (run npm run hash-password)"),
  SESSION_SECRET: secret32,
  KEY_PEPPER: secret32,
  ENCRYPTION_KEY: secret32,
  DOORBELL_ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((v) =>
      (v && v.trim() ? v : "api2.cursor.sh")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  RETENTION_DAYS: int(90, 1, 3650),
  AUDIT_RETENTION_DAYS: int(365, 30, 3650),
  SETUP_LINK_TTL_HOURS: int(168, 1, 168),
  DOORBELL_DEBOUNCE_MS: int(15000, 0, 3_600_000),
  DOORBELL_POLL_MS: int(2000, 10, 600_000),
  DOORBELL_TIMEOUT_MS: int(8000, 50, 120_000),
  DOORBELL_DEV_ALLOW_LOCALHOST: bool(false),
  TRUST_PROXY: bool(false),
  ADMIN_TIMEZONE: z.string().optional().default("America/New_York"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional().default("info"),
});

export type Config = Readonly<z.infer<typeof schema>>;

export class ConfigError extends Error {}

/** Validates an env object. Throws a ConfigError that names every missing or invalid variable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => {
      const name = String(i.path[0] ?? "?");
      const missing = env[name] === undefined || env[name] === "";
      return `  - ${name}: ${missing ? "is required but missing" : i.message}`;
    });
    throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const c = r.data;
  if (c.DOORBELL_DEV_ALLOW_LOCALHOST && c.NODE_ENV === "production") {
    throw new ConfigError(
      "Invalid environment configuration:\n  - DOORBELL_DEV_ALLOW_LOCALHOST: must not be true when NODE_ENV=production",
    );
  }
  return Object.freeze(c);
}

function envForProcess(): Record<string, string | undefined> {
  // Under vitest, TEST_DATABASE_URL replaces DATABASE_URL.
  if (process.env["VITEST"] && process.env["TEST_DATABASE_URL"]) {
    return { ...process.env, DATABASE_URL: process.env["TEST_DATABASE_URL"] };
  }
  return process.env;
}

export const config: Config = loadConfig(envForProcess());
