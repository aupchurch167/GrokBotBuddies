import { getThread as thread } from "../../services/messages.js";
import type { ToolContext } from "./types.js";

export function getThread({ bot }: ToolContext, args: { threadId?: unknown }) {
  return thread(bot, args);
}
