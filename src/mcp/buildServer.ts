import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { log } from "../lib/logger.js";
import { limiters } from "../lib/rateLimit.js";
import { msg, ToolError } from "../lib/toolErrors.js";
import { incrementLater } from "../services/usage.js";
import { DESCRIPTIONS, SERVER_INSTRUCTIONS } from "./descriptions.js";
import { checkInbox } from "./tools/checkInbox.js";
import { getThread } from "./tools/getThread.js";
import { listContacts } from "./tools/listContacts.js";
import { markRead } from "./tools/markRead.js";
import { sendMessage } from "./tools/sendMessage.js";
import type { ToolContext } from "./tools/types.js";
import { whoami } from "./tools/whoami.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const toolErr = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** A fresh server per request; it closes over the authenticated bot. */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const { bot, requestId } = ctx;
  const server = new McpServer({ name: "bot-bridge", version: pkg.version }, { instructions: SERVER_INSTRUCTIONS });

  function registerBotTool<Shape extends z.ZodRawShape>(
    name: keyof typeof DESCRIPTIONS,
    config: { title: string; inputSchema: Shape; annotations: ToolAnnotations },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    server.registerTool(
      name,
      { title: config.title, description: DESCRIPTIONS[name], inputSchema: config.inputSchema, annotations: config.annotations },
      (async (args: Record<string, unknown> | undefined): Promise<CallToolResult> => {
        const t0 = Date.now();
        let outcome = "ok";
        try {
          const rl = limiters.mcpCalls.hit(bot.id, bot.mcpCallLimitPerHour);
          if (!rl.ok) {
            outcome = "rate_limited";
            return toolErr(msg.rateMcp(bot.mcpCallLimitPerHour, rl.retryAfterMs));
          }
          incrementLater(bot.id, "mcpCalls", 1);
          const out = await handler(args ?? {});
          return { content: [{ type: "text", text: JSON.stringify(out) }] };
        } catch (e) {
          if (e instanceof ToolError) {
            outcome = "tool_error";
            return toolErr(e.message);
          }
          outcome = "internal_error";
          log.error({ err: e, tool: name, botId: bot.id, requestId }, "tool failed");
          return toolErr(msg.internal(requestId));
        } finally {
          // Never log args.
          log.info({ tool: name, botId: bot.id, ms: Date.now() - t0, outcome, requestId }, "mcp tool call");
        }
      }) as never,
    );
  }

  registerBotTool("whoami", { title: "Who am I", inputSchema: {}, annotations: READ_ONLY }, () => whoami(ctx));

  registerBotTool("list_contacts", { title: "List contacts", inputSchema: {}, annotations: READ_ONLY }, () =>
    listContacts(ctx),
  );

  registerBotTool(
    "send_message",
    {
      title: "Send message",
      inputSchema: {
        to: z.string().describe("Recipient: a contact's botId (bot_...) or exact name from list_contacts."),
        body: z.string().describe("Message text, plain text, up to 8,000 characters."),
        subject: z.string().optional().describe("Optional short subject, up to 200 characters."),
        replyToId: z
          .string()
          .optional()
          .describe("Optional messageId you are replying to. Keeps the reply in the same thread."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => sendMessage(ctx, args),
  );

  registerBotTool(
    "check_inbox",
    {
      title: "Check inbox",
      inputSchema: {
        unreadOnly: z
          .boolean()
          .optional()
          .describe("Default true: only unread messages. Set false to include messages you've already read."),
        limit: z.number().optional().describe("How many messages to return, 1-50. Default 20."),
      },
      annotations: READ_ONLY,
    },
    (args) => checkInbox(ctx, args),
  );

  registerBotTool(
    "get_thread",
    {
      title: "Get thread",
      inputSchema: { threadId: z.string().describe("The threadId from check_inbox or send_message.") },
      annotations: READ_ONLY,
    },
    (args) => getThread(ctx, args),
  );

  registerBotTool(
    "mark_read",
    {
      title: "Mark read",
      inputSchema: { messageIds: z.array(z.string()).describe("messageIds to mark read (max 100).") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => markRead(ctx, args),
  );

  return server;
}
