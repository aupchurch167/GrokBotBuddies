import { prisma } from "../db.js";
import type { Bot, Message } from "../generated/prisma/client.js";
import { enqueueDoorbell } from "../doorbell/enqueue.js";
import { MSG_ID_RE, newId } from "../lib/ids.js";
import { msg, ToolError } from "../lib/toolErrors.js";
import { NOTICE_FIELD } from "../mcp/descriptions.js";
import { resolveRecipient } from "./bots.js";
import { findActiveBetween } from "./connections.js";
import { increment } from "./usage.js";

const codePoints = (s: string) => [...s].length;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const UNREAD_BACKLOG_LIMIT = 200;

export interface SendInput {
  to?: unknown;
  body?: unknown;
  subject?: unknown;
  replyToId?: unknown;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  to: { botId: string; name: string };
  createdAt: string;
  doorbell: "queued" | "not_configured" | "paused";
}

export async function sendMessage(me: Bot, input: SendInput): Promise<SendResult> {
  // 1-4: input checks
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!to) throw new ToolError(msg.emptyTo);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new ToolError(msg.emptyBody);
  const n = codePoints(body);
  if (n > 8000) throw new ToolError(msg.bodyTooLong(n));
  const subject = (typeof input.subject === "string" ? input.subject.trim() : "") || null;
  if (subject && codePoints(subject) > 200) throw new ToolError(msg.subjectTooLong(codePoints(subject)));
  const replyToId = typeof input.replyToId === "string" && input.replyToId.trim() ? input.replyToId.trim() : null;

  // 5-7: recipient + pair enforcement
  const toShown = [...to].slice(0, 60).join("");
  const recipient = await resolveRecipient(to);
  if (recipient && recipient.id === me.id) throw new ToolError(msg.sendToSelf);
  const connection = recipient ? await findActiveBetween(me.id, recipient.id) : null;
  if (!recipient || !connection) throw new ToolError(msg.notConnected(toShown));
  if (recipient.status === "DISABLED") throw new ToolError(msg.recipientDisabled(recipient.name));

  // 8: reply threading
  let threadId: string | null = null;
  if (replyToId) {
    const parent = MSG_ID_RE.test(replyToId)
      ? await prisma.message.findFirst({
          where: { id: replyToId, OR: [{ fromBotId: me.id }, { toBotId: me.id }] },
        })
      : null;
    if (!parent) throw new ToolError(msg.replyNotFound(replyToId));
    if (parent.connectionId !== connection.id) {
      const otherId = parent.fromBotId === me.id ? parent.toBotId : parent.fromBotId;
      const other = await prisma.bot.findUnique({ where: { id: otherId }, select: { name: true } });
      throw new ToolError(msg.replyWrongConversation(replyToId, other?.name ?? "another bot", recipient.name));
    }
    threadId = parent.threadId;
  }

  // 9: one transaction under a per-sender advisory lock
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"send:" + me.id}))`;
      const [win] = await tx.$queryRaw<{ n: bigint; oldest: Date | null }[]>`
        SELECT count(*) AS n, min("createdAt") AS oldest FROM "Message"
        WHERE "fromBotId" = ${me.id} AND "createdAt" > now() - interval '1 hour'`;
      const sentLastHour = Number(win?.n ?? 0);
      if (sentLastHour >= me.sendLimitPerHour) {
        const [{ now }] = (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`) as [{ now: Date }];
        const oldest = win?.oldest ?? now;
        const m = Math.max(1, Math.ceil((oldest.getTime() + 3_600_000 - now.getTime()) / 60_000));
        throw new ToolError(msg.rateSend(me.sendLimitPerHour, m));
      }
      const [unread] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Message" WHERE "toBotId" = ${recipient.id} AND "readAt" IS NULL`;
      if (Number(unread?.n ?? 0) >= UNREAD_BACKLOG_LIMIT) throw new ToolError(msg.backlog(recipient.name));

      const id = newId("msg");
      const created = await tx.message.create({
        data: {
          id,
          connectionId: connection.id,
          fromBotId: me.id,
          toBotId: recipient.id,
          threadId: threadId ?? id,
          replyToId,
          subject,
          body,
        },
      });
      await increment(me.id, "messagesSent", 1, tx);
      await increment(recipient.id, "messagesReceived", 1, tx);

      let doorbell: SendResult["doorbell"] = "not_configured";
      if (recipient.doorbellState === "OK" && recipient.webhookUrl) {
        await enqueueDoorbell(tx, recipient.id);
        doorbell = "queued";
      } else if (recipient.doorbellState === "BROKEN") {
        doorbell = "paused";
      }
      return {
        messageId: created.id,
        threadId: created.threadId,
        to: { botId: recipient.id, name: recipient.name },
        createdAt: created.createdAt.toISOString(),
        doorbell,
      };
    },
    { maxWait: 15_000, timeout: 20_000 },
  );
}

/** Unread messages to `botId` on ACTIVE connections. */
export async function unreadCount(botId: string): Promise<number> {
  return prisma.message.count({ where: { toBotId: botId, readAt: null, connection: { status: "ACTIVE" } } });
}

export async function messagesSentLastHour(botId: string): Promise<number> {
  const [r] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "Message" WHERE "fromBotId" = ${botId} AND "createdAt" > now() - interval '1 hour'`;
  return Number(r?.n ?? 0);
}

export async function checkInbox(me: Bot, input: { unreadOnly?: unknown; limit?: unknown }) {
  const unreadOnly = input.unreadOnly === undefined || input.unreadOnly === null ? true : input.unreadOnly === true;
  const limit = input.limit === undefined || input.limit === null ? 20 : input.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ToolError(msg.badLimit);
  }
  const rows = await prisma.message.findMany({
    where: { toBotId: me.id, connection: { status: "ACTIVE" }, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: { fromBot: { select: { id: true, name: true, ownerName: true } } },
  });
  return {
    notice: NOTICE_FIELD,
    unreadCount: await unreadCount(me.id),
    returned: rows.length,
    messages: rows.map((m) => ({
      messageId: m.id,
      threadId: m.threadId,
      replyToId: m.replyToId,
      from: { botId: m.fromBot.id, name: m.fromBot.name, ownerName: m.fromBot.ownerName },
      subject: m.subject,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      readAt: iso(m.readAt),
    })),
  };
}

export async function getThread(me: Bot, input: { threadId?: unknown }) {
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  const shown = [...threadId].slice(0, 60).join("");
  if (!MSG_ID_RE.test(threadId)) throw new ToolError(msg.threadNotFound(shown));
  const rows: (Message & { fromBot: { name: string } })[] = await prisma.message.findMany({
    where: { threadId, OR: [{ fromBotId: me.id }, { toBotId: me.id }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 201,
    include: { fromBot: { select: { name: true } } },
  });
  if (rows.length === 0) throw new ToolError(msg.threadNotFound(shown));
  const newest = rows[0]!;
  const otherId = newest.fromBotId === me.id ? newest.toBotId : newest.fromBotId;
  const [connection, other] = await Promise.all([
    prisma.connection.findUnique({ where: { id: newest.connectionId } }),
    prisma.bot.findUnique({ where: { id: otherId } }),
  ]);
  if (!connection || !other) throw new ToolError(msg.threadNotFound(shown));
  if (connection.status !== "ACTIVE") throw new ToolError(msg.threadRevoked(other.name));
  const truncated = rows.length > 200;
  const kept = rows.slice(0, 200).reverse();
  return {
    notice: NOTICE_FIELD,
    threadId,
    with: { botId: other.id, name: other.name, ownerName: other.ownerName },
    count: kept.length,
    truncated,
    messages: kept.map((m) => ({
      messageId: m.id,
      direction: m.fromBotId === me.id ? "sent" : "received",
      from: m.fromBot.name,
      subject: m.subject,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      readAt: iso(m.readAt),
    })),
  };
}

export async function markRead(me: Bot, input: { messageIds?: unknown }) {
  const raw = Array.isArray(input.messageIds) ? input.messageIds : [];
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new ToolError(msg.markNone);
  if (ids.length > 100) throw new ToolError(msg.markTooMany);
  const marked = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Message" SET "readAt" = now()
    WHERE id = ANY(${ids}::text[]) AND "toBotId" = ${me.id} AND "readAt" IS NULL
    RETURNING id`;
  const markedSet = new Set(marked.map((r) => r.id));
  const rest = ids.filter((id) => !markedSet.has(id));
  const already = rest.length
    ? await prisma.message.findMany({
        where: { id: { in: rest }, toBotId: me.id, readAt: { not: null } },
        select: { id: true },
      })
    : [];
  const alreadySet = new Set(already.map((r) => r.id));
  return {
    marked: markedSet.size,
    alreadyRead: rest.filter((id) => alreadySet.has(id)),
    notFound: rest.filter((id) => !alreadySet.has(id)),
    unreadCount: await unreadCount(me.id),
  };
}

