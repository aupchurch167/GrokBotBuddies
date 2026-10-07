import { config } from "../config.js";
import type { Prisma } from "../generated/prisma/client.js";
import { newId } from "../lib/ids.js";

/**
 * At most one coalescible (PENDING/RETRYING) job per bot. If one already exists the new
 * message simply joins it (ON CONFLICT DO NOTHING), so a burst produces one doorbell.
 */
export async function enqueueDoorbell(tx: Pick<Prisma.TransactionClient, "$executeRaw">, botId: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "DoorbellJob" (id, "botId", status, "coalesceKey", attempts, "nextAttemptAt", "createdAt", "updatedAt")
    VALUES (${newId("dbj")}, ${botId}, 'PENDING', ${botId}, 0,
            now() + (${config.DOORBELL_DEBOUNCE_MS} * interval '1 millisecond'), now(), now())
    ON CONFLICT ("coalesceKey") DO NOTHING`;
}
