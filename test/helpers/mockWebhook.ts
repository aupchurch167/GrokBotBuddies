import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  at: number;
}

export interface Reply {
  status: number;
  delayMs?: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Local HTTP server that records requests and answers with a scripted sequence.
 * The last reply repeats once the script runs out.
 */
export async function startMockWebhook(script: (Reply | number)[] = [200]) {
  const requests: RecordedRequest[] = [];
  const started: number[] = [];
  let i = 0;
  const replies = script.map((r) => (typeof r === "number" ? { status: r } : r));
  const server = http.createServer((req, res) => {
    started.push(Date.now());
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        at: Date.now(),
      });
      const reply = replies[Math.min(i, replies.length - 1)] ?? { status: 200 };
      i += 1;
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status, { "Content-Type": "application/json", ...(reply.headers ?? {}) });
        res.end(reply.body ?? "{}");
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/automations/webhook/routine-abc123`,
    requests,
    started,
    setScript(next: (Reply | number)[]) {
      replies.splice(0, replies.length, ...next.map((r) => (typeof r === "number" ? { status: r } : r)));
      i = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
