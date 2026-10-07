import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { log } from "../lib/logger.js";
import { utcMonth } from "../lib/time.js";

export type UsageField = "messagesSent" | "messagesReceived" | "mcpCalls" | "doorbellsSent" | "doorbellsFailed";

// Fixed SQL identifiers per field; nothing user-supplied is ever interpolated.
const COLUMNS: Record<UsageField, Prisma.Sql> = {
  messagesSent: Prisma.raw('"messagesSent"'),
  messagesReceived: Prisma.raw('"messagesReceived"'),
  mcpCalls: Prisma.raw('"mcpCalls"'),
  doorbellsSent: Prisma.raw('"doorbellsSent"'),
  doorbellsFailed: Prisma.raw('"doorbellsFailed"'),
};

type RawClient = Pick<Prisma.TransactionClient, "$executeRaw">;

export async function increment(botId: string, field: UsageField, n = 1, tx: RawClient = prisma): Promise<void> {
  const col = COLUMNS[field];
  if (!col) throw new Error(`unknown usage field`);
  const month = utcMonth(new Date());
  await tx.$executeRaw`
    INSERT INTO "UsageCounter" ("botId", month, ${col}, "updatedAt") VALUES (${botId}, ${month}, ${n}, now())
    ON CONFLICT ("botId", month) DO UPDATE SET ${col} = "UsageCounter".${col} + EXCLUDED.${col}, "updatedAt" = now()`;
}

const pending = new Set<Promise<void>>();

/** Fire-and-forget increment (errors are logged at warn). */
export function incrementLater(botId: string, field: UsageField, n = 1): void {
  const p = increment(botId, field, n)
    .catch((err) => log.warn({ err, botId, field }, "usage increment failed"))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Waits for fire-and-forget writes (tests, shutdown). */
export async function flushUsage(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

export async function usageFor(botId: string, month = utcMonth(new Date())) {
  const row = await prisma.usageCounter.findUnique({ where: { botId_month: { botId, month } } });
  return {
    month,
    messagesSent: row?.messagesSent ?? 0,
    messagesReceived: row?.messagesReceived ?? 0,
    mcpCalls: row?.mcpCalls ?? 0,
    doorbellsSent: row?.doorbellsSent ?? 0,
    doorbellsFailed: row?.doorbellsFailed ?? 0,
  };
}
