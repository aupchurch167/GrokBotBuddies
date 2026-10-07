import type { LookupFunction } from "node:net";
import { config } from "../config.js";
import { prisma } from "../db.js";
import type { DoorbellJob } from "../generated/prisma/client.js";
import { aad, aesGcmDecrypt } from "../lib/crypto.js";
import { log } from "../lib/logger.js";
import { audit } from "../services/audit.js";
import { isUniqueViolation } from "../services/bots.js";
import { increment } from "../services/usage.js";
import { backoff, DEFAULT_SCHEDULE_MS, MAX_ATTEMPTS } from "./backoff.js";
import { classify, postDoorbell } from "./sender.js";

export interface WorkerOptions {
  pollMs?: number;
  timeoutMs?: number;
  backoffSchedule?: number[];
  lookup?: LookupFunction;
  /** How long a SENDING claim may sit before recovery (default 2 min). */
  stuckAfterMs?: number;
}

const truncate = (s: string) => (s.length > 500 ? s.slice(0, 500) : s);

export class DoorbellWorker {
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stuckTimer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<unknown>>();
  private ticking: Promise<unknown> | null = null;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly schedule: number[];
  private readonly stuckAfterMs: number;

  constructor(private opts: WorkerOptions = {}) {
    this.pollMs = opts.pollMs ?? config.DOORBELL_POLL_MS;
    this.timeoutMs = opts.timeoutMs ?? config.DOORBELL_TIMEOUT_MS;
    this.schedule = opts.backoffSchedule ?? DEFAULT_SCHEDULE_MS;
    this.stuckAfterMs = opts.stuckAfterMs ?? 120_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        this.ticking = this.tick();
        await this.ticking;
      } catch (err) {
        log.error({ err }, "doorbell worker tick failed");
      } finally {
        this.ticking = null;
      }
      if (this.running) this.pollTimer = setTimeout(loop, this.pollMs);
    };
    this.pollTimer = setTimeout(loop, 0);
    this.stuckTimer = setInterval(() => {
      this.recoverStuck().catch((err) => log.error({ err }, "doorbell recoverStuck failed"));
    }, 60_000);
    this.stuckTimer.unref();
  }

  /** Stops polling and waits (max `graceMs`) for in-flight jobs. */
  async stop(graceMs = 10_000): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.stuckTimer) clearInterval(this.stuckTimer);
    this.pollTimer = this.stuckTimer = null;
    const pending = Promise.allSettled([...(this.ticking ? [this.ticking] : []), ...this.inFlight]);
    await Promise.race([pending, new Promise((r) => setTimeout(r, graceMs).unref())]);
  }

  /** Claims up to 10 due jobs and processes them concurrently. */
  async tick(): Promise<number> {
    const jobs = await prisma.$queryRaw<DoorbellJob[]>`
      WITH due AS (
        SELECT id FROM "DoorbellJob"
        WHERE status IN ('PENDING','RETRYING') AND "nextAttemptAt" <= now()
        ORDER BY "nextAttemptAt"
        LIMIT 10
        FOR UPDATE SKIP LOCKED)
      UPDATE "DoorbellJob" j
         SET status = 'SENDING', "coalesceKey" = NULL, "claimedAt" = now(),
             attempts = j.attempts + 1, "updatedAt" = now()
        FROM due WHERE j.id = due.id
      RETURNING j.*`;
    await Promise.allSettled(
      jobs.map((job) => {
        const p = this.processJob(job).catch((err) =>
          log.error({ err, jobId: job.id, botId: job.botId }, "doorbell job crashed"),
        );
        this.inFlight.add(p);
        return p.finally(() => this.inFlight.delete(p));
      }),
    );
    return jobs.length;
  }

  /** SENDING jobs whose claim is older than 2 minutes go back to retry. */
  async recoverStuck(): Promise<number> {
    const stuck = await prisma.$queryRaw<DoorbellJob[]>`
      SELECT * FROM "DoorbellJob"
      WHERE status = 'SENDING' AND "claimedAt" < now() - (${this.stuckAfterMs} * interval '1 millisecond')`;
    for (const job of stuck) await this.handleRetryable(job, "worker interrupted", null, null);
    return stuck.length;
  }

  private async finish(job: DoorbellJob, status: "CANCELLED", reason: string): Promise<void> {
    await prisma.doorbellJob.update({
      where: { id: job.id },
      data: { status, coalesceKey: null, lastError: reason },
    });
    log.info({ jobId: job.id, botId: job.botId, attempt: job.attempts, outcome: "cancelled", error: reason }, "doorbell");
  }

  async processJob(job: DoorbellJob): Promise<void> {
    const bot = await prisma.bot.findUnique({ where: { id: job.botId } });
    if (!bot || bot.status === "DISABLED" || !bot.webhookUrl || !bot.webhookKeyEnc || bot.doorbellState !== "OK") {
      return this.finish(job, "CANCELLED", "doorbell no longer configured");
    }
    const unreadWhere = { toBotId: bot.id, readAt: null, connection: { status: "ACTIVE" as const } };
    const unread = await prisma.message.count({ where: unreadWhere });
    if (unread === 0) return this.finish(job, "CANCELLED", "nothing unread");
    const newest = await prisma.message.findFirst({
      where: unreadWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { fromBot: { select: { name: true } } },
    });

    let senderKey: string;
    try {
      senderKey = aesGcmDecrypt(bot.webhookKeyEnc, aad.webhookKey(bot.id));
    } catch {
      return this.handlePermanent(job, null, "sender key unreadable (redo setup)");
    }
    const r = await postDoorbell(
      bot.webhookUrl,
      senderKey,
      { event: "bridge.new_message", unread, from: newest?.fromBot.name ?? "", ts: Date.now() },
      { timeoutMs: this.timeoutMs, ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}) },
    );
    const c = classify(r);
    if (c.cls === "success") {
      await prisma.$transaction(async (tx) => {
        await tx.doorbellJob.update({
          where: { id: job.id },
          data: { status: "SENT", sentAt: new Date(), lastStatusCode: c.statusCode, lastError: null },
        });
        await tx.$executeRaw`
          UPDATE "Message" SET "deliveredAt" = now()
          WHERE "toBotId" = ${bot.id} AND "deliveredAt" IS NULL AND "createdAt" <= ${job.claimedAt ?? new Date()}`;
        await increment(bot.id, "doorbellsSent", 1, tx);
      });
      log.info(
        { jobId: job.id, botId: bot.id, attempt: job.attempts, statusCode: c.statusCode, outcome: "sent" },
        "doorbell",
      );
      return;
    }
    if (c.cls === "retryable") return this.handleRetryable(job, c.summary, c.retryAfterMs, c.statusCode);
    return this.handlePermanent(job, c.statusCode, c.summary);
  }

  private async handlePermanent(job: DoorbellJob, statusCode: number | null, error: string): Promise<void> {
    const summary = truncate(error);
    await prisma.$transaction(async (tx) => {
      await tx.doorbellJob.update({
        where: { id: job.id },
        data: { status: "FAILED", coalesceKey: null, lastError: summary, lastStatusCode: statusCode },
      });
      await increment(job.botId, "doorbellsFailed", 1, tx);
      await tx.bot.update({
        where: { id: job.botId },
        data: { doorbellState: "BROKEN", lastDoorbellError: summary, doorbellUpdatedAt: new Date() },
      });
      await audit(
        {
          actorType: "SYSTEM",
          action: "BOT_DOORBELL_BROKEN",
          targetType: "bot",
          targetId: job.botId,
          metadata: { jobId: job.id, statusCode, error: summary },
        },
        tx,
      );
    });
    log.warn(
      { jobId: job.id, botId: job.botId, attempt: job.attempts, statusCode, error: summary, outcome: "failed_permanent" },
      "doorbell",
    );
  }

  async handleRetryable(
    job: DoorbellJob,
    error: string,
    retryAfterMs: number | null,
    statusCode: number | null,
  ): Promise<void> {
    const summary = truncate(error);
    if (job.attempts >= MAX_ATTEMPTS) {
      await prisma.$transaction(async (tx) => {
        await tx.doorbellJob.update({
          where: { id: job.id },
          data: { status: "FAILED", coalesceKey: null, lastError: summary, lastStatusCode: statusCode },
        });
        await increment(job.botId, "doorbellsFailed", 1, tx);
        await tx.bot.update({ where: { id: job.botId }, data: { lastDoorbellError: summary } });
      });
      log.warn(
        { jobId: job.id, botId: job.botId, attempt: job.attempts, statusCode, error: summary, outcome: "failed" },
        "doorbell",
      );
      return;
    }
    const delay = backoff(job.attempts, retryAfterMs, this.schedule);
    const next = new Date(Date.now() + delay);
    try {
      await prisma.doorbellJob.update({
        where: { id: job.id },
        data: {
          status: "RETRYING",
          coalesceKey: job.botId,
          nextAttemptAt: next,
          lastError: summary,
          lastStatusCode: statusCode,
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // A newer PENDING job exists: fold this job's attempts and backoff into it.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "DoorbellJob" SET attempts = GREATEST(attempts, ${job.attempts}),
                 "nextAttemptAt" = GREATEST("nextAttemptAt", ${next}), "updatedAt" = now()
          WHERE "coalesceKey" = ${job.botId}`;
        await tx.doorbellJob.update({
          where: { id: job.id },
          data: { status: "CANCELLED", coalesceKey: null, lastError: "merged into newer job", lastStatusCode: statusCode },
        });
      });
    }
    log.info(
      { jobId: job.id, botId: job.botId, attempt: job.attempts, statusCode, error: summary, outcome: "retry" },
      "doorbell",
    );
  }
}
