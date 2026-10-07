import type { Context } from "hono";

/** JSON-RPC error response for /mcp transport-level failures (auth, size, method). */
export function rpcError(c: Context, status: 401 | 403 | 405 | 413 | 429, message: string, code = -32001): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (status === 401) headers["WWW-Authenticate"] = 'Bearer realm="bot-bridge"';
  if (status === 405) headers["Allow"] = "POST";
  return c.body(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), status, headers);
}
