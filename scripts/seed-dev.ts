import "dotenv/config";

// Dev only: wipes dev data, creates Test A/B/C, approves only A↔B, prints the three keys.
const url = process.env["DATABASE_URL"] ?? "";
if (process.env["NODE_ENV"] === "production") {
  console.error("Refusing to seed: NODE_ENV=production.");
  process.exit(1);
}
let host = "";
try {
  host = new URL(url).hostname;
} catch {
  host = "";
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  console.error("Refusing to seed: DATABASE_URL must point at localhost.");
  process.exit(1);
}

const { prisma } = await import("../src/db.js");
const { createBot } = await import("../src/services/bots.js");
const { approveConnection } = await import("../src/services/connections.js");

await prisma.$executeRawUnsafe(
  `TRUNCATE "AuditLog", "AdminSession", "SetupLink", "UsageCounter", "DoorbellJob", "Message", "Connection", "Bot", "JobRun" RESTART IDENTITY CASCADE`,
);
const a = await createBot({ name: "Test A", ownerName: "Dev A" });
const b = await createBot({ name: "Test B", ownerName: "Dev B" });
const c = await createBot({ name: "Test C", ownerName: "Dev C" });
await approveConnection(a.bot.id, b.bot.id, "dev seed");

console.log(`Test A  ${a.bot.id}  ${a.key}`);
console.log(`Test B  ${b.bot.id}  ${b.key}`);
console.log(`Test C  ${c.bot.id}  ${c.key}`);
console.log("Test C is intentionally NOT connected (use it for isolation tests).");
await prisma.$disconnect();
