import { markRead as mark } from "../../services/messages.js";
import type { ToolContext } from "./types.js";

export function markRead({ bot }: ToolContext, args: { messageIds?: unknown }) {
  return mark(bot, args);
}
