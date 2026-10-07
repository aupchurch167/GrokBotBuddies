import { config } from "../config.js";
import { prisma } from "../db.js";
import { log } from "../lib/logger.js";
import { audit } from "../services/audit.js";

export const RETENTION_LOCK = 727001;
const JOB = "retention";
const BATCH = 1000;
const DUE_AFTER_MS = 23 * 3_600_000;

export interface PurgeCounts {
  messages: number;
  doorbellJobs: number;
  setupLinks: number;
  sessions: number;
  auditRows: number;
}

/** Deletes in batches of 1,000 until none remain. `where` is fixed SQL (no user input). */
async function batchDelete(table: string, where: string): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE id IN (SELECT id FROM "${table}" WHERE ${where} LIMIT ${BATCH})`,
    );
    total += n;
    if (n < BATCH) return total;
  }
}

export async function purge(): Promise<PurgeCounts> {
  const days = Number(config.RETENTION_DAYS);
  const auditDays = Number(config.AUDIT_RETENTION_DAYS);
  return {
    messages: await batchDelete("Message", `"createdAt" < now() - interval '${days} days'`),
    doorbellJobs: await batchDelete(
      "DoorbellJob",
      `status IN ('SENT','FAILED','CANCELLED') AND "createdAt" < now() - interval '30 days'`,
    ),
    setupLinks: await batchDelete("SetupLink", `"expiresAt" < now() - interval '30 days'`),
    sessions: await batchDelete("AdminSession", `"expiresAt" < now() OR "lastSeenAt" < now() - interval '12 hours'`),
    auditRows: await batchDelete("AuditLog", `"createdAt" < now() - interval '${auditDays} days'`),
  };
}

export interface RunOptions {
  /** Run even if the last run was under 23 h ago (admin "Run retention now"). */
  force?: boolean;
  actor?: { type: "ADMIN" | "SYSTEM"; ip?: string | null };
}

/**
 * Runs the purge if it is due (or forced) and this process wins the advisory lock.
 * Returns the counts, or null when skipped.
 */
export async function runRetention(opts: RunOptions = {}): Promise<PurgeCounts | null> {
  const actor = opts.actor ?? { type: "SYSTEM" as const };
  if (!opts.force) {
    const last = await prisma.jobRun.findUnique({ where: { name: JOB } });
    if (last && Date.now() - last.lastRunAt.getTime() < DUE_AFTER_MS) return null;
  }
  // Session-level advisory lock: hold a dedicated connection for the whole run.
  return prisma.$transaction(
    async (tx) => {
      const [got] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${RETENTION_LOCK}) AS ok`;
      if (!got?.ok) return null;
      if (!opts.force) {
        const last = await tx.jobRun.findUnique({ where: { name: JOB } });
        if (last && Date.now() - last.lastRunAt.getTime() < DUE_AFTER_MS) return null;
      }
      const counts = await purge();
      await tx.jobRun.upsert({
        where: { name: JOB },
        create: { name: JOB, lastRunAt: new Date(), lastResult: { ...counts } },
        update: { lastRunAt: new Date(), lastResult: { ...counts } },
      });
      await audit(
        {
          actorType: actor.type,
          actorId: actor.type === "ADMIN" ? "admin" : null,
          action: "RETENTION_PURGE",
          ip: actor.ip ?? null,
          metadata: { ...counts },
        },
        tx,
      );
      log.info({ job: JOB, ...counts }, "retention purge");
      return counts;
    },
    { maxWait: 10_000, timeout: 10 * 60_000 },
  );
}
