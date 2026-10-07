import { prisma } from "../db.js";
import type { Bot, Connection, Prisma } from "../generated/prisma/client.js";
import { newId, orderPair } from "../lib/ids.js";

type Tx = Prisma.TransactionClient;

export async function approveConnection(
  x: string,
  y: string,
  note: string | null,
  tx: Tx = prisma,
): Promise<{ connection: Connection; reactivated: boolean; alreadyActive: boolean }> {
  if (x === y) throw new Error("Pick two different bots.");
  const [botAId, botBId] = orderPair(x, y);
  const existing = await tx.connection.findUnique({ where: { botAId_botBId: { botAId, botBId } } });
  if (existing) {
    if (existing.status === "ACTIVE") {
      return { connection: existing, reactivated: false, alreadyActive: true };
    }
    const connection = await tx.connection.update({
      where: { id: existing.id },
      data: { status: "ACTIVE", revokedAt: null, approvedAt: new Date(), ...(note ? { note } : {}) },
    });
    return { connection, reactivated: true, alreadyActive: false };
  }
  const connection = await tx.connection.create({
    data: { id: newId("con"), botAId, botBId, note: note || null },
  });
  return { connection, reactivated: false, alreadyActive: false };
}

export async function revokeConnection(id: string, tx: Tx = prisma): Promise<Connection> {
  return tx.connection.update({ where: { id }, data: { status: "REVOKED", revokedAt: new Date() } });
}

export async function findConnectionBetween(x: string, y: string, tx: Tx = prisma): Promise<Connection | null> {
  const [botAId, botBId] = orderPair(x, y);
  return tx.connection.findUnique({ where: { botAId_botBId: { botAId, botBId } } });
}

export async function findActiveBetween(x: string, y: string, tx: Tx = prisma): Promise<Connection | null> {
  const c = await findConnectionBetween(x, y, tx);
  return c && c.status === "ACTIVE" ? c : null;
}

export interface Contact {
  bot: Bot;
  connection: Connection;
}

/** ACTIVE connections of a bot, returning the other side, sorted by name. */
export async function listContacts(botId: string, tx: Tx = prisma): Promise<Contact[]> {
  const conns = await tx.connection.findMany({
    where: { status: "ACTIVE", OR: [{ botAId: botId }, { botBId: botId }] },
    include: { botA: true, botB: true },
  });
  return conns
    .map((c) => ({ bot: c.botAId === botId ? c.botB : c.botA, connection: c }))
    .sort((a, b) => a.bot.nameKey.localeCompare(b.bot.nameKey) || a.bot.id.localeCompare(b.bot.id));
}
