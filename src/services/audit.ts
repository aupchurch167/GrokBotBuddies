import { prisma } from "../db.js";
import type { ActorType, AuditAction, Prisma } from "../generated/prisma/client.js";
import { newId } from "../lib/ids.js";

export type TargetType = "bot" | "connection" | "message" | "setup_link" | "doorbell_job";

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: AuditAction;
  targetType?: TargetType | null;
  targetId?: string | null;
  ip?: string | null;
  /** Never secrets or message bodies. */
  metadata?: Prisma.InputJsonValue;
}

type Tx = Pick<Prisma.TransactionClient, "auditLog">;

export async function audit(entry: AuditEntry, tx: Tx = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      id: newId("aud"),
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ? entry.ip.slice(0, 64) : null,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    },
  });
}
