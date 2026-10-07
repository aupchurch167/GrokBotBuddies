import { afterEach, describe, expect, it } from "vitest";
import { DoorbellWorker } from "../../src/doorbell/worker.js";
import { newId } from "../../src/lib/ids.js";
import { flushUsage } from "../../src/services/usage.js";
import { ADMIN_PASSWORD, Browser, loginAdmin, ORIGIN } from "../helpers/admin.js";
import { testApp } from "../helpers/app.js";
import { prisma } from "../helpers/db.js";
import { connect, makeBot, setDoorbell, trio } from "../helpers/factories.js";
import { McpTestClient } from "../helpers/mcpClient.js";
import { startMockWebhook, waitFor } from "../helpers/mockWebhook.js";

const WRONG = "Wrong email or password.";
const LOCKED = "Too many login attempts. Wait 15 minutes and try again.";
const CSRF_TEXT = "Your session expired or the form was stale. Go back, refresh, and try again.";
const SECRET_BANNER = "Copy this now. It won't be shown again. Refreshing this page will not show it again.";
const VIEW_BANNER = "Untrusted content written by a bot. Viewing is logged.";
const PASS_BANNER =
  "Doorbell test passed. Your bot should wake up in a moment, find an empty inbox, and do nothing. That's expected.";
const REJECTED_BANNER =
  "Doorbell test failed: the webhook rejected the sender key. Copy the sender key from the routine's panel again and save.";
const TOO_MANY_TESTS = "Too many tests. Wait 10 minutes and try again.";
const KEY_RE = /bb_live_[0-9A-Za-z]{43}/;
const KEY_RE_G = /bb_live_[0-9A-Za-z]{43}/g;
const SETUP_URL_RE = /http:\/\/localhost:8080\/setup\/([0-9A-Za-z]{43})/;

let mocks: Awaited<ReturnType<typeof startMockWebhook>>[] = [];
let workers: DoorbellWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop(2000)));
  await Promise.all(mocks.map((m) => m.close()));
  mocks = [];
  workers = [];
});

async function mock(script: number[] = [200]) {
  const m = await startMockWebhook(script);
  mocks.push(m);
  return m;
}

/** Runs fn and returns the audit rows it created (oldest first). */
async function newAudits(fn: () => Promise<unknown>) {
  const before = new Set((await prisma.auditLog.findMany({ select: { id: true } })).map((r) => r.id));
  await fn();
  const all = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  return all.filter((r) => !before.has(r.id));
}

function metaKeys(row: { metadata: unknown }): string[] {
  return Object.keys((row.metadata ?? {}) as object).sort();
}

/** Asserts exactly one row of `action` among `rows`, with exactly these metadata keys; returns it. */
function one(rows: Awaited<ReturnType<typeof newAudits>>, action: string, keys: string[]) {
  const hits = rows.filter((r) => r.action === action);
  expect(hits, `audit ${action}`).toHaveLength(1);
  expect(metaKeys(hits[0]!)).toEqual([...keys].sort());
  return hits[0]!;
}

const actions = (rows: { action: string }[]) => rows.map((r) => r.action).sort();

async function pendingJob(botId: string) {
  return prisma.doorbellJob.create({
    data: { id: newId("dbj"), botId, status: "PENDING", coalesceKey: botId, nextAttemptAt: new Date(Date.now() + 60_000) },
  });
}

async function failedJob(botId: string, lastError = "HTTP 503") {
  return prisma.doorbellJob.create({
    data: { id: newId("dbj"), botId, status: "FAILED", attempts: 5, lastStatusCode: 503, lastError, nextAttemptAt: new Date() },
  });
}

const ADMIN_PAGES = (botIds: string[]) => [
  "/admin/bots",
  "/admin/bots?status=active",
  "/admin/bots?status=disabled",
  "/admin/bots/new",
  ...botIds.map((id) => `/admin/bots/${id}`),
  "/admin/connections",
  "/admin/messages",
  "/admin/doorbells",
  "/admin/usage",
  "/admin/audit",
];

describe("admin login", () => {
  it("unauthenticated pages redirect to the login form; no-store everywhere", async () => {
    const app = testApp();
    const b = new Browser(app);
    for (const p of ["/admin", "/admin/bots", "/admin/bots/new", "/admin/connections", "/admin/audit", "/admin/usage"]) {
      const r = await b.get(p);
      expect(r.status, p).toBe(302);
      expect(r.location, p).toBe("/admin/login");
      expect(r.res.headers.get("cache-control"), p).toBe("no-store");
    }
    const login = await b.get("/admin/login");
    expect(login.status).toBe(200);
    expect(login.res.headers.get("cache-control")).toBe("no-store");
    const setCookie = login.res.headers.getSetCookie().find((c) => c.startsWith("bb_login_nonce="))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/admin\/login/i);
    // Unauthenticated POST also bounces (and does nothing).
    const r = await b.post("/admin/bots", { name: "X", ownerName: "Y" }, { csrf: "whatever" });
    expect(r.status).toBe(302);
    expect(await prisma.bot.count()).toBe(0);
  });

  it("wrong password / wrong email → 401 with the exact message and ADMIN_LOGIN_FAILED; success → session cookie", async () => {
    const app = testApp();
    const b = new Browser(app);
    const rows1 = await newAudits(async () => {
      const r = await b.tryLogin("admin@example.test", "nope-nope-nope");
      expect(r.status).toBe(401);
      expect(r.text).toContain(WRONG);
      expect(r.text).not.toContain("nope-nope-nope");
      expect(b.cookies.has("bb_admin")).toBe(false);
    });
    expect(actions(rows1)).toEqual(["ADMIN_LOGIN_FAILED"]);
    expect(rows1[0]!.metadata).toEqual({ emailMatched: true });
    expect(rows1[0]!.actorType).toBe("ADMIN");
    expect(rows1[0]!.actorId).toBeNull();

    const rows2 = await newAudits(async () => {
      const r = await b.tryLogin("someone@example.test", ADMIN_PASSWORD);
      expect(r.status).toBe(401);
      expect(r.text).toContain(WRONG);
      expect(r.text).not.toContain(ADMIN_PASSWORD);
    });
    expect(actions(rows2)).toEqual(["ADMIN_LOGIN_FAILED"]);
    expect(rows2[0]!.metadata).toEqual({ emailMatched: false });

    const rows3 = await newAudits(async () => {
      const r = await b.tryLogin("ADMIN@Example.test", ADMIN_PASSWORD); // case-insensitive email
      expect(r.status).toBe(302);
      expect(r.location).toBe("/admin/bots");
      const sc = r.res.headers.getSetCookie().find((c) => c.startsWith("bb_admin="))!;
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/SameSite=Lax/i);
      expect(sc).toMatch(/Path=\/admin(;|$)/i);
      expect(sc).toMatch(/Max-Age=43200/i);
    });
    expect(actions(rows3)).toEqual(["ADMIN_LOGIN"]);
    expect(rows3[0]!.actorId).toBe("admin");
    expect(await prisma.adminSession.count()).toBe(1);

    const page = await b.get("/admin/bots");
    expect(page.status).toBe(200);
    for (const nav of ["Bots", "Connections", "Messages", "Doorbells", "Usage", "Audit", "Log out"]) expect(page.text).toContain(nav);
    // Logged in: /admin/login bounces to the bots list.
    expect((await b.get("/admin/login")).location).toBe("/admin/bots");
    expect((await b.get("/admin")).location).toBe("/admin/bots");
  });

  it("A-37 6th failed login from one IP → 429 lockout page (even with the right password); other IPs unaffected", async () => {
    const app = testApp();
    const b = new Browser(app, "203.0.113.7");
    for (let i = 0; i < 5; i++) {
      const r = await b.tryLogin("admin@example.test", `wrong-${i}`);
      expect(r.status).toBe(401);
      expect(r.text).toContain(WRONG);
    }
    const sixth = await b.tryLogin("admin@example.test", ADMIN_PASSWORD);
    expect(sixth.status).toBe(429);
    expect(sixth.text).toContain(LOCKED);
    expect(b.cookies.has("bb_admin")).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "ADMIN_LOGIN_FAILED" } })).toBe(5);
    // A different IP can still log in.
    await loginAdmin(app, "198.51.100.9");
  });

  it("A-37 CSRF: login without _csrf, admin POST without/with wrong _csrf, foreign Origin → 403 and no effect", async () => {
    const app = testApp();
    const anon = new Browser(app);
    await anon.get("/admin/login");
    const noTok = await anon.post("/admin/login", { email: "admin@example.test", password: ADMIN_PASSWORD }, { csrf: null });
    expect(noTok.status).toBe(403);
    expect(noTok.text).toContain(CSRF_TEXT);
    expect(anon.cookies.has("bb_admin")).toBe(false);

    const b = await loginAdmin(app);
    const { bot } = await makeBot();
    const before = await prisma.auditLog.count();

    const missing = await b.post(`/admin/bots/${bot.id}/disable`, {}, { csrf: null });
    expect(missing.status).toBe(403);
    expect(missing.text).toContain(CSRF_TEXT);

    const wrong = await b.post(`/admin/bots/${bot.id}/disable`, {}, { csrf: "a".repeat(64) });
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain(CSRF_TEXT);

    const foreign = await b.post(`/admin/bots/${bot.id}/disable`, {}, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);

    const noOrigin = await b.post(`/admin/bots/${bot.id}/disable`, {}, { origin: null });
    expect(noOrigin.status).toBe(403);

    const create = await b.post("/admin/bots", { name: "Sneaky", ownerName: "X", deliverVia: "show_now" }, { csrf: null });
    expect(create.status).toBe(403);

    expect((await prisma.bot.findUnique({ where: { id: bot.id } }))!.status).toBe("ACTIVE");
    expect(await prisma.bot.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("logout deletes the session, clears the cookie, and audits ADMIN_LOGOUT", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const oldCookie = b.cookies.get("bb_admin")!;
    const rows = await newAudits(async () => {
      const r = await b.post("/admin/logout");
      expect(r.status).toBe(302);
      expect(r.location).toBe("/admin/login");
      const sc = r.res.headers.getSetCookie().find((c) => c.startsWith("bb_admin="))!;
      expect(sc).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    });
    expect(actions(rows)).toEqual(["ADMIN_LOGOUT"]);
    expect(rows[0]!.actorId).toBe("admin");
    expect(await prisma.adminSession.count()).toBe(0);
    b.cookies.set("bb_admin", oldCookie); // replaying the old cookie doesn't work
    expect((await b.get("/admin/bots")).location).toBe("/admin/login");
  });
});

describe("admin bots", () => {
  it("A-38 create bot (show_now): key shown once in the POST response, works on /mcp, never in any later GET", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    let key = "";
    const rows = await newAudits(async () => {
      const r = await b.post("/admin/bots", {
        name: "MAC Bridge",
        ownerName: "Adam",
        ownerEmail: "adam@example.test",
        notes: "phase 1",
        sendLimitPerHour: "",
        mcpCallLimitPerHour: "",
        deliverVia: "show_now",
      });
      expect(r.status).toBe(200);
      expect(r.res.headers.get("cache-control")).toBe("no-store");
      expect(r.text).toContain(SECRET_BANNER);
      expect(r.text).toContain("http://localhost:8080/mcp");
      expect(r.text).toContain("Back to bot");
      key = KEY_RE.exec(r.html)![0];
      expect(r.html.match(KEY_RE_G)).toHaveLength(1);
    });
    expect(actions(rows)).toEqual(["BOT_CREATED"]);
    const created = one(rows, "BOT_CREATED", ["name", "ownerName", "deliverVia"]);
    expect(created.metadata).toEqual({ name: "MAC Bridge", ownerName: "Adam", deliverVia: "show_now" });
    const bot = (await prisma.bot.findFirst({ where: { name: "MAC Bridge" } }))!;
    expect(created.targetId).toBe(bot.id);
    expect(created.targetType).toBe("bot");
    expect(bot.sendLimitPerHour).toBe(60);
    expect(bot.mcpCallLimitPerHour).toBe(600);
    expect(bot.ownerEmail).toBe("adam@example.test");
    expect(await prisma.setupLink.count()).toBe(0);

    const who = await new McpTestClient(app, key).ok("whoami");
    expect(who.name ?? JSON.stringify(who)).toContain("MAC Bridge");

    const secret = key.slice("bb_live_".length);
    for (const p of [...ADMIN_PAGES([bot.id]), `/admin/audit?target=${bot.id}`, "/admin/audit?action=BOT_CREATED"]) {
      const r = await b.get(p);
      expect(r.status, p).toBe(200);
      expect(r.res.headers.get("cache-control"), p).toBe("no-store");
      expect(r.text, p).not.toContain(secret);
      expect(r.html, p).not.toMatch(KEY_RE);
    }
    // The bots list shows the display prefix only.
    expect((await b.get("/admin/bots")).text).toContain(`bb_live_${bot.apiKeyPrefix}…`);
  });

  it("create bot (setup_link, default): setup link shown once, key parked in it; audits BOT_CREATED + SETUP_LINK_CREATED", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    let token = "";
    const rows = await newAudits(async () => {
      const r = await b.post("/admin/bots", { name: "Justin Bot", ownerName: "Justin" });
      expect(r.status).toBe(200);
      expect(r.res.headers.get("cache-control")).toBe("no-store");
      expect(r.text).toContain(SECRET_BANNER);
      token = SETUP_URL_RE.exec(r.html)![1]!;
      expect(r.html).not.toMatch(KEY_RE);
    });
    expect(actions(rows)).toEqual(["BOT_CREATED", "SETUP_LINK_CREATED"]);
    expect(one(rows, "BOT_CREATED", ["name", "ownerName", "deliverVia"]).metadata).toMatchObject({ deliverVia: "setup_link" });
    const bot = (await prisma.bot.findFirst({ where: { name: "Justin Bot" } }))!;
    const link = (await prisma.setupLink.findFirst({ where: { botId: bot.id } }))!;
    const sl = one(rows, "SETUP_LINK_CREATED", ["botId", "includesKey", "expiresAt"]);
    expect(sl.metadata).toEqual({ botId: bot.id, includesKey: true, expiresAt: link.expiresAt.toISOString() });
    expect(sl.targetType).toBe("setup_link");
    expect(sl.targetId).toBe(link.id);
    expect(link.apiKeyEnc).not.toBeNull();
    expect(Math.round((link.expiresAt.getTime() - link.createdAt.getTime()) / 3_600_000)).toBe(168);

    // The parked key is the bot's current key: revealing it authenticates.
    const setup = new Browser(app);
    const page = await setup.get(`/setup/${token}`);
    expect(page.status).toBe(200);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.html)![1]!;
    const rev = await setup.post(`/setup/${token}/reveal-key`, {}, { csrf });
    const key = KEY_RE.exec(rev.html)![0];
    await new McpTestClient(app, key).ok("whoami");

    for (const p of ADMIN_PAGES([bot.id])) {
      const r = await b.get(p);
      expect(r.text, p).not.toContain(token);
      expect(r.html, p).not.toMatch(KEY_RE);
    }
  });

  it("create bot validation: required, bot_ prefix, duplicate name, limits, email → 400 with messages and no audit", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    await makeBot({ name: "MAC Bridge" });
    const rows = await newAudits(async () => {
      const r1 = await b.post("/admin/bots", { name: "  ", ownerName: "", deliverVia: "show_now" });
      expect(r1.status).toBe(400);
      expect(r1.text).toContain("Name is required.");
      expect(r1.text).toContain("Owner name is required.");

      const r2 = await b.post("/admin/bots", { name: "mac  bridge", ownerName: "Adam", deliverVia: "show_now" });
      expect(r2.status).toBe(400);
      expect(r2.text).toContain("A bot named 'mac bridge' already exists.");
      expect(r2.html).not.toMatch(KEY_RE);

      const r3 = await b.post("/admin/bots", {
        name: "bot_sneaky",
        ownerName: "Adam",
        ownerEmail: "not-an-email",
        sendLimitPerHour: "0",
        mcpCallLimitPerHour: "100001",
        deliverVia: "show_now",
      });
      expect(r3.status).toBe(400);
      expect(r3.text).toContain("Send limit must be a whole number from 1 to 10000.");
      expect(r3.text).toContain("Tool call limit must be a whole number from 1 to 100000.");
      expect(r3.text).toContain("Owner email doesn");
      expect(r3.text).toContain("bot_");
      // Entered values are re-rendered.
      expect(r3.text).toContain('value="not-an-email"');

      const r4 = await b.post("/admin/bots", { name: "x".repeat(61), ownerName: "Adam", sendLimitPerHour: "2.5" });
      expect(r4.status).toBe(400);
      expect(r4.text).toContain("Send limit must be a whole number from 1 to 10000.");
    });
    expect(rows).toHaveLength(0);
    expect(await prisma.bot.count()).toBe(1);
  });

  it("duplicate-name message is exact", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    await makeBot({ name: "MAC Bridge" });
    const r = await b.post("/admin/bots", { name: "MAC Bridge", ownerName: "Adam" });
    expect(r.status).toBe(400);
    // hono/jsx escapes the apostrophes.
    const text = r.text;
    expect(text).toContain("A bot named 'MAC Bridge' already exists.");
  });

  it("edit: updates fields, audits BOT_UPDATED with changed fields + old/new limits; duplicate name and bad limits rejected", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot } = await makeBot({ name: "Alpha", ownerName: "Ann" });
    await makeBot({ name: "Beta" });

    const rows = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/edit`, {
        name: "Alpha Two",
        ownerName: "Ann",
        ownerEmail: "",
        notes: "",
        sendLimitPerHour: "120",
        mcpCallLimitPerHour: "600",
      });
      expect(r.status).toBe(302);
      expect(r.location).toBe(`/admin/bots/${bot.id}?ok=updated`);
    });
    expect(actions(rows)).toEqual(["BOT_UPDATED"]);
    const up = one(rows, "BOT_UPDATED", ["changed", "limits"]);
    expect(up.targetId).toBe(bot.id);
    expect(up.metadata).toEqual({
      changed: ["name", "sendLimitPerHour"],
      limits: { old: { sendLimitPerHour: 60, mcpCallLimitPerHour: 600 }, new: { sendLimitPerHour: 120, mcpCallLimitPerHour: 600 } },
    });
    const fresh = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(fresh.name).toBe("Alpha Two");
    expect(fresh.nameKey).toBe("alpha two");
    expect(fresh.sendLimitPerHour).toBe(120);
    expect((await b.get(`/admin/bots/${bot.id}?ok=updated`)).text).toContain("Changes saved.");

    // Profile-only change → no limits key.
    const rows2 = await newAudits(() =>
      b.post(`/admin/bots/${bot.id}/edit`, { name: "Alpha Two", ownerName: "Ann B", sendLimitPerHour: "120", mcpCallLimitPerHour: "600" }),
    );
    expect(one(rows2, "BOT_UPDATED", ["changed"]).metadata).toEqual({ changed: ["ownerName"] });

    const rows3 = await newAudits(async () => {
      const dup = await b.post(`/admin/bots/${bot.id}/edit`, { name: "BETA", ownerName: "Ann", sendLimitPerHour: "120", mcpCallLimitPerHour: "600" });
      expect(dup.status).toBe(400);
      expect(dup.text).toContain("A bot named 'BETA' already exists.");
      const bad = await b.post(`/admin/bots/${bot.id}/edit`, { name: "Alpha Two", ownerName: "Ann", sendLimitPerHour: "10001", mcpCallLimitPerHour: "0" });
      expect(bad.status).toBe(400);
      expect(bad.text).toContain("Send limit must be a whole number from 1 to 10000.");
      expect(bad.text).toContain("Tool call limit must be a whole number from 1 to 100000.");
      expect(bad.text).toContain('value="10001"');
      const missing = await b.post(`/admin/bots/${bot.id}/edit`, { name: "", ownerName: "Ann" });
      expect(missing.text).toContain("Name is required.");
    });
    expect(rows3).toHaveLength(0);
    const after = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(after.name).toBe("Alpha Two");
    expect(after.sendLimitPerHour).toBe(120);
    expect(after.mcpCallLimitPerHour).toBe(600);
  });

  it("A-48 disable → key fails on the next /mcp request and pending doorbells are cancelled; enable → works again", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot, key } = await makeBot();
    const client = new McpTestClient(app, key);
    await client.ok("whoami");
    const job = await pendingJob(bot.id);

    const rows = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/disable`);
      expect(r.status).toBe(302);
      expect(r.location).toBe(`/admin/bots/${bot.id}?ok=disabled`);
    });
    expect(actions(rows)).toEqual(["BOT_DISABLED"]);
    expect(one(rows, "BOT_DISABLED", []).targetId).toBe(bot.id);
    const res = await client.raw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } });
    expect(res.status).toBe(403);
    const d = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(d.status).toBe("DISABLED");
    expect(d.disabledAt).not.toBeNull();
    expect(d.apiKeyHash).toBe(bot.apiKeyHash);
    const j = (await prisma.doorbellJob.findUnique({ where: { id: job.id } }))!;
    expect(j.status).toBe("CANCELLED");
    expect(j.coalesceKey).toBeNull();
    expect((await b.get("/admin/bots?status=disabled")).text).toContain(bot.name);

    const rows2 = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/enable`);
      expect(r.status).toBe(302);
    });
    expect(actions(rows2)).toEqual(["BOT_ENABLED"]);
    one(rows2, "BOT_ENABLED", []);
    await client.ok("whoami");
    const e = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(e.status).toBe("ACTIVE");
    expect(e.disabledAt).toBeNull();
  });

  it("rotate-key requires confirm; then shows the new key once, kills the old key, audits BOT_KEY_ROTATED", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot, key: oldKey } = await makeBot();

    const noConfirm = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/rotate-key`);
      expect(r.status).toBe(302);
      expect(r.location).toBe(`/admin/bots/${bot.id}?ok=confirm`);
    });
    expect(noConfirm).toHaveLength(0);
    await new McpTestClient(app, oldKey).ok("whoami");

    let newKey = "";
    const rows = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/rotate-key`, { confirm: "yes" });
      expect(r.status).toBe(200);
      expect(r.res.headers.get("cache-control")).toBe("no-store");
      expect(r.text).toContain(SECRET_BANNER);
      newKey = KEY_RE.exec(r.html)![0];
    });
    expect(newKey).not.toBe(oldKey);
    expect(actions(rows)).toEqual(["BOT_KEY_ROTATED"]);
    const rot = one(rows, "BOT_KEY_ROTATED", ["newPrefix", "via"]);
    expect(rot.metadata).toMatchObject({ via: "rotate" });
    expect(newKey.startsWith(`bb_live_${(rot.metadata as any).newPrefix}`)).toBe(true);
    const old = await new McpTestClient(app, oldKey).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(old.status).toBe(401);
    await new McpTestClient(app, newKey).ok("whoami");

    for (const p of ADMIN_PAGES([bot.id])) {
      const r = await b.get(p);
      expect(r.text, p).not.toContain(newKey.slice(8));
      expect(r.html, p).not.toMatch(KEY_RE);
    }
  });

  it("setup-links: includeNewKey rotates the key and parks it; without it the key stays; ttl validated; older key links revoked", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot, key: oldKey } = await makeBot();

    // No key: owner keeps the current key.
    const rows1 = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/setup-links`, { ttlHours: "24" });
      expect(r.status).toBe(200);
      expect(r.text).toContain(SECRET_BANNER);
      expect(r.html).toMatch(SETUP_URL_RE);
    });
    expect(actions(rows1)).toEqual(["SETUP_LINK_CREATED"]);
    const l1 = (await prisma.setupLink.findFirst({ where: { botId: bot.id } }))!;
    expect(one(rows1, "SETUP_LINK_CREATED", ["botId", "includesKey", "expiresAt"]).metadata).toEqual({
      botId: bot.id,
      includesKey: false,
      expiresAt: l1.expiresAt.toISOString(),
    });
    expect(l1.apiKeyEnc).toBeNull();
    expect(Math.round((l1.expiresAt.getTime() - l1.createdAt.getTime()) / 3_600_000)).toBe(24);
    await new McpTestClient(app, oldKey).ok("whoami");

    // With a key: the old key dies right away.
    let token = "";
    const rows2 = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/setup-links`, { includeNewKey: "yes", ttlHours: "168" });
      expect(r.status).toBe(200);
      token = SETUP_URL_RE.exec(r.html)![1]!;
      expect(r.html).not.toMatch(KEY_RE);
    });
    expect(actions(rows2)).toEqual(["BOT_KEY_ROTATED", "SETUP_LINK_CREATED"]);
    expect(one(rows2, "BOT_KEY_ROTATED", ["newPrefix", "via"]).metadata).toMatchObject({ via: "setup_link" });
    expect(one(rows2, "SETUP_LINK_CREATED", ["botId", "includesKey", "expiresAt"]).metadata).toMatchObject({ includesKey: true });
    expect((await new McpTestClient(app, oldKey).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const l2 = (await prisma.setupLink.findFirst({ where: { botId: bot.id, apiKeyEnc: { not: null } } }))!;

    // A newer key link revokes the older unused one.
    await b.post(`/admin/bots/${bot.id}/setup-links`, { includeNewKey: "yes" });
    const l2after = (await prisma.setupLink.findUnique({ where: { id: l2.id } }))!;
    expect(l2after.revokedAt).not.toBeNull();
    expect(l2after.apiKeyEnc).toBeNull();
    expect((await new Browser(app).get(`/setup/${token}`)).status).toBe(404);

    const rows3 = await newAudits(async () => {
      const bad = await b.post(`/admin/bots/${bot.id}/setup-links`, { ttlHours: "169" });
      expect(bad.status).toBe(400);
      expect(bad.text).toContain("Expiry must be a whole number of hours from 1 to 168.");
      expect((await b.post(`/admin/bots/${bot.id}/setup-links`, { ttlHours: "0" })).status).toBe(400);
    });
    expect(rows3).toHaveLength(0);
  });

  it("setup link revoke: link stops working; audits SETUP_LINK_REVOKED", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot } = await makeBot();
    const r = await b.post(`/admin/bots/${bot.id}/setup-links`, { includeNewKey: "yes" });
    const token = SETUP_URL_RE.exec(r.html)![1]!;
    const link = (await prisma.setupLink.findFirst({ where: { botId: bot.id } }))!;
    expect((await new Browser(app).get(`/setup/${token}`)).status).toBe(200);
    expect((await b.get(`/admin/bots/${bot.id}`)).text).toContain(`/admin/setup-links/${link.id}/revoke`);

    const rows = await newAudits(async () => {
      const res = await b.post(`/admin/setup-links/${link.id}/revoke`);
      expect(res.status).toBe(302);
      expect(res.location).toBe(`/admin/bots/${bot.id}?ok=link_revoked`);
    });
    expect(actions(rows)).toEqual(["SETUP_LINK_REVOKED"]);
    const rev = one(rows, "SETUP_LINK_REVOKED", ["botId", "includesKey", "expiresAt"]);
    expect(rev.metadata).toEqual({ botId: bot.id, includesKey: true, expiresAt: link.expiresAt.toISOString() });
    expect(rev.targetId).toBe(link.id);
    const after = (await prisma.setupLink.findUnique({ where: { id: link.id } }))!;
    expect(after.revokedAt).not.toBeNull();
    expect(after.apiKeyEnc).toBeNull();
    expect((await new Browser(app).get(`/setup/${token}`)).status).toBe(404);
    expect((await b.post(`/admin/setup-links/sl_${"x".repeat(20)}/revoke`)).status).toBe(404);
  });

  it("doorbell test (admin): sends bridge.test to the mock; pass/fail banners, state, audit; 11th test → rate limited", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const m = await mock([200]);
    const { bot } = await makeBot();
    await setDoorbell(bot.id, m.url, "sender-key-admin-test");

    const rows = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/doorbell/test`);
      expect(r.status).toBe(200);
      expect(r.text).toContain(PASS_BANNER);
      expect(r.text).not.toContain("sender-key-admin-test");
      expect(r.text).not.toContain(m.url);
      expect(r.text).toContain("127.0.0.1/…/abc123");
    });
    expect(m.requests).toHaveLength(1);
    const body = JSON.parse(m.requests[0]!.body);
    expect(body.event).toBe("bridge.test");
    expect(m.requests[0]!.headers["authorization"]).toBe("Bearer sender-key-admin-test");
    expect(m.requests[0]!.headers["x-automation-key"]).toBe("sender-key-admin-test");
    expect(actions(rows)).toEqual(["BOT_DOORBELL_TESTED"]);
    const t = one(rows, "BOT_DOORBELL_TESTED", ["ok", "statusCode"]);
    expect(t.metadata).toEqual({ ok: true, statusCode: 200 });
    expect(t.actorType).toBe("ADMIN");

    m.setScript([401]);
    const rows2 = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/doorbell/test`);
      expect(r.text).toContain(REJECTED_BANNER);
    });
    expect(one(rows2, "BOT_DOORBELL_TESTED", ["ok", "statusCode", "error"]).metadata).toMatchObject({ ok: false, statusCode: 401 });
    const broken = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(broken.doorbellState).toBe("BROKEN");
    expect(broken.lastDoorbellError).toBe("HTTP 401 (sender key rejected)");

    m.setScript([200]);
    for (let i = 0; i < 8; i++) await b.post(`/admin/bots/${bot.id}/doorbell/test`);
    expect(m.requests).toHaveLength(10);
    const rows3 = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/doorbell/test`);
      expect(r.text).toContain(TOO_MANY_TESTS);
    });
    expect(rows3).toHaveLength(0);
    expect(m.requests).toHaveLength(10);
  });

  it("A-48 doorbell clear requires confirm; then state NONE, URL + key removed, pending jobs cancelled; audited", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot } = await makeBot();
    await setDoorbell(bot.id, "https://api2.cursor.sh/automations/webhook/zzz999");
    const job = await pendingJob(bot.id);

    expect(await newAudits(() => b.post(`/admin/bots/${bot.id}/doorbell/clear`))).toHaveLength(0);
    expect((await prisma.bot.findUnique({ where: { id: bot.id } }))!.doorbellState).toBe("OK");

    const rows = await newAudits(async () => {
      const r = await b.post(`/admin/bots/${bot.id}/doorbell/clear`, { confirm: "yes" });
      expect(r.status).toBe(302);
      expect(r.location).toBe(`/admin/bots/${bot.id}?ok=cleared`);
    });
    expect(actions(rows)).toEqual(["BOT_DOORBELL_CLEARED"]);
    one(rows, "BOT_DOORBELL_CLEARED", []);
    const after = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(after.doorbellState).toBe("NONE");
    expect(after.webhookUrl).toBeNull();
    expect(after.webhookKeyEnc).toBeNull();
    const j = (await prisma.doorbellJob.findUnique({ where: { id: job.id } }))!;
    expect(j.status).toBe("CANCELLED");
    expect(j.coalesceKey).toBeNull();
  });

  it("bot detail shows the masked doorbell only, never the full URL", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot } = await makeBot();
    await setDoorbell(bot.id, "https://api2.cursor.sh/automations/webhook/very-secret-path-abc123", "sender-key-zzz-999");
    const r = await b.get(`/admin/bots/${bot.id}`);
    expect(r.text).toContain("api2.cursor.sh/…/abc123");
    expect(r.text).not.toContain("very-secret-path");
    expect(r.text).not.toContain("sender-key-zzz-999");
    expect((await b.get("/admin/bots")).text).not.toContain("very-secret-path");
  });
});

describe("admin connections", () => {
  it("approve, duplicate, revoke (confirm), reactivate — each audited once with botAId/botBId", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot: x } = await makeBot({ name: "Xavier" });
    const { bot: y } = await makeBot({ name: "Yolanda" });

    const bad = await newAudits(async () => {
      const r = await b.post("/admin/connections", { botX: x.id, botY: x.id });
      expect(r.status).toBe(400);
      expect(r.text).toContain("Pick two different bots.");
      const r2 = await b.post("/admin/connections", { botX: x.id, botY: "bot_nope" });
      expect(r2.text).toContain("Pick two different bots.");
    });
    expect(bad).toHaveLength(0);

    const rows = await newAudits(async () => {
      const r = await b.post("/admin/connections", { botX: x.id, botY: y.id, note: "phase 1" });
      expect(r.status).toBe(302);
      expect(r.location).toBe("/admin/connections?ok=approved");
    });
    expect(actions(rows)).toEqual(["CONNECTION_APPROVED"]);
    const conn = (await prisma.connection.findFirst())!;
    expect(conn.status).toBe("ACTIVE");
    expect(conn.note).toBe("phase 1");
    const ap = one(rows, "CONNECTION_APPROVED", ["botAId", "botBId"]);
    expect(ap.metadata).toEqual({ botAId: conn.botAId, botBId: conn.botBId });
    expect(ap.targetId).toBe(conn.id);
    const page = await b.get("/admin/connections");
    expect(page.text).toContain("Xavier");
    expect(page.text).toContain("Yolanda");

    // Already active → no new row.
    expect(await newAudits(() => b.post("/admin/connections", { botX: y.id, botY: x.id }))).toHaveLength(0);

    expect(await newAudits(() => b.post(`/admin/connections/${conn.id}/revoke`))).toHaveLength(0);
    expect((await prisma.connection.findUnique({ where: { id: conn.id } }))!.status).toBe("ACTIVE");

    const rows2 = await newAudits(async () => {
      const r = await b.post(`/admin/connections/${conn.id}/revoke`, { confirm: "yes" });
      expect(r.status).toBe(302);
    });
    expect(actions(rows2)).toEqual(["CONNECTION_REVOKED"]);
    one(rows2, "CONNECTION_REVOKED", ["botAId", "botBId"]);
    expect((await prisma.connection.findUnique({ where: { id: conn.id } }))!.status).toBe("REVOKED");

    const rows3 = await newAudits(async () => {
      const r = await b.post("/admin/connections", { botX: x.id, botY: y.id });
      expect(r.location).toBe("/admin/connections?ok=reactivated");
    });
    expect(actions(rows3)).toEqual(["CONNECTION_REACTIVATED"]);
    one(rows3, "CONNECTION_REACTIVATED", ["botAId", "botBId"]);
    expect((await prisma.connection.findUnique({ where: { id: conn.id } }))!.status).toBe("ACTIVE");
    expect(await prisma.connection.count()).toBe(1);
  });
});

describe("admin messages", () => {
  it("A-39 message lists show no bodies; viewing one shows the banner and writes MESSAGE_VIEWED every time", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { A, B, ab } = await trio();
    const a = new McpTestClient(app, A.key);
    const bc = new McpTestClient(app, B.key);
    const sent = await a.ok("send_message", { to: "Test B", subject: "Hello subject", body: "CANARY-BODY-<b>one</b>" });
    await bc.ok("send_message", { to: "Test A", body: "CANARY-BODY-two", replyToId: sent.messageId });

    for (const p of ["/admin/messages", `/admin/messages?bot=${A.bot.id}`, `/admin/messages?connection=${ab.id}`, "/admin/messages?page=2"]) {
      const r = await b.get(p);
      expect(r.status, p).toBe(200);
      expect(r.text, p).not.toContain("CANARY-BODY");
    }
    const list = await b.get("/admin/messages");
    expect(list.text).toContain("Hello subject");
    expect(list.text).toContain(`/admin/messages/${sent.messageId}`);
    expect(await prisma.auditLog.count({ where: { action: "MESSAGE_VIEWED" } })).toBe(0);
    // Other admin pages carry no bodies either.
    for (const p of ADMIN_PAGES([A.bot.id, B.bot.id])) expect((await b.get(p)).text, p).not.toContain("CANARY-BODY");

    const rows = await newAudits(async () => {
      const r = await b.get(`/admin/messages/${sent.messageId}`);
      expect(r.status).toBe(200);
      expect(r.res.headers.get("cache-control")).toBe("no-store");
      expect(r.text).toContain(VIEW_BANNER);
      expect(r.html).toContain("CANARY-BODY-&lt;b&gt;one&lt;/b&gt;");
      expect(r.html).not.toContain("<b>one</b>");
      expect(r.text).not.toContain("CANARY-BODY-two"); // the rest of the thread is links only
    });
    expect(actions(rows)).toEqual(["MESSAGE_VIEWED"]);
    const v = one(rows, "MESSAGE_VIEWED", ["connectionId"]);
    expect(v.metadata).toEqual({ connectionId: ab.id });
    expect(v.targetId).toBe(sent.messageId);
    expect(v.targetType).toBe("message");

    await b.get(`/admin/messages/${sent.messageId}`);
    expect(await prisma.auditLog.count({ where: { action: "MESSAGE_VIEWED" } })).toBe(2);
    expect((await b.get(`/admin/messages/msg_${"x".repeat(20)}`)).status).toBe(404);
  });
});

describe("admin doorbells + usage", () => {
  it("A-29 display: a FAILED job (always 503) shows on /admin/doorbells with its error and a retry button", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const m = await mock([503]);
    const { A, B } = await trio();
    await setDoorbell(B.bot.id, m.url);
    const w = new DoorbellWorker({ backoffSchedule: [50, 50, 50, 50] });
    workers.push(w);
    w.start();
    await new McpTestClient(app, A.key).ok("send_message", { to: "Test B", body: "x" });
    await waitFor(async () => (await prisma.doorbellJob.findFirst({ where: { botId: B.bot.id } }))?.status === "FAILED", 10000);
    const job = (await prisma.doorbellJob.findFirst({ where: { botId: B.bot.id } }))!;

    const r = await b.get("/admin/doorbells");
    expect(r.status).toBe(200);
    const row = r.html.slice(r.html.indexOf(job.id));
    const rowHtml = row.slice(0, row.indexOf("</tr>"));
    expect(rowHtml).toContain("FAILED");
    expect(rowHtml).toContain("HTTP 503");
    expect(rowHtml).toContain("503");
    expect(rowHtml).toContain("Test B");
    expect(rowHtml).toContain(`/admin/doorbells/${job.id}/retry`);
    expect(r.text).not.toContain(m.url);
    const failedOnly = await b.get("/admin/doorbells?status=FAILED");
    expect(failedOnly.text).toContain(job.id);
    expect((await b.get("/admin/doorbells?status=SENT")).text).not.toContain(job.id);
    // Bot detail lists the job too.
    expect((await b.get(`/admin/bots/${B.bot.id}`)).text).toContain(job.id);
  });

  it("retry requeues a FAILED job (audited); if a job is already queued it shows the exact notice and changes nothing", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { bot } = await makeBot();
    const failed = await failedJob(bot.id);

    const rows = await newAudits(async () => {
      const r = await b.post(`/admin/doorbells/${failed.id}/retry`);
      expect(r.status).toBe(302);
      expect(r.location).toBe("/admin/doorbells?ok=retried");
    });
    expect(actions(rows)).toEqual(["DOORBELL_JOB_RETRIED"]);
    const rr = one(rows, "DOORBELL_JOB_RETRIED", ["botId"]);
    expect(rr.metadata).toEqual({ botId: bot.id });
    expect(rr.targetId).toBe(failed.id);
    expect(rr.targetType).toBe("doorbell_job");
    const j = (await prisma.doorbellJob.findUnique({ where: { id: failed.id } }))!;
    expect(j.status).toBe("PENDING");
    expect(j.attempts).toBe(0);
    expect(j.coalesceKey).toBe(bot.id);
    expect(j.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

    // Another FAILED job while that one is queued.
    const failed2 = await failedJob(bot.id, "HTTP 401 (sender key rejected)");
    const rows2 = await newAudits(async () => {
      const r = await b.post(`/admin/doorbells/${failed2.id}/retry`);
      expect(r.status).toBe(302);
      const page = await b.get(r.location!);
      expect(page.text).toContain("A doorbell is already queued for this bot.");
    });
    expect(rows2).toHaveLength(0);
    const j2 = (await prisma.doorbellJob.findUnique({ where: { id: failed2.id } }))!;
    expect(j2.status).toBe("FAILED");
    expect(j2.attempts).toBe(5);
  });

  it("usage page shows this month's counters per bot with totals", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const { A, B } = await trio();
    const a = new McpTestClient(app, A.key);
    await a.ok("send_message", { to: "Test B", body: "1" });
    await a.ok("send_message", { to: "Test B", body: "2" });
    await a.ok("send_message", { to: "Test B", body: "3" });
    await flushUsage();
    const r = await b.get("/admin/usage");
    expect(r.status).toBe(200);
    const cells = (name: string) => {
      const i = r.html.indexOf(`>${name}</a>`);
      const tr = r.html.slice(i, r.html.indexOf("</tr>", i));
      return [...tr.matchAll(/<td>(\d+)<\/td>/g)].map((x) => Number(x[1]));
    };
    expect(cells("Test A")).toEqual([3, 0, 3, 0, 0]);
    expect(cells("Test B")).toEqual([0, 3, 0, 0, 0]);
    const ti = r.html.indexOf("<th>Total</th>");
    const totals = [...r.html.slice(ti, r.html.indexOf("</tr>", ti)).matchAll(/<th>(\d+)<\/th>/g)].map((x) => Number(x[1]));
    expect(totals).toEqual([3, 3, 3, 0, 0]);
    expect((await b.get("/admin/usage?month=2020-01")).html).not.toMatch(/<td>3<\/td>/);
    void B;
  });

  it("audit page renders rows with escaped metadata", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    await b.post("/admin/bots", { name: "<script>x</script>", ownerName: "O", deliverVia: "show_now" });
    const r = await b.get("/admin/audit");
    expect(r.text).toContain("BOT_CREATED");
    expect(r.html).not.toContain("<script>x</script>");
    expect((await b.get("/admin/audit?action=ADMIN_LOGIN")).text).not.toContain("BOT_CREATED");
  });

  it("maintenance retention requires confirm; then runs and audits RETENTION_PURGE (actor ADMIN)", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    expect(await newAudits(() => b.post("/admin/maintenance/retention"))).toHaveLength(0);
    const rows = await newAudits(async () => {
      const r = await b.post("/admin/maintenance/retention", { confirm: "yes" });
      expect(r.status).toBe(302);
    });
    expect(actions(rows)).toEqual(["RETENTION_PURGE"]);
    const p = one(rows, "RETENTION_PURGE", ["messages", "doorbellJobs", "setupLinks", "sessions", "auditRows"]);
    expect(p.actorType).toBe("ADMIN");
  });

  it("admin forms over 16 KiB → 413", async () => {
    const app = testApp();
    const b = await loginAdmin(app);
    const r = await b.post("/admin/bots", { name: "Big", ownerName: "O", notes: "x".repeat(17 * 1024) });
    expect(r.status).toBe(413);
    expect(await prisma.bot.count()).toBe(0);
    void ORIGIN;
  });
});
