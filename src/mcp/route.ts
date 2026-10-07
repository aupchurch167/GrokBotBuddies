import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { msg } from "../lib/toolErrors.js";
import type { AppEnv } from "../types.js";
import { mcpAuth } from "./auth.js";
import { buildMcpServer } from "./buildServer.js";
import { rpcError } from "./rpc.js";

const MAX_BODY = 65_536;

export function registerMcp(app: Hono<AppEnv>): void {
  app.options("/mcp", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    }),
  );

  app.on(["GET", "DELETE"], "/mcp", (c) => rpcError(c, 405, msg.methodNotAllowed, -32000));

  app.post(
    "/mcp",
    bodyLimit({ maxSize: MAX_BODY, onError: (c) => rpcError(c, 413, msg.requestTooLarge) }),
    mcpAuth,
    async (c) => {
      const server = buildMcpServer({ bot: c.get("bot"), requestId: c.get("requestId") });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MAX_BODY,
      } as ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0]);
      try {
        await server.connect(transport);
        const res = await transport.handleRequest(c.req.raw);
        const out = new Response(res.body, res);
        out.headers.set("Access-Control-Allow-Origin", "*");
        return out;
      } finally {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    },
  );
}
