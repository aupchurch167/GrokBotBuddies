import type { Hono } from "hono";
import type { AppEnv } from "../../src/types.js";

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "Mcp-Protocol-Version": "2025-06-18",
};

let rpcId = 0;

export interface ToolResult {
  isError: boolean;
  text: string;
  json: any;
}

/** Minimal JSON-RPC client for the stateless /mcp endpoint via Hono's in-process app.request(). */
export class McpTestClient {
  constructor(
    private app: Hono<AppEnv>,
    private key: string | null,
    private extraHeaders: Record<string, string> = {},
  ) {}

  headers(): Record<string, string> {
    return {
      ...MCP_HEADERS,
      ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      ...this.extraHeaders,
    };
  }

  async raw(body: unknown, headers: Record<string, string> = this.headers()): Promise<Response> {
    return this.app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  }

  async rpc(method: string, params?: unknown): Promise<any> {
    rpcId += 1;
    const res = await this.raw({ jsonrpc: "2.0", id: rpcId, method, ...(params === undefined ? {} : { params }) });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    return json.result;
  }

  async initialize(): Promise<any> {
    const r = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await this.raw({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }

  async listTools(): Promise<any[]> {
    return (await this.rpc("tools/list", {})).tools;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    const text: string = result.content?.[0]?.text ?? "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { isError: result.isError === true, text, json };
  }

  /** Calls a tool and expects success; returns parsed JSON. */
  async ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.call(name, args);
    if (r.isError) throw new Error(`tool ${name} failed: ${r.text}`);
    return r.json;
  }

  /** Calls a tool and expects a tool error; returns its text. */
  async err(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await this.call(name, args);
    if (!r.isError) throw new Error(`tool ${name} unexpectedly succeeded: ${r.text}`);
    return r.text;
  }
}
