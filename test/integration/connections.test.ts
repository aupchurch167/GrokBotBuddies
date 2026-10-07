import { describe, expect, it } from "vitest";
import { generateApiKey } from "../../src/lib/apiKeys.js";
import { approveConnection, findActiveBetween } from "../../src/services/connections.js";
import { prisma } from "../helpers/db.js";

async function botWithId(id: string, name: string) {
  const k = generateApiKey();
  return prisma.bot.create({
    data: { id, name, nameKey: name.toLowerCase(), ownerName: "o", apiKeyPrefix: k.prefix, apiKeyHash: k.hash },
  });
}

describe("connection ordering", () => {
  // JS orders 'P' (0x50) before 'a' (0x61); en_US/ICU collations order them the other way.
  // The CHECK constraint must agree with the app's ordering under any database collation.
  it("approves a pair whose ids sort differently in JS and in a linguistic collation", async () => {
    const upper = await botWithId("bot_PEQQNw91Vg4eowftDJxr", "upper");
    const lower = await botWithId("bot_ai6yFuGDBVx6Vje5sy8i", "lower");
    const { connection } = await approveConnection(lower.id, upper.id, null);
    expect(connection.botAId).toBe(upper.id);
    expect(connection.botBId).toBe(lower.id);
    expect((await findActiveBetween(upper.id, lower.id))?.id).toBe(connection.id);
  });
});
