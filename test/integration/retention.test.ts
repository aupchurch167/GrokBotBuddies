import { describe, expect, it } from "vitest";
import { runRetention } from "../../src/jobs/retention.js";
import { newId } from "../../src/lib/ids.js";
import { increment } from "../../src/services/usage.js";
import { testApp } from "../helpers/app.js";
import { prisma } from "../helpers/db.js";
import { trio } from "../helpers/factories.js";
import { McpTestClient } from "../helpers/mcpClient.js";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function msgAt(connectionId: string, from: string, to: string, createdAt: Date, threadId?: string) {
  const id = newId("msg");
  return prisma.message.create({
    data: { id, connectionId, fromBotId: from, toBotId: to, threadId: threadId ?? id, body: "b", createdAt },
  });
}

describe("retention", () => {
  it("A-49 purges old rows, keeps new ones and usage, audits counts, and is a no-op within 23 h", async () => {
    const { A, B, ab } = await trio();
    const oldMsg = await msgAt(ab.id, A.bot.id, B.bot.id, ago(91));
    const newMsg = await msgAt(ab.id, A.bot.id, B.bot.id, ago(89));
    const job = (status: "SENT" | "FAILED" | "CANCELLED" | "PENDING", days: number) =>
      prisma.doorbellJob.create({
        data: {
          id: newId("dbj"),
          botId: B.bot.id,
          status,
          coalesceKey: status === "PENDING" ? B.bot.id : null,
          nextAttemptAt: ago(days),
          createdAt: ago(days),
        },
      });
    const oldSent = await job("SENT", 31);
    const oldFailed = await job("FAILED", 40);
    const oldCancelled = await job("CANCELLED", 31);
    const newSent = await job("SENT", 29);
    const oldPending = await job("PENDING", 45);
    await prisma.setupLink.create({
      data: { id: newId("sl"), botId: A.bot.id, tokenHash: "a".repeat(64), expiresAt: ago(31) },
    });
    await prisma.setupLink.create({
      data: { id: newId("sl"), botId: A.bot.id, tokenHash: "b".repeat(64), expiresAt: ago(29) },
    });
    await prisma.adminSession.create({
      data: { id: newId("ses"), tokenHash: "c".repeat(64), csrfToken: "x", expiresAt: ago(1) },
    });
    await prisma.adminSession.create({
      data: {
        id: newId("ses"),
        tokenHash: "d".repeat(64),
        csrfToken: "x",
        expiresAt: new Date(Date.now() + DAY),
        lastSeenAt: new Date(Date.now() - 13 * 3_600_000),
      },
    });
    await prisma.adminSession.create({
      data: { id: newId("ses"), tokenHash: "e".repeat(64), csrfToken: "x", expiresAt: new Date(Date.now() + DAY) },
    });
    await prisma.auditLog.create({
      data: { id: newId("aud"), actorType: "SYSTEM", action: "ADMIN_LOGIN", createdAt: ago(366) },
    });
    await prisma.auditLog.create({
      data: { id: newId("aud"), actorType: "SYSTEM", action: "ADMIN_LOGIN", createdAt: ago(364) },
    });
    await increment(A.bot.id, "messagesSent", 7);
    await prisma.usageCounter.create({ data: { botId: A.bot.id, month: "2020-01", messagesSent: 3 } });

    const counts = await runRetention();
    expect(counts).toEqual({ messages: 1, doorbellJobs: 3, setupLinks: 1, sessions: 2, auditRows: 1 });

    expect(await prisma.message.findUnique({ where: { id: oldMsg.id } })).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: newMsg.id } })).not.toBeNull();
    for (const j of [oldSent, oldFailed, oldCancelled]) expect(await prisma.doorbellJob.findUnique({ where: { id: j.id } })).toBeNull();
    expect(await prisma.doorbellJob.findUnique({ where: { id: newSent.id } })).not.toBeNull();
    expect(await prisma.doorbellJob.findUnique({ where: { id: oldPending.id } })).not.toBeNull();
    expect(await prisma.setupLink.count()).toBe(1);
    expect(await prisma.adminSession.count()).toBe(1);
    expect(await prisma.usageCounter.count({ where: { botId: A.bot.id } })).toBe(2);

    const audits = await prisma.auditLog.findMany({ where: { action: "RETENTION_PURGE" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "SYSTEM", actorId: null });
    expect(audits[0]!.metadata).toEqual(counts);
    const run = await prisma.jobRun.findUnique({ where: { name: "retention" } });
    expect(run?.lastResult).toEqual(counts);

    // Second run within 23 h is a no-op, even with new purgeable data.
    await msgAt(ab.id, A.bot.id, B.bot.id, ago(100));
    expect(await runRetention()).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "RETENTION_PURGE" } })).toBe(1);
    // ...but runs again once 23 h have passed.
    await prisma.jobRun.update({ where: { name: "retention" }, data: { lastRunAt: new Date(Date.now() - 24 * 3_600_000) } });
    expect((await runRetention())?.messages).toBe(1);
  });

  it("deletes in batches until none remain", async () => {
    const { A, B, ab } = await trio();
    const rows = Array.from({ length: 2500 }, () => {
      const id = newId("msg");
      return { id, connectionId: ab.id, fromBotId: A.bot.id, toBotId: B.bot.id, threadId: id, body: "b", createdAt: ago(100) };
    });
    await prisma.message.createMany({ data: rows });
    const counts = await runRetention();
    expect(counts?.messages).toBe(2500);
    expect(await prisma.message.count()).toBe(0);
  });

  it("A-50 a thread whose root message was purged still loads via get_thread", async () => {
    const { A, B, ab } = await trio();
    const root = await msgAt(ab.id, A.bot.id, B.bot.id, ago(95));
    const reply = await prisma.message.create({
      data: {
        id: newId("msg"),
        connectionId: ab.id,
        fromBotId: B.bot.id,
        toBotId: A.bot.id,
        threadId: root.id,
        replyToId: root.id,
        body: "still here",
        createdAt: ago(1),
      },
    });
    await runRetention();
    expect(await prisma.message.findUnique({ where: { id: root.id } })).toBeNull();
    const a = new McpTestClient(testApp(), A.key);
    const t = await a.ok("get_thread", { threadId: root.id });
    expect(t.count).toBe(1);
    expect(t.messages[0].messageId).toBe(reply.id);
    expect(t.messages[0].body).toBe("still here");
    // Replying to the surviving message keeps the original threadId.
    const r = await a.ok("send_message", { to: "Test B", body: "ok", replyToId: reply.id });
    expect(r.threadId).toBe(root.id);
  });
});
