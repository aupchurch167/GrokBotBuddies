import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { config } from "../config.js";
import { parseRetryAfter } from "./backoff.js";
import { devLocalHost, safeLookup, validateWebhookUrl } from "./ssrf.js";

export type DoorbellPayload =
  | { event: "bridge.new_message"; unread: number; from: string; ts: number }
  | { event: "bridge.test"; ts: number };

export type PostResult =
  | { kind: "response"; status: number; retryAfterMs: number | null }
  | { kind: "error"; code: "timeout" | "dns" | "blocked" | "network" | "invalid_url"; detail: string };

export interface PostOptions {
  timeoutMs?: number;
  lookup?: LookupFunction;
}

const MAX_READ = 4096;

/**
 * POSTs a content-free doorbell. Never follows redirects, reads at most 4 KiB of the
 * response, and pins DNS through `safeLookup`. Errors are summaries only (no URL, no key).
 */
export function postDoorbell(
  webhookUrl: string,
  senderKey: string,
  payload: DoorbellPayload,
  opts: PostOptions = {},
): Promise<PostResult> {
  const timeoutMs = opts.timeoutMs ?? config.DOORBELL_TIMEOUT_MS;
  const v = validateWebhookUrl(webhookUrl);
  if (!v.ok) return Promise.resolve({ kind: "error", code: "invalid_url", detail: "blocked: webhook URL not allowed" });
  const u = v.url;
  const body = JSON.stringify(payload);
  const isHttp = u.protocol === "http:" && devLocalHost(u.hostname);
  const mod = isHttp ? http : https;

  return new Promise<PostResult>((resolve) => {
    let settled = false;
    const done = (r: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = mod.request({
      hostname: u.hostname,
      port: u.port ? Number(u.port) : isHttp ? 80 : 443,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${senderKey}`,
        "X-Automation-Key": senderKey,
        "User-Agent": "BotBridge-Doorbell/1.0",
      },
      lookup: opts.lookup ?? safeLookup,
      agent: false,
    });
    const timer = setTimeout(() => {
      done({ kind: "error", code: "timeout", detail: `timeout after ${timeoutMs}ms` });
      req.destroy();
    }, timeoutMs);
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const retryAfterMs = parseRetryAfter(res.headers["retry-after"] as string | undefined);
      let read = 0;
      res.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read >= MAX_READ) {
          res.destroy();
          done({ kind: "response", status, retryAfterMs });
        }
      });
      res.on("end", () => done({ kind: "response", status, retryAfterMs }));
      res.on("error", () => done({ kind: "response", status, retryAfterMs }));
      res.on("close", () => done({ kind: "response", status, retryAfterMs }));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      if (code === "EBLOCKED") return done({ kind: "error", code: "blocked", detail: "blocked: private address" });
      if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA")
        return done({ kind: "error", code: "dns", detail: "DNS lookup failed" });
      done({ kind: "error", code: "network", detail: `network error (${/^[A-Z0-9_]+$/.test(code) ? code : "unknown"})` });
    });
    req.end(body);
  });
}

export type Classified =
  | { cls: "success"; statusCode: number; summary: string }
  | { cls: "retryable"; statusCode: number | null; summary: string; retryAfterMs: number | null; timeout: boolean }
  | { cls: "permanent"; statusCode: number | null; summary: string };

export function classify(r: PostResult): Classified {
  if (r.kind === "error") {
    if (r.code === "blocked" || r.code === "invalid_url") return { cls: "permanent", statusCode: null, summary: r.detail };
    return { cls: "retryable", statusCode: null, summary: r.detail, retryAfterMs: null, timeout: r.code === "timeout" };
  }
  const s = r.status;
  if (s >= 200 && s < 300) return { cls: "success", statusCode: s, summary: `HTTP ${s}` };
  if (s === 408 || s === 429 || s >= 500)
    return { cls: "retryable", statusCode: s, summary: `HTTP ${s}`, retryAfterMs: r.retryAfterMs, timeout: false };
  if (s >= 300 && s < 400) return { cls: "permanent", statusCode: s, summary: `redirect not allowed (HTTP ${s})` };
  if (s === 401 || s === 403) return { cls: "permanent", statusCode: s, summary: `HTTP ${s} (sender key rejected)` };
  if (s === 404 || s === 410) return { cls: "permanent", statusCode: s, summary: `HTTP ${s} (webhook not found)` };
  return { cls: "permanent", statusCode: s, summary: `HTTP ${s}` };
}
