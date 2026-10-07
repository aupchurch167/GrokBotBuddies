import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../config.js";

export function clientIp(c: Context): string {
  if (config.TRUST_PROXY) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
      if (last) return last.slice(0, 64);
    }
  }
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr.slice(0, 64);
  } catch {
    // app.request() in tests has no socket
  }
  return "unknown";
}
