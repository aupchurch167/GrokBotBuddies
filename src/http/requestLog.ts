import type { MiddlewareHandler } from "hono";
import { randomBase62 } from "../lib/base62.js";
import { log } from "../lib/logger.js";
import type { AppEnv } from "../types.js";

/** Path for logs: query dropped, setup tokens redacted. */
export function normalizePath(path: string): string {
  const p = path.split("?")[0] ?? "/";
  if (p === "/setup" || p.startsWith("/setup/")) {
    const rest = p.split("/").slice(3).join("/");
    return rest ? `/setup/[redacted]/${rest}` : "/setup/[redacted]";
  }
  return p.length > 200 ? p.slice(0, 200) : p;
}

export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = randomBase62(12);
  const t0 = Date.now();
  c.set("requestId", requestId);
  try {
    await next();
  } finally {
    c.header("X-Request-Id", requestId);
    const botId = c.get("logBotId");
    log.info(
      {
        requestId,
        method: c.req.method,
        path: normalizePath(c.req.path),
        status: c.res.status,
        ms: Date.now() - t0,
        ...(botId ? { botId } : {}),
      },
      "request",
    );
  }
};
