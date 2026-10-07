import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { config } from "../config.js";

const https = config.PUBLIC_BASE_URL.startsWith("https://");

const html = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    baseUri: ["'none'"],
  },
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  strictTransportSecurity: https ? "max-age=31536000" : false,
  xFrameOptions: "DENY",
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: "same-origin",
});

/** Security headers everywhere; /mcp gets the minimal set so browser MCP clients keep working. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  if (c.req.path === "/mcp") {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (https) c.header("Strict-Transport-Security", "max-age=31536000");
    return;
  }
  return html(c, next);
};

/** Cache-Control: no-store for private pages. */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};
