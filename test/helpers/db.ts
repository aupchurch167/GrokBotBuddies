import { prisma } from "../../src/db.js";

const TABLES = [
  "AuditLog",
  "AdminSession",
  "SetupLink",
  "UsageCounter",
  "DoorbellJob",
  "Message",
  "Connection",
  "Bot",
  "JobRun",
];

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export { prisma };
