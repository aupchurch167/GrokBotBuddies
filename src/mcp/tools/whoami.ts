import { doorbellLabel } from "../../services/bots.js";
import { listContacts } from "../../services/connections.js";
import { messagesSentLastHour, unreadCount } from "../../services/messages.js";
import { usageFor } from "../../services/usage.js";
import type { ToolContext } from "./types.js";

export async function whoami({ bot }: ToolContext) {
  const [contacts, unread, sentLastHour, usage] = await Promise.all([
    listContacts(bot.id),
    unreadCount(bot.id),
    messagesSentLastHour(bot.id),
    usageFor(bot.id),
  ]);
  return {
    botId: bot.id,
    name: bot.name,
    ownerName: bot.ownerName,
    doorbell: doorbellLabel(bot),
    unreadCount: unread,
    contacts: contacts.map((c) => ({ botId: c.bot.id, name: c.bot.name, ownerName: c.bot.ownerName })),
    limits: {
      messagesPerHour: bot.sendLimitPerHour,
      messagesSentLastHour: sentLastHour,
      toolCallsPerHour: bot.mcpCallLimitPerHour,
    },
    usageThisMonth: {
      month: usage.month,
      messagesSent: usage.messagesSent,
      messagesReceived: usage.messagesReceived,
      toolCalls: usage.mcpCalls,
      doorbellsSent: usage.doorbellsSent,
    },
  };
}
