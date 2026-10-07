import { Hono } from "hono";
import { prisma } from "./db.js";
import { notFound, onError } from "./http/errorPages.js";
import { registerHealth, type HealthDb } from "./http/health.js";
import { requestLog } from "./http/requestLog.js";
import { securityHeaders } from "./http/securityHeaders.js";
import { registerMcp } from "./mcp/route.js";
import { registerAdmin, type AdminOptions } from "./admin/routes.js";
import { registerSetup } from "./setup/routes.js";
import { runRetention } from "./jobs/retention.js";
import type { AppEnv } from "./types.js";

export interface AppDeps {
  /** DB used by the health check (tests inject a failing client). */
  healthDb?: HealthDb;
  admin?: AdminOptions;
}

export function buildApp(deps: AppDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestLog);
  app.use("*", securityHeaders);

  app.get("/", (c) => c.text("Bot Bridge is running. Bots connect at /mcp."));
  registerHealth(app, deps.healthDb ?? prisma);
  registerMcp(app);
  registerAdmin(app, {
    runRetention: (actor) => runRetention({ force: true, actor }),
    ...deps.admin,
  });
  registerSetup(app);

  app.notFound(notFound);
  app.onError(onError);
  return app;
}
