import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { DoorbellWorker } from "./doorbell/worker.js";
import { Scheduler } from "./jobs/scheduler.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { log } from "./lib/logger.js";
import { startLimiterSweeper, stopLimiterSweeper } from "./lib/rateLimit.js";

async function main(): Promise<void> {
  await prisma.$connect();
  const app = buildApp();
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) =>
    log.info({ port: info.port }, "Bot Bridge listening"),
  );
  startLimiterSweeper();
  const worker = new DoorbellWorker();
  worker.start();
  const scheduler = new Scheduler();
  scheduler.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    stopLimiterSweeper();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([worker.stop(10_000), scheduler.stop()]);
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5_000).unref())]);
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "failed to start");
  process.exit(1);
});
