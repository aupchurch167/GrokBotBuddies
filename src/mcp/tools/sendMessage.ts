import { sendMessage as send, type SendInput } from "../../services/messages.js";
import type { ToolContext } from "./types.js";

export function sendMessage({ bot }: ToolContext, args: SendInput) {
  return send(bot, args);
}
