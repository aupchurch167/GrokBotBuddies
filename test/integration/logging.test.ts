import { afterEach, describe, expect, it } from "vitest";
import { DoorbellWorker } from "../../src/doorbell/worker.js";
import { testApp } from "../helpers/app.js";
import { prisma } from "../helpers/db.js";
import { captureLogs } from "../helpers/logCapture.js";
import { McpTestClient } from "../helpers/mcpClient.js";
import { startMockWebhook, waitFor } from "../helpers/mockWebhook.js";

const ORIGIN = "http://localhost:8080";
const FORM = { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" };
const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`)) ?? "";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup) await f();
  cleanup = [];
});

describe("A-40 log redaction canary", () => {
  it("never logs keys, bodies, sender keys, passwords, or setup tokens", async () => {
    const logs = captureLogs();
    cleanup.push(async () => logs.stop());
    const mock = await startMockWebhook([200, 500]);
    cleanup.push(() => mock.close());
    const app = testApp();

    // Admin login: a failed attempt with the canary password, then a real login.
    const g = await app.request("/admin/login");
    const nonce = cookieOf(g, "bb_login_nonce");
    const loginCsrf = csrfOf(await g.text());
    const bad = await app.request("/admin/login", {
      method: "POST",
      headers: { ...FORM, cookie: nonce },
      body: new URLSearchParams({ _csrf: loginCsrf, email: "admin@example.test", password: "CANARY-PASS-2d4e" }),
    });
    expect(bad.status).toBe(401);
    const ok = await app.request("/admin/login", {
      method: "POST",
      headers: { ...FORM, cookie: nonce },
      body: new URLSearchParams({ _csrf: loginCsrf, email: "admin@example.test", password: "test-admin-password-123" }),
    });
    expect(ok.status).toBe(302);
    const session = cookieOf(ok, "bb_admin");
    const csrf = csrfOf(await (await app.request("/admin/bots", { headers: { cookie: session } })).text());
    const post = (path: string, fields: Record<string, string>) =>
      app.request(path, {
        method: "POST",
        headers: { ...FORM, cookie: session },
        body: new URLSearchParams({ _csrf: csrf, ...fields }),
      });

    // Create bot A with the key shown now, bot B with a setup link.
    const ra = await post("/admin/bots", { name: "Canary A", ownerName: "Dev A", deliverVia: "show_now" });
    const keyA = /bb_live_[0-9A-Za-z]{43}/.exec(await ra.text())![0];
    const rb = await post("/admin/bots", { name: "Canary B", ownerName: "Dev B", deliverVia: "setup_link" });
    const setupUrl = /value="(http:\/\/localhost:8080\/setup\/[0-9A-Za-z]{43})"/.exec(await rb.text())![1]!;
    const setupPath = new URL(setupUrl).pathname;
    const token = setupPath.split("/").pop()!;
    const [a, b] = await prisma.bot.findMany({ orderBy: { name: "asc" } });
    await post("/admin/connections", { botX: a!.id, botY: b!.id });

    // Owner reveals the key and saves a doorbell with the canary sender key.
    const page = await app.request(setupPath);
    const setupCsrf = csrfOf(await page.text());
    const reveal = await app.request(`${setupPath}/reveal-key`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ _csrf: setupCsrf }),
    });
    const keyB = /bb_live_[0-9A-Za-z]{43}/.exec(await reveal.text())![0];
    const save = await app.request(`${setupPath}/doorbell`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ _csrf: setupCsrf, webhookUrl: mock.url, senderKey: "CANARY-SENDER-KEY-9b1c" }),
    });
    expect(save.status).toBe(200);
    expect(mock.requests).toHaveLength(1); // the test doorbell (200)

    // MCP: auth failure, auth success, send a canary body; doorbell attempt gets 500.
    const fail = await new McpTestClient(app, `bb_live_${"x".repeat(43)}`).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(fail.status).toBe(401);
    const ca = new McpTestClient(app, keyA);
    await ca.ok("send_message", { to: "Canary B", subject: "CANARY-SUBJECT", body: "CANARY-BODY-7f3a" });
    const w = new DoorbellWorker({ backoffSchedule: [60_000, 60_000, 60_000, 60_000] });
    w.start();
    cleanup.push(() => w.stop(2000));
    await waitFor(() => mock.requests.length >= 2);
    await waitFor(async () => (await prisma.doorbellJob.findFirst())?.status === "RETRYING");
    const cb = new McpTestClient(app, keyB);
    await cb.ok("check_inbox");

    const text = logs.text();
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [
      "bb_live_",
      keyA,
      keyB,
      "CANARY-BODY-7f3a",
      "CANARY-SUBJECT",
      "CANARY-SENDER-KEY-9b1c",
      "CANARY-PASS-2d4e",
      token,
      mock.url,
      "routine-abc123",
    ]) {
      expect(text, `log contains ${secret}`).not.toContain(secret);
    }
    // Sanity: the flows were actually logged.
    expect(text).toContain('"tool":"send_message"');
    expect(text).toContain("/setup/[redacted]");
    expect(text).toContain('"outcome":"retry"');
  });
});
