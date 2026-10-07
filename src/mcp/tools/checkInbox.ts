import { checkInbox as inbox } from "../../services/messages.js";
import type { ToolContext } from "./types.js";

export function checkInbox({ bot }: ToolContext, args: { unreadOnly?: unknown; limit?: unknown }) {
  return inbox(bot, args);
}
