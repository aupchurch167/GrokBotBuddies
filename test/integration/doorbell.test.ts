import { afterEach, describe, expect, it } from "vitest";
import { DoorbellWorker } from "../../src/doorbell/worker.js";
import { newId } from "../../src/lib/ids.js";
import { disableBot } from "../../src/services/bots.js";
import { usageFor } from "../../src/services/usage.js";
import { testApp } from "../helpers/app.js";
import { prisma } from "../helpers/db.js";
import { connect, makeBot, setDoorbell, trio } from "../helpers/factories.js";
import { McpTestClient } from "../helpers/mcpClient.js";
import { sleep, startMockWebhook, waitFor, type Reply } from "../helpers/mockWebhook.js";

const SENDER_KEY = "sender-key-for-doorbell-tests";
const FAST = [100, 100, 100, 100];

let workers: DoorbellWorker[] = [];
let mocks: Awaited<ReturnType<typeof startMockWebhook>>[] = [];

afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop(2000)));
  await Promise.all(mocks.map((m) => m.close()));
  workers = [];
  mocks = [];
});

async function setup(script: (Reply | number)[] = [200]) {
  const mock = await startMockWebhook(script);
  mocks.push(mock);
  const t = await trio();
  await setDoorbell(t.B.bot.id, mock.url, SENDER_KEY);
  const app = testApp();
  const a = new McpTestClient(app, t.A.key);
  const b = new McpTestClient(app, t.B.key);
  return { ...t, mock, app, a, b };
}

function startWorker(opts: ConstructorParameters<typeof DoorbellWorker>[0] = {}) {
  const w = new DoorbellWorker({ backoffSchedule: FAST, ...opts });
  workers.push(w);
  w.start();
  return w;
}

const jobsFor = (botId: string) => prisma.doorbellJob.findMany({ where: { botId }, orderBy: { createdAt: "asc" } });

describe("doorbell", () => {
  it("A-25 one send → exactly one content-free POST after the debounce, with both auth headers", async () => {
    const { mock, a, B } = await setup([200]);
    startWorker();
    const t0 = Date.now();
    const sent = await a.ok("send_message", { to: "Test B", subject: "Secret subject", body: "CANARY body text" });
    expect(sent.doorbell).toBe("queued");
    await waitFor(() => mock.requests.length >= 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    await sleep(400);
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/automations/webhook/routine-abc123");
    expect(req.headers["authorization"]).toBe(`Bearer ${SENDER_KEY}`);
    expect(req.headers["x-automation-key"]).toBe(SENDER_KEY);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["user-agent"]).toBe("BotBridge-Doorbell/1.0");
    const body = JSON.parse(req.body);
    expect(Object.keys(body).sort()).toEqual(["event", "from", "ts", "unread"]);
    expect(body).toMatchObject({ event: "bridge.new_message", unread: 1, from: "Test A" });
    expect(typeof body.ts).toBe("number");
    expect(req.body).not.toContain("CANARY");
    expect(req.body).not.toContain("Secret subject");
    await waitFor(async () => (await jobsFor(B.bot.id))[0]?.status === "SENT");
  });

  for (const count of [2, 5]) {
    it(`A-26 ${count} sends within the debounce window → exactly one POST with unread=${count}`, async () => {
      const { mock, a, B } = await setup([200]);
      startWorker();
      for (let i = 0; i < count; i++) await a.ok("send_message", { to: "Test B", body: `msg ${i}` });
      await waitFor(() => mock.requests.length >= 1);
      await sleep(400);
      expect(mock.requests).toHaveLength(1);
      expect(JSON.parse(mock.requests[0]!.body).unread).toBe(count);
      const jobs = await jobsFor(B.bot.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe("SENT");
    });
  }

  it("A-27 a message arriving while a job is SENDING gets its own doorbell", async () => {
    const { mock, a } = await setup([{ status: 200, delayMs: 300 }, 200]);
    startWorker();
    await a.ok("send_message", { to: "Test B", body: "first" });
    await waitFor(() => mock.started.length >= 1);
    await a.ok("send_message", { to: "Test B", body: "second" });
    await waitFor(() => mock.requests.length >= 2, 5000);
    expect(JSON.parse(mock.requests[1]!.body).unread).toBe(2);
  });

  it("A-28 500, 500, 200 → three attempts, SENT, deliveredAt set, doorbellsSent +1", async () => {
    const { mock, a, B } = await setup([500, 500, 200]);
    startWorker();
    const sent = await a.ok("send_message", { to: "Test B", body: "retry me" });
    await waitFor(async () => (await jobsFor(B.bot.id))[0]?.status === "SENT", 8000);
    const [job] = await jobsFor(B.bot.id);
    expect(job!.attempts).toBe(3);
    expect(job!.lastStatusCode).toBe(200);
    expect(mock.requests).toHaveLength(3);
    const m = await prisma.message.findUnique({ where: { id: sent.messageId } });
    expect(m!.deliveredAt).not.toBeNull();
    expect((await usageFor(B.bot.id)).doorbellsSent).toBe(1);
  });

  it("A-29 always 503 → 5 attempts then FAILED; bot stays OK; doorbellsFailed +1", async () => {
    const { mock, a, B } = await setup([503]);
    startWorker();
    await a.ok("send_message", { to: "Test B", body: "never delivered" });
    await waitFor(async () => (await jobsFor(B.bot.id))[0]?.status === "FAILED", 10000);
    const [job] = await jobsFor(B.bot.id);
    expect(job!.attempts).toBe(5);
    expect(job!.lastError).toBe("HTTP 503");
    expect(mock.requests).toHaveLength(5);
    const bot = await prisma.bot.findUnique({ where: { id: B.bot.id } });
    expect(bot!.doorbellState).toBe("OK");
    expect(bot!.lastDoorbellError).toBe("HTTP 503");
    expect((await usageFor(B.bot.id)).doorbellsFailed).toBe(1);
  });

  it("A-30 401 → FAILED after one attempt, bot BROKEN, audited; next send is paused and enqueues nothing", async () => {
    const { mock, a, B } = await setup([401]);
    startWorker();
    await a.ok("send_message", { to: "Test B", body: "x" });
    await waitFor(async () => (await jobsFor(B.bot.id))[0]?.status === "FAILED");
    const [job] = await jobsFor(B.bot.id);
    expect(job!.attempts).toBe(1);
    expect(job!.lastError).toBe("HTTP 401 (sender key rejected)");
    const bot = await prisma.bot.findUnique({ where: { id: B.bot.id } });
    expect(bot!.doorbellState).toBe("BROKEN");
    const auditRows = await prisma.auditLog.findMany({ where: { action: "BOT_DOORBELL_BROKEN" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ actorType: "SYSTEM", targetType: "bot", targetId: B.bot.id });
    expect(Object.keys(auditRows[0]!.metadata as object).sort()).toEqual(["error", "jobId", "statusCode"]);
    const next = await a.ok("send_message", { to: "Test B", body: "y" });
    expect(next.doorbell).toBe("paused");
    expect(await jobsFor(B.bot.id)).toHaveLength(1);
    await sleep(300);
    expect(mock.requests).toHaveLength(1);
  });

  it("A-31 302 → not followed, permanent failure", async () => {
    const { mock, a, B } = await setup([{ status: 302, headers: { Location: "/automations/webhook/elsewhere" } }]);
    startWorker();
    await a.ok("send_message", { to: "Test B", body: "x" });
    await waitFor(async () => (await jobsFor(B.bot.id))[0]?.status === "FAILED");
    await sleep(200);
    expect(mock.requests).toHaveLength(1);
    expect((await jobsFor(B.bot.id))[0]!.lastError).toBe("redirect not allowed (HTTP 302)");
    expect((await prisma.bot.findUnique({ where: { id: B.bot.id } }))!.doorbellState).toBe("BROKEN");
  });

  it("A-32 a webhook slower than the timeout is retryable with lastError 'timeout after 500ms'", async () => {
    const { a, B } = await setup([{ status: 200, delayMs: 1500 }]);
    startWorker();
    await a.ok("send_message", { to: "Test B", body: "x" });
    await waitFor(async () => (await jobsFor(B.bot.id))[0]?.status === "RETRYING", 5000);
    expect((await jobsFor(B.bot.id))[0]!.lastError).toBe("timeout after 500ms");
    expect((await prisma.bot.findUnique({ where: { id: B.bot.id } }))!.doorbellState).toBe("OK");
  });

  it("A-33 recipient reads everything before the debounce ends → CANCELLED, no POST", async () => {
    const { mock, a, b, B } = await setup([200]);
    startWorker();
    const sent = await a.ok("send_message", { to: "Test B", body: "x" });
    await b.ok("mark_read", { messageIds: [sent.messageId] });
    await waitFor(async () => (await jobsFor(B.bot.id))[0]?.status === "CANCELLED");
    expect((await jobsFor(B.bot.id))[0]!.lastError).toBe("nothing unread");
    expect(mock.requests).toHaveLength(0);
  });

  it("A-35 two workers on the same DB never send the same job twice", async () => {
    const mock = await startMockWebhook([{ status: 200, delayMs: 50 }]);
    mocks.push(mock);
    const sender = await makeBot({ name: "Sender" });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await makeBot({ name: `Recipient ${i}` });
      const c = await connect(sender.bot, r.bot);
      await setDoorbell(r.bot.id, mock.url, SENDER_KEY);
      await prisma.message.create({
        data: { id: newId("msg"), connectionId: c.id, fromBotId: sender.bot.id, toBotId: r.bot.id, threadId: "t", body: "b" },
      });
      await prisma.doorbellJob.create({
        data: { id: newId("dbj"), botId: r.bot.id, coalesceKey: r.bot.id, nextAttemptAt: new Date(Date.now() - 1000) },
      });
      ids.push(r.bot.id);
    }
    const w1 = new DoorbellWorker({ backoffSchedule: FAST });
    const w2 = new DoorbellWorker({ backoffSchedule: FAST });
    await Promise.all([w1.tick(), w2.tick(), w1.tick(), w2.tick()]);
    await Promise.all([w1.tick(), w2.tick()]);
    expect(mock.requests).toHaveLength(12);
    const sentJobs = await prisma.doorbellJob.findMany({ where: { status: "SENT" } });
    expect(sentJobs).toHaveLength(12);
    expect(sentJobs.every((j) => j.attempts === 1)).toBe(true);
  });

  it("A-35 a SENDING job stuck for over 2 minutes is recovered to RETRYING", async () => {
    const r = await makeBot();
    const stuck = await prisma.doorbellJob.create({
      data: {
        id: newId("dbj"),
        botId: r.bot.id,
        status: "SENDING",
        attempts: 1,
        nextAttemptAt: new Date(Date.now() - 200_000),
        claimedAt: new Date(Date.now() - 3 * 60_000),
      },
    });
    const fresh = await prisma.doorbellJob.create({
      data: {
        id: newId("dbj"),
        botId: (await makeBot()).bot.id,
        status: "SENDING",
        attempts: 1,
        nextAttemptAt: new Date(),
        claimedAt: new Date(Date.now() - 30_000),
      },
    });
    const w = new DoorbellWorker({ backoffSchedule: FAST });
    expect(await w.recoverStuck()).toBe(1);
    const after = await prisma.doorbellJob.findUnique({ where: { id: stuck.id } });
    expect(after).toMatchObject({ status: "RETRYING", coalesceKey: r.bot.id, lastError: "worker interrupted" });
    expect((await prisma.doorbellJob.findUnique({ where: { id: fresh.id } }))!.status).toBe("SENDING");
  });

  it("a retry that collides with a newer PENDING job merges into it", async () => {
    const r = await makeBot();
    const old = await prisma.doorbellJob.create({
      data: { id: newId("dbj"), botId: r.bot.id, status: "SENDING", attempts: 3, nextAttemptAt: new Date(), claimedAt: new Date() },
    });
    const newer = await prisma.doorbellJob.create({
      data: { id: newId("dbj"), botId: r.bot.id, coalesceKey: r.bot.id, nextAttemptAt: new Date() },
    });
    const w = new DoorbellWorker({ backoffSchedule: [5000, 5000, 5000, 5000] });
    await w.handleRetryable(old, "HTTP 503", null, 503);
    expect((await prisma.doorbellJob.findUnique({ where: { id: old.id } }))).toMatchObject({
      status: "CANCELLED",
      lastError: "merged into newer job",
    });
    const n = await prisma.doorbellJob.findUnique({ where: { id: newer.id } });
    expect(n!.attempts).toBe(3);
    expect(n!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3000);
  });

  it("A-36 disabling the recipient cancels its pending jobs; no POST", async () => {
    const { mock, a, B } = await setup([200]);
    startWorker();
    await a.ok("send_message", { to: "Test B", body: "x" });
    await disableBot(B.bot.id);
    const [job] = await jobsFor(B.bot.id);
    expect(job!.status).toBe("CANCELLED");
    expect(job!.coalesceKey).toBeNull();
    await sleep(500);
    expect(mock.requests).toHaveLength(0);
  });

  it("send reports not_configured when the recipient has no doorbell", async () => {
    const { A, B } = await trio();
    const a = new McpTestClient(testApp(), A.key);
    const r = await a.ok("send_message", { to: B.bot.id, body: "x" });
    expect(r.doorbell).toBe("not_configured");
    expect(await jobsFor(B.bot.id)).toHaveLength(0);
  });
});
