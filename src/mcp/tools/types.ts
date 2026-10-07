import type { Bot } from "../../generated/prisma/client.js";

export interface ToolContext {
  bot: Bot;
  requestId: string;
}
