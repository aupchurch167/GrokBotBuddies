import { defineConfig } from "vitest/config";

// Dummy, non-secret values for tests only. Real values come from the environment (see .env.example).
const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/botbridge_test",
  PUBLIC_BASE_URL: "http://localhost:8080",
  ADMIN_EMAIL: "admin@example.test",
  // argon2id hash of "test-admin-password-123"
  ADMIN_PASSWORD_HASH:
    "$argon2id$v=19$m=65536,p=4,t=3$6PmR0h5l9IQaHWmaVpqHBg$bdLWAJWFI59MBwDAENX/9pluRYjQ+dtrbIIPiZPDMIA",
  SESSION_SECRET: "JO7Ey4Xfq/3S7f3dzAUjT2SvzNpqRPX1UKzFpMSvmHs=",
  KEY_PEPPER: "3XKp/OApqc2LATZ7mpwyB1Xk/ngFpLpexCuM7AoX97I=",
  ENCRYPTION_KEY: "Ke1MeN8Mq6W5SWzi+aVBHiN09eOby/YK/+xzAptIqnQ=",
  DOORBELL_ALLOWED_HOSTS: "api2.cursor.sh",
  DOORBELL_DEBOUNCE_MS: "200",
  DOORBELL_POLL_MS: "50",
  DOORBELL_TIMEOUT_MS: "500",
  DOORBELL_DEV_ALLOW_LOCALHOST: "true",
  TRUST_PROXY: "true",
  LOG_LEVEL: "info",
};
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(testEnv)) env[k] = process.env[k] ?? v;
// Always isolate the test env from a developer's real .env for these.
env["NODE_ENV"] = "test";
env["DOORBELL_DEV_ALLOW_LOCALHOST"] = "true";

export default defineConfig({
  test: {
    env,
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
