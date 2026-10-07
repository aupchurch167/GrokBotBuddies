import { listContacts as list } from "../../services/connections.js";
import type { ToolContext } from "./types.js";

export async function listContacts({ bot }: ToolContext) {
  const contacts = await list(bot.id);
  if (contacts.length === 0) {
    return {
      count: 0,
      contacts: [],
      hint: "You have no approved contacts yet. Ask the bridge admin to approve a connection.",
    };
  }
  return {
    count: contacts.length,
    contacts: contacts.map((c) => ({
      botId: c.bot.id,
      name: c.bot.name,
      ownerName: c.bot.ownerName,
      available: c.bot.status === "ACTIVE",
      connectedSince: c.connection.approvedAt.toISOString(),
    })),
  };
}
