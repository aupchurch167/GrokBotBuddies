import { prisma } from "../db.js";
import type { Bot, Prisma } from "../generated/prisma/client.js";
import { generateApiKey } from "../lib/apiKeys.js";
import { BOT_ID_RE, nameKey, newId } from "../lib/ids.js";

export interface BotInput {
  name: string;
  ownerName: string;
  ownerEmail?: string | null;
  notes?: string | null;
  sendLimitPerHour?: number;
  mcpCallLimitPerHour?: number;
}

export class DuplicateNameError extends Error {
  constructor(public botName: string) {
    super(`A bot named '${botName}' already exists.`);
  }
}

type Tx = Prisma.TransactionClient;

function isUniqueViolation(e: unknown, field?: string): boolean {
  const err = e as { code?: string; meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } } };
  if (err?.code !== "P2002") return false;
  if (!field) return true;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === "string") return target.includes(field);
  const fields = err.meta?.driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(fields)) return fields.some((f) => f.replace(/"/g, "") === field);
  return JSON.stringify(err.meta ?? {}).includes(field);
}
export { isUniqueViolation };

/** Creates a bot with a fresh API key. Returns the plaintext key (shown once by the caller). */
export async function createBot(input: BotInput, tx: Tx = prisma): Promise<{ bot: Bot; key: string }> {
  const nk = nameKey(input.name);
  if (await tx.bot.findUnique({ where: { nameKey: nk } })) throw new DuplicateNameError(input.name.trim());
  for (let attempt = 0; ; attempt++) {
    const k = generateApiKey();
    try {
      const bot = await tx.bot.create({
        data: {
          id: newId("bot"),
          name: input.name.trim().replace(/\s+/g, " "),
          nameKey: nk,
          ownerName: input.ownerName.trim(),
          ownerEmail: input.ownerEmail?.trim() || null,
          notes: input.notes?.trim() || null,
          apiKeyPrefix: k.prefix,
          apiKeyHash: k.hash,
          sendLimitPerHour: input.sendLimitPerHour ?? 60,
          mcpCallLimitPerHour: input.mcpCallLimitPerHour ?? 600,
        },
      });
      return { bot, key: k.key };
    } catch (e) {
      if (isUniqueViolation(e, "nameKey")) throw new DuplicateNameError(input.name.trim());
      if (isUniqueViolation(e, "apiKeyPrefix") && attempt < 4) continue;
      throw e;
    }
  }
}

/** Replaces the bot's key. The old key stops working immediately. */
export async function rotateKey(botId: string, tx: Tx = prisma): Promise<{ bot: Bot; key: string }> {
  for (let attempt = 0; ; attempt++) {
    const k = generateApiKey();
    try {
      const bot = await tx.bot.update({
        where: { id: botId },
        data: { apiKeyPrefix: k.prefix, apiKeyHash: k.hash, apiKeyRotatedAt: new Date() },
      });
      return { bot, key: k.key };
    } catch (e) {
      if (isUniqueViolation(e, "apiKeyPrefix") && attempt < 4) continue;
      throw e;
    }
  }
}

/** Cancels the bot's coalescible doorbell jobs. */
export async function cancelPendingDoorbells(botId: string, reason: string, tx: Tx = prisma): Promise<number> {
  const r = await tx.doorbellJob.updateMany({
    where: { botId, status: { in: ["PENDING", "RETRYING"] } },
    data: { status: "CANCELLED", coalesceKey: null, lastError: reason },
  });
  return r.count;
}

export async function disableBot(botId: string, tx?: Tx): Promise<Bot> {
  const run = async (t: Tx) => {
    const bot = await t.bot.update({ where: { id: botId }, data: { status: "DISABLED", disabledAt: new Date() } });
    await cancelPendingDoorbells(botId, "bot disabled", t);
    return bot;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

export async function enableBot(botId: string, tx: Tx = prisma): Promise<Bot> {
  return tx.bot.update({ where: { id: botId }, data: { status: "ACTIVE", disabledAt: null } });
}

/** Finds a bot by id (bot_…) or by name (case/space-insensitive). */
export async function resolveRecipient(to: string, tx: Tx = prisma): Promise<Bot | null> {
  if (BOT_ID_RE.test(to)) return tx.bot.findUnique({ where: { id: to } });
  return tx.bot.findUnique({ where: { nameKey: nameKey(to) } });
}

export function doorbellLabel(bot: Pick<Bot, "doorbellState">): "set" | "not set" | "broken" {
  return bot.doorbellState === "OK" ? "set" : bot.doorbellState === "BROKEN" ? "broken" : "not set";
}
