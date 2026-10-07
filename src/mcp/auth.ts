import type { MiddlewareHandler } from "hono";
import { prisma } from "../db.js";
import { hashApiKey, KEY_RE } from "../lib/apiKeys.js";
import { clientIp } from "../lib/clientIp.js";
import { clock } from "../lib/clock.js";
import { safeEqualHex } from "../lib/crypto.js";
import { log } from "../lib/logger.js";
import { limiters } from "../lib/rateLimit.js";
import { msg } from "../lib/toolErrors.js";
import type { AppEnv } from "../types.js";
import { rpcError } from "./rpc.js";

const DUMMY_HASH = "0".repeat(64);

const lastTouch = new Map<string, number>();
const pendingTouches = new Set<Promise<unknown>>();

/** At most one lastSeenAt write per bot per minute per process; fire-and-forget. */
export function touchLastSeen(botId: string): void {
  const now = clock.now();
  if (now - (lastTouch.get(botId) ?? -Infinity) < 60_000) return;
  lastTouch.set(botId, now);
  const p = prisma.$executeRaw`UPDATE "Bot" SET "lastSeenAt" = now() WHERE id = ${botId}`
    .catch((err) => log.warn({ err, botId }, "lastSeenAt update failed"))
    .finally(() => pendingTouches.delete(p));
  pendingTouches.add(p);
}

export async function flushTouches(): Promise<void> {
  while (pendingTouches.size) await Promise.allSettled([...pendingTouches]);
}

export function resetTouches(): void {
  lastTouch.clear();
}

export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = clientIp(c);
  if (limiters.authFail.isBlocked(ip)) {
    log.info({ ip, outcome: "blocked" }, "mcp auth");
    return rpcError(c, 429, msg.tooManyAuth);
  }
  const header = c.req.header("authorization");
  const m = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!m) {
    limiters.authFail.fail(ip);
    log.info({ ip, outcome: "missing" }, "mcp auth");
    return rpcError(c, 401, msg.missingKey);
  }
  const token = m[1]!;
  const km = KEY_RE.exec(token);
  const bot = km ? await prisma.bot.findUnique({ where: { apiKeyPrefix: km[1]!.slice(0, 8) } }) : null;
  const computed = hashApiKey(token); // always computed (timing)
  const ok = safeEqualHex(computed, bot?.apiKeyHash ?? DUMMY_HASH) && bot !== null;
  if (!ok || !bot) {
    limiters.authFail.fail(ip);
    log.info({ ip, outcome: "invalid" }, "mcp auth");
    return rpcError(c, 401, msg.invalidKey);
  }
  if (bot.status === "DISABLED") {
    log.info({ ip, outcome: "disabled" }, "mcp auth");
    return rpcError(c, 403, msg.disabledBot);
  }
  touchLastSeen(bot.id);
  c.set("bot", bot);
  c.set("logBotId", bot.id);
  await next();
};
