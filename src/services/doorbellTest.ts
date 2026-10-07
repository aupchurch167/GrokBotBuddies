import { prisma } from "../db.js";
import type { Bot } from "../generated/prisma/client.js";
import type { PostOptions } from "../doorbell/sender.js";
import { classify, postDoorbell, type Classified } from "../doorbell/sender.js";
import { config } from "../config.js";
import { aad, aesGcmDecrypt } from "../lib/crypto.js";
import { log } from "../lib/logger.js";

export interface TestResult {
  ok: boolean;
  statusCode: number | null;
  summary: string;
  /** Exact banner text from the packet (§12.3). */
  banner: string;
}

export const PASS_BANNER =
  "Doorbell test passed. Your bot should wake up in a moment, find an empty inbox, and do nothing. That's expected.";

export function failBanner(c: Exclude<Classified, { cls: "success" }>): string {
  const s = c.statusCode;
  if (s === 401 || s === 403)
    return "Doorbell test failed: the webhook rejected the sender key. Copy the sender key from the routine's panel again and save.";
  if (s === 404 || s === 410)
    return "Doorbell test failed: that webhook URL wasn't found. Copy the URL from the routine's panel again and save.";
  if (c.cls === "retryable" && c.timeout)
    return `Doorbell test failed: the webhook didn't answer within ${config.DOORBELL_TIMEOUT_MS / 1000} seconds. Try the test again.`;
  if (s !== null && s >= 500)
    return `Doorbell test failed: Grok Bot's webhook service returned an error (${s}). Try again in a few minutes.`;
  return `Doorbell test failed: ${c.summary}.`;
}

/**
 * Sends {"event":"bridge.test"} to the bot's saved webhook. Pass → doorbellState OK and the
 * error cleared; fail → BROKEN with the error summary.
 */
export async function testDoorbell(botId: string, opts: PostOptions = {}): Promise<TestResult> {
  const bot: Bot | null = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot || !bot.webhookUrl || !bot.webhookKeyEnc) {
    return { ok: false, statusCode: null, summary: "no doorbell saved", banner: "Doorbell test failed: no doorbell is saved yet." };
  }
  let senderKey: string;
  try {
    senderKey = aesGcmDecrypt(bot.webhookKeyEnc, aad.webhookKey(bot.id));
  } catch {
    const summary = "sender key unreadable (save it again)";
    await markResult(bot.id, false, summary);
    return { ok: false, statusCode: null, summary, banner: `Doorbell test failed: ${summary}.` };
  }
  const r = await postDoorbell(bot.webhookUrl, senderKey, { event: "bridge.test", ts: Date.now() }, opts);
  const c = classify(r);
  const ok = c.cls === "success";
  await markResult(bot.id, ok, c.summary);
  log.info({ botId: bot.id, statusCode: c.statusCode, outcome: ok ? "test_passed" : "test_failed", error: ok ? undefined : c.summary }, "doorbell test");
  return { ok, statusCode: c.statusCode, summary: c.summary, banner: ok ? PASS_BANNER : failBanner(c as Exclude<Classified, { cls: "success" }>) };
}

async function markResult(botId: string, ok: boolean, summary: string): Promise<void> {
  await prisma.bot.update({
    where: { id: botId },
    data: ok
      ? { doorbellState: "OK", lastDoorbellError: null, doorbellUpdatedAt: new Date() }
      : { doorbellState: "BROKEN", lastDoorbellError: summary.slice(0, 500), doorbellUpdatedAt: new Date() },
  });
}
