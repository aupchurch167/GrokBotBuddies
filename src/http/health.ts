import type { Hono } from "hono";
import { log } from "../lib/logger.js";
import type { AppEnv } from "../types.js";

export interface HealthDb {
  $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
}

export function registerHealth(app: Hono<AppEnv>, db: HealthDb): void {
  app.get("/api/health", async (c) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return c.json({ ok: true }, 200);
    } catch (err) {
      log.warn({ err }, "health check failed");
      return c.json({ ok: false }, 503);
    }
  });
}
