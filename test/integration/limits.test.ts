import { describe, expect, it } from "vitest";
import type { Bot, Connection } from "../../src/generated/prisma/client.js";
import { newId } from "../../src/lib/ids.js";
import { flushUsage } from "../../src/services/usage.js";
import { testApp } from "../helpers/app.js";
import { setNow, advance } from "../helpers/clock.js";
import { prisma } from "../helpers/db.js";
import { connect, makeBot, trio } from "../helpers/factories.js";
import { McpTestClient } from "../helpers/mcpClient.js";

const rateSend = (limit: number, m: number) =>
  `Rate limit reached: this bot can send ${limit} messages per hour. Try again in about ${m} minute${m === 1 ? "" : "s"}.`;
const rateMcp = (limit: number, m: number) =>
  `Rate limit reached: this bot can make ${limit} Bot Bridge tool calls per hour. Try again in about ${m} minute${m === 1 ? "" : "s"}.`;
const backlog = (name: string) =>
  `'${name}' already has 200 unread messages waiting, so Bot Bridge won't accept more until they catch up. Try again later.`;

const MIN = 60_000;

/** Inserts `n` messages from→to directly, with createdAt = ageMs[i] ago. */
async function insertMessages(
  from: Bot,
  to: Bot,
  conn: Connection,
  n: number,
  ageMs: (i: number) => number,
  readAt: Date | null = null,
): Promise<string[]> {
  const now = Date.now();
  const data = Array.from({ length: n }, (_, i) => {
    const id = newId("msg");
    return {
      id,
      connectionId: conn.id,
      fromBotId: from.id,
      toBotId: to.id,
      threadId: id,
      body: `seed ${i}`,
      createdAt: new Date(now - ageMs(i)),
      readAt,
    };
  });
  await prisma.message.createMany({ data });
  return data.map((d) => d.id);
}

describe("A-23 send rate limit", () => {
  it("61st send within an hour → exact rate message (60 real sends)", async () => {
    const { A } = await trio();
    const a = new McpTestClient(testApp(), A.key);
    for (let i = 0; i < 60; i++) await a.ok("send_message", { to: "Test B", body: `n${i}` });
    expect(await a.err("send_message", { to: "Test B", body: "one too many" })).toBe(rateSend(60, 60));
    expect(await prisma.message.count({ where: { fromBotId: A.bot.id } })).toBe(60);
  });

  it("minutes are computed from the oldest message in the window", async () => {
    const { A, B, ab } = await trio();
    const a = new McpTestClient(testApp(), A.key);
    // 60 in the window, oldest 55 min ago; plus older ones outside the window that don't count.
    await insertMessages(A.bot, B.bot, ab, 5, () => 2 * 60 * MIN);
    await insertMessages(A.bot, B.bot, ab, 60, (i) => (i === 0 ? 55 * MIN : 10 * MIN));
    expect(await a.err("send_message", { to: "Test B", body: "x" })).toBe(rateSend(60, 5));
    expect((await a.ok("whoami")).limits.messagesSentLastHour).toBe(60);
  });

  it("singular 'minute' when about 1 minute remains", async () => {
    const { A, B, ab } = await trio();
    const a = new McpTestClient(testApp(), A.key);
    await insertMessages(A.bot, B.bot, ab, 60, (i) => (i === 0 ? 59 * MIN + 30_000 : 5 * MIN));
    expect(await a.err("send_message", { to: "Test B", body: "x" })).toBe(rateSend(60, 1));
  });

  it("respects a custom sendLimitPerHour, and messages older than an hour don't count", async () => {
    const A = await makeBot({ name: "Lim A", sendLimitPerHour: 3 });
    const B = await makeBot({ name: "Lim B" });
    const ab = await connect(A.bot, B.bot);
    const a = new McpTestClient(testApp(), A.key);
    await insertMessages(A.bot, B.bot, ab, 10, () => 61 * MIN);
    await insertMessages(A.bot, B.bot, ab, 2, () => 20 * MIN);
    await a.ok("send_message", { to: "Lim B", body: "third" });
    expect(await a.err("send_message", { to: "Lim B", body: "fourth" })).toBe(rateSend(3, 40));
  });

  it("10 concurrent sends with 5 slots left → exactly 5 succeed; never exceeds the limit", async () => {
    const { A, B, ab } = await trio();
    const app = testApp();
    await insertMessages(A.bot, B.bot, ab, 55, () => 30 * MIN);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => new McpTestClient(app, A.key).call("send_message", { to: "Test B", body: `c${i}` })),
    );
    const ok = results.filter((r) => !r.isError);
    const failed = results.filter((r) => r.isError);
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(5);
    for (const f of failed) expect(f.text).toBe(rateSend(60, 30));
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "Message" WHERE "fromBotId" = ${A.bot.id} AND "createdAt" > now() - interval '1 hour'`;
    expect(Number(n)).toBe(60);
    await flushUsage();
    const usage = await prisma.usageCounter.findFirstOrThrow({ where: { botId: A.bot.id } });
    expect(usage.messagesSent).toBe(5);
  });
});

describe("A-24 MCP-call limit, backlog, usage", () => {
  it("mcpCallLimitPerHour=5 → 6th tool call gets the exact message", async () => {
    setNow(Date.UTC(2026, 9, 7, 12, 15, 0)); // 15 min into an hour window → 45 min left
    const A = await makeBot({ name: "Busy", mcpCallLimitPerHour: 5 });
    const a = new McpTestClient(testApp(), A.key);
    for (let i = 0; i < 5; i++) await a.ok(i % 2 ? "whoami" : "list_contacts");
    expect(await a.err("whoami")).toBe(rateMcp(5, 45));
    expect(await a.err("check_inbox")).toBe(rateMcp(5, 45));
    await flushUsage();
    const usage = await prisma.usageCounter.findFirstOrThrow({ where: { botId: A.bot.id } });
    expect(usage.mcpCalls).toBe(5); // rate-limited calls are not counted

    // Another bot is unaffected.
    const other = await makeBot({ name: "Calm" });
    await new McpTestClient(testApp(), other.key).ok("whoami");

    // Next window: allowed again (prev window weighs in, so wait it out fully).
    advance(45 * MIN + 60 * MIN);
    await a.ok("whoami");
  });

  it("limit change applies on the next request", async () => {
    setNow(Date.UTC(2026, 9, 7, 12, 59, 0)); // 1 min left in the window
    const A = await makeBot({ name: "Busy2", mcpCallLimitPerHour: 2 });
    const a = new McpTestClient(testApp(), A.key);
    await a.ok("whoami");
    await a.ok("whoami");
    expect(await a.err("whoami")).toBe(rateMcp(2, 1));
    await prisma.bot.update({ where: { id: A.bot.id }, data: { mcpCallLimitPerHour: 10 } });
    await a.ok("whoami");
  });

  it("recipient with 200 unread → exact backlog message; 199 is fine", async () => {
    const { A, B, C, ab } = await trio();
    const bc = await connect(B.bot, C.bot);
    const a = new McpTestClient(testApp(), A.key);
    // 150 from A + 49 from C (old enough not to count toward anyone's send limit) = 199 unread
    const fromA = await insertMessages(A.bot, B.bot, ab, 150, () => 2 * 60 * MIN);
    await insertMessages(C.bot, B.bot, bc, 49, () => 2 * 60 * MIN);
    // read messages don't count
    await insertMessages(A.bot, B.bot, ab, 30, () => 3 * 60 * MIN, new Date());
    await a.ok("send_message", { to: "Test B", body: "the 200th" });
    expect(await a.err("send_message", { to: "Test B", body: "201st" })).toBe(backlog("Test B"));
    expect(await prisma.message.count({ where: { toBotId: B.bot.id, readAt: null } })).toBe(200);

    // Once B catches up a little, sends are accepted again.
    await new McpTestClient(testApp(), B.key).ok("mark_read", { messageIds: fromA.slice(0, 1) });
    await a.ok("send_message", { to: "Test B", body: "ok now" });
  });

  it("usage counters: messagesSent, messagesReceived, mcpCalls", async () => {
    const { A, B, a, b } = await (async () => {
      const t = await trio();
      const app = testApp();
      return { ...t, a: new McpTestClient(app, t.A.key), b: new McpTestClient(app, t.B.key) };
    })();
    await a.ok("send_message", { to: "Test B", body: "1" });
    await a.ok("send_message", { to: "Test B", body: "2" });
    await a.ok("send_message", { to: "Test B", body: "3" });
    await a.err("send_message", { to: "Test A", body: "self" }); // tool error: counts as a call, not a send
    await b.ok("send_message", { to: "Test A", body: "back" });
    await b.ok("check_inbox");
    await flushUsage();

    const month = new Date().toISOString().slice(0, 7);
    const ua = await prisma.usageCounter.findUniqueOrThrow({ where: { botId_month: { botId: A.bot.id, month } } });
    const ub = await prisma.usageCounter.findUniqueOrThrow({ where: { botId_month: { botId: B.bot.id, month } } });
    expect(ua).toMatchObject({ messagesSent: 3, messagesReceived: 1, mcpCalls: 4, doorbellsSent: 0 });
    expect(ub).toMatchObject({ messagesSent: 1, messagesReceived: 3, mcpCalls: 2, doorbellsSent: 0 });

    // whoami reports the same numbers (plus possibly its own call).
    const w = await a.ok("whoami");
    expect(w.usageThisMonth).toMatchObject({ month, messagesSent: 3, messagesReceived: 1 });
    expect([4, 5]).toContain(w.usageThisMonth.toolCalls);
  });
});
