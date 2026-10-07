import { log } from "../lib/logger.js";
import { runRetention } from "./retention.js";

const HOUR = 3_600_000;

/** Hourly tick; runs retention when it's due (>23 h since the last run). */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = runRetention()
        .catch((err) => log.error({ err }, "retention failed"))
        .finally(() => (this.running = null));
    };
    setTimeout(tick, 30_000).unref();
    this.timer = setInterval(tick, HOUR);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}
