import { prisma } from "../../src/db.js";
import type { Bot } from "../../src/generated/prisma/client.js";
import { aad, aesGcmEncrypt } from "../../src/lib/crypto.js";
import { createBot } from "../../src/services/bots.js";
import { approveConnection } from "../../src/services/connections.js";

let n = 0;

export async function makeBot(
  overrides: Partial<{ name: string; ownerName: string; sendLimitPerHour: number; mcpCallLimitPerHour: number }> = {},
): Promise<{ bot: Bot; key: string }> {
  n += 1;
  return createBot({
    name: overrides.name ?? `Test Bot ${n}`,
    ownerName: overrides.ownerName ?? `Owner ${n}`,
    sendLimitPerHour: overrides.sendLimitPerHour,
    mcpCallLimitPerHour: overrides.mcpCallLimitPerHour,
  });
}

export async function connect(a: Bot, b: Bot, note: string | null = null) {
  return (await approveConnection(a.id, b.id, note)).connection;
}

/** A, B, C with only A↔B connected. */
export async function trio() {
  const A = await makeBot({ name: "Test A", ownerName: "Dev A" });
  const B = await makeBot({ name: "Test B", ownerName: "Dev B" });
  const C = await makeBot({ name: "Test C", ownerName: "Dev C" });
  const ab = await connect(A.bot, B.bot);
  return { A, B, C, ab };
}

/** Saves a doorbell on a bot directly (state OK) without a test POST. */
export async function setDoorbell(botId: string, url: string, senderKey = "sender-key-test-123") {
  return prisma.bot.update({
    where: { id: botId },
    data: {
      webhookUrl: url,
      webhookKeyEnc: aesGcmEncrypt(senderKey, aad.webhookKey(botId)),
      doorbellState: "OK",
      doorbellUpdatedAt: new Date(),
    },
  });
}
