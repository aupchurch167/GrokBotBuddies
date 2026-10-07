import { afterEach, describe, expect, it } from "vitest";
import { randomBase62 } from "../../src/lib/base62.js";
import { disableBot } from "../../src/services/bots.js";
import { createSetupLink, revokeSetupLink } from "../../src/services/setupLinks.js";
import { Browser, decodeEntities, extractCsrf, type Resp } from "../helpers/admin.js";
import { testApp } from "../helpers/app.js";
import { advance, setNow } from "../helpers/clock.js";
import { prisma } from "../helpers/db.js";
import { makeBot } from "../helpers/factories.js";
import { McpTestClient } from "../helpers/mcpClient.js";
import { startMockWebhook } from "../helpers/mockWebhook.js";

const ALREADY = "Your key was already shown. If you lost it, ask the bridge admin for a new setup link.";
const TOO_MANY_SAVES = "Too many attempts on this link. Ask the bridge admin for a new one.";
const BAD_SENDER = "Paste the sender key from your routine's panel. It can't be empty or contain spaces.";
const TOO_MANY_TESTS = "Too many tests. Wait 10 minutes and try again.";
const TOO_MANY_TOKENS = "Too many attempts. Wait 10 minutes and try again.";
const PASS =
  "Doorbell test passed. Your bot should wake up in a moment, find an empty inbox, and do nothing. That's expected.";
const REJECTED =
  "Doorbell test failed: the webhook rejected the sender key. Copy the sender key from the routine's panel again and save.";
const NOT_FOUND =
  "Doorbell test failed: that webhook URL wasn't found. Copy the URL from the routine's panel again and save.";
const SERVER_ERR = (s: number) =>
  `Doorbell test failed: Grok Bot's webhook service returned an error (${s}). Try again in a few minutes.`;
const INVALID_H1 = "This setup link isn't valid.";
const INVALID_REST =
  "It may have expired, been used already, or been replaced. Ask the bridge admin to send you a new one.";
const DONE = (name: string) =>
  `You're connected. "${name}" can now use Bot Bridge, and its doorbell works. You can close this page. This link no longer works.`;
const KEY_RE = /bb_live_[0-9A-Za-z]{43}/;
const SENDER_KEY = "sk-routine-SECRET-0123456789";

let mocks: Awaited<ReturnType<typeof startMockWebhook>>[] = [];
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()));
  mocks = [];
});

async function mock(script: number[] = [200]) {
  const m = await startMockWebhook(script);
  mocks.push(m);
  return m;
}

/** Text content with tags stripped, entities decoded, whitespace collapsed. */
const plain = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/ ([.,)])/g, "$1");

async function newAudits(fn: () => Promise<unknown>) {
  const before = new Set((await prisma.auditLog.findMany({ select: { id: true } })).map((r) => r.id));
  await fn();
  return (await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).filter((r) => !before.has(r.id));
}
const actions = (rows: { action: string }[]) => rows.map((r) => r.action).sort();
function one(rows: Awaited<ReturnType<typeof newAudits>>, action: string, keys: string[]) {
  const hits = rows.filter((r) => r.action === action);
  expect(hits, `audit ${action}`).toHaveLength(1);
  expect(Object.keys((hits[0]!.metadata ?? {}) as object).sort()).toEqual([...keys].sort());
  return hits[0]!;
}

async function fixture(opts: { includeNewKey?: boolean; name?: string } = {}) {
  const app = testApp();
  const made = await makeBot({ name: opts.name ?? "Justin Bot", ownerName: "Justin" });
  const created = await createSetupLink(made.bot.id, { includeNewKey: opts.includeNewKey ?? true });
  const owner = new Browser(app, "192.0.2.10");
  return { app, bot: made.bot, oldKey: made.key, link: created.link, token: created.token, owner };
}

/** GET the setup page and return it plus its _csrf. */
async function open(owner: Browser, token: string): Promise<Resp & { csrf: string }> {
  const r = await owner.get(`/setup/${token}`);
  expect(r.status, r.html.slice(0, 300)).toBe(200);
  return { ...r, csrf: extractCsrf(r.html)! };
}

const save = (owner: Browser, token: string, csrf: string, webhookUrl: string, senderKey = SENDER_KEY) =>
  owner.post(`/setup/${token}/doorbell`, { webhookUrl, senderKey }, { csrf });

function expectSetupHeaders(r: Resp, label = "") {
  expect(r.res.headers.get("cache-control"), label).toBe("no-store");
  expect(r.res.headers.get("referrer-policy"), label).toBe("no-referrer");
  expect(r.res.headers.get("x-robots-tag"), label).toBe("noindex");
}

describe("setup links: validity", () => {
  it("A-41 invalid, malformed, expired, used, revoked, and disabled-bot tokens → identical 404 page", async () => {
    const app = testApp();
    const owner = new Browser(app, "192.0.2.20");
    const mk = async (name: string) => {
      const { bot } = await makeBot({ name });
      return { bot, ...(await createSetupLink(bot.id, { includeNewKey: true })) };
    };
    const expired = await mk("Expired");
    await prisma.setupLink.update({ where: { id: expired.link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const used = await mk("Used");
    await prisma.setupLink.update({ where: { id: used.link.id }, data: { usedAt: new Date() } });
    const revoked = await mk("Revoked");
    await revokeSetupLink(revoked.link.id, null);
    const disabled = await mk("Disabled");
    await disableBot(disabled.bot.id);
    const valid = await mk("Valid");

    const tokens = {
      unknown: randomBase62(43),
      short: "abc",
      long: randomBase62(44),
      symbols: `${randomBase62(42)}-`,
      expired: expired.token,
      used: used.token,
      revoked: revoked.token,
      disabled: disabled.token,
    };
    const bodies = new Set<string>();
    for (const [label, t] of Object.entries(tokens)) {
      const r = await owner.get(`/setup/${encodeURIComponent(t)}`);
      expect(r.status, label).toBe(404);
      expectSetupHeaders(r, label);
      expect(plain(r.html), label).toContain(INVALID_H1);
      expect(plain(r.html), label).toContain(INVALID_REST);
      bodies.add(r.html);
    }
    // POST endpoints answer the same way.
    for (const path of ["reveal-key", "doorbell", "test"]) {
      const r = await owner.post(`/setup/${expired.token}/${path}`, { webhookUrl: "x", senderKey: "y" }, { csrf: "z" });
      expect(r.status, path).toBe(404);
      bodies.add(r.html);
    }
    expect(bodies.size).toBe(1);
    // Nothing on the invalid pages leaks the bot names.
    for (const name of ["Expired", "Used", "Revoked", "Disabled"]) expect([...bodies][0]).not.toContain(name);
    // A valid link still opens from another IP.
    await open(new Browser(app, "192.0.2.21"), valid.token);
    // Revoked/expired links keep no parked key.
    expect((await prisma.setupLink.findUnique({ where: { id: revoked.link.id } }))!.apiKeyEnc).toBeNull();
  });

  it("per-IP limiter: 20 invalid hits → 429 (even for a valid token); other IPs unaffected; resets after 10 minutes", async () => {
    setNow(Date.now());
    const { app, token } = await fixture();
    const attacker = new Browser(app, "198.51.100.66");
    for (let i = 0; i < 20; i++) expect((await attacker.get(`/setup/${randomBase62(43)}`)).status).toBe(404);
    const blocked = await attacker.get(`/setup/${randomBase62(43)}`);
    expect(blocked.status).toBe(429);
    expect(plain(blocked.html)).toContain(TOO_MANY_TOKENS);
    expectSetupHeaders(blocked);
    expect((await attacker.get(`/setup/${token}`)).status).toBe(429);
    await open(new Browser(app, "198.51.100.67"), token);
    advance(10 * 60_000 + 1000);
    await open(attacker, token);
  });

  it("setup pages send no-store, no-referrer, noindex and the exact copy; first GET alone writes SETUP_LINK_OPENED", async () => {
    const { owner, token, link, bot } = await fixture();
    const rows = await newAudits(async () => {
      const r = await open(owner, token);
      expectSetupHeaders(r);
      const t = plain(r.html);
      expect(t).toContain('Connect "Justin Bot" to Bot Bridge');
      expect(t).toContain(
        "Hi Justin. This private page finishes connecting your Grok Bot to Bot Bridge. Don't share this link. It expires ",
      );
      expect(t).toMatch(/It expires [A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M E[SD]?T\./);
      expect(t).toContain("Step 1: Your connector details");
      expect(t).toContain("MCP connector URL: http://localhost:8080/mcp");
      expect(t).toContain("Header: Authorization: Bearer <your API key>");
      expect(t).toContain(
        "Your API key is ready. It will be shown once. Have your Grok Bot connector settings open before you click.",
      );
      expect(t).toContain("Reveal my API key");
      expect(t).toContain("Step 2: Doorbell (so your bot wakes up when mail arrives)");
      expect(t).toContain(
        "In Grok Bot, ask your bot to create a webhook routine named Bot Bridge doorbell (the prompt is in the setup sheet). Then open that routine's panel and copy its webhook URL and sender key into the boxes below. Paste the sender key only here, never into a chat with your bot.",
      );
      expect(t).toContain("Save and test doorbell");
      expect(t).toContain(
        "Skipping step 2 is OK. Your bot can still check its inbox on its own schedule; it just won't be woken automatically.",
      );
      expect(r.html).not.toMatch(KEY_RE);
      await owner.get(`/setup/${token}`);
      await owner.get(`/setup/${token}`);
    });
    expect(actions(rows)).toEqual(["SETUP_LINK_OPENED"]);
    const opened = one(rows, "SETUP_LINK_OPENED", ["botId"]);
    expect(opened.metadata).toEqual({ botId: bot.id });
    expect(opened.actorType).toBe("OWNER");
    expect(opened.actorId).toBe(link.id);
    expect(opened.targetType).toBe("setup_link");
    expect(opened.targetId).toBe(link.id);
  });

  it("a link without a key says the admin gave the key separately", async () => {
    const { owner, token } = await fixture({ includeNewKey: false });
    const r = await open(owner, token);
    expect(plain(r.html)).toContain("The bridge admin gave you your API key separately.");
    expect(plain(r.html)).not.toContain("Reveal my API key");
  });

  it("POSTs need the link's _csrf and our Origin", async () => {
    const { app, owner, token, link } = await fixture();
    const other = await createSetupLink((await makeBot({ name: "Other" })).bot.id, { includeNewKey: false });
    const otherCsrf = (await open(new Browser(app, "192.0.2.99"), other.token)).csrf;
    const { csrf } = await open(owner, token);
    const CSRF_TEXT = "Your session expired or the form was stale. Go back, refresh, and try again.";
    const r1 = await owner.post(`/setup/${token}/reveal-key`, {}, { csrf: null });
    expect(r1.status).toBe(403);
    expect(plain(r1.html)).toContain(CSRF_TEXT);
    expect((await owner.post(`/setup/${token}/reveal-key`, {}, { csrf: otherCsrf })).status).toBe(403);
    expect((await owner.post(`/setup/${token}/reveal-key`, {}, { csrf, origin: "https://evil.example" })).status).toBe(403);
    expect((await owner.post(`/setup/${token}/doorbell`, { webhookUrl: "x", senderKey: SENDER_KEY }, { csrf: null })).status).toBe(403);
    const fresh = (await prisma.setupLink.findUnique({ where: { id: link.id } }))!;
    expect(fresh.apiKeyEnc).not.toBeNull();
    expect(fresh.saveAttempts).toBe(0);
  });
});

describe("setup links: key reveal", () => {
  it("A-46 three GETs (link previewer) don't consume the key; then reveal works", async () => {
    const { app, owner, token, link } = await fixture();
    const previewer = new Browser(app, "203.0.113.50");
    for (let i = 0; i < 3; i++) expect((await previewer.get(`/setup/${token}`)).status).toBe(200);
    const l = (await prisma.setupLink.findUnique({ where: { id: link.id } }))!;
    expect(l.apiKeyEnc).not.toBeNull();
    expect(l.keyRevealedAt).toBeNull();
    expect(l.usedAt).toBeNull();
    const { csrf } = await open(owner, token);
    const r = await owner.post(`/setup/${token}/reveal-key`, {}, { csrf });
    expect(r.status).toBe(200);
    expect(r.html).toMatch(KEY_RE);
  });

  it("A-42 reveal once: KeyOnce page, key works on /mcp, prior key dead; second reveal shows the already-shown text", async () => {
    const { app, owner, token, link, bot, oldKey } = await fixture();
    // The link's key replaced the bot's key right away.
    expect((await new McpTestClient(app, oldKey).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const { csrf } = await open(owner, token);
    let key = "";
    const rows = await newAudits(async () => {
      const r = await owner.post(`/setup/${token}/reveal-key`, {}, { csrf });
      expect(r.status).toBe(200);
      expectSetupHeaders(r);
      key = KEY_RE.exec(r.html)![0];
      const t = plain(r.html);
      expect(t).toContain("Your Bot Bridge API key");
      expect(t).toContain(
        "Copy it now and paste it into your Grok Bot custom MCP connector as the header value Bearer <key>. It won't be shown again. Don't paste it into a chat. If you lose it, ask the bridge admin for a new setup link.",
      );
      expect(t).toContain("Back to setup");
      expect(r.html).toMatch(/<input[^>]*readonly[^>]*value="bb_live_/);
    });
    expect(actions(rows)).toEqual(["SETUP_LINK_KEY_REVEALED"]);
    const rev = one(rows, "SETUP_LINK_KEY_REVEALED", ["botId"]);
    expect(rev.metadata).toEqual({ botId: bot.id });
    expect(rev.actorType).toBe("OWNER");
    expect(rev.actorId).toBe(link.id);
    expect(rev.targetId).toBe(link.id);
    expect(rev.ip).toBe("192.0.2.10");

    const l = (await prisma.setupLink.findUnique({ where: { id: link.id } }))!;
    expect(l.apiKeyEnc).toBeNull();
    expect(l.keyRevealedAt).not.toBeNull();
    expect(l.usedAt).toBeNull(); // no doorbell yet → link stays open

    const who = await new McpTestClient(app, key).ok("whoami");
    expect(JSON.stringify(who)).toContain("Justin Bot");
    expect((await new McpTestClient(app, oldKey).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);

    const rows2 = await newAudits(async () => {
      const again = await owner.post(`/setup/${token}/reveal-key`, {}, { csrf });
      expect(again.status).toBe(200);
      expect(plain(again.html)).toContain(ALREADY);
      expect(again.html).not.toMatch(KEY_RE);
      expect(again.html).not.toContain(key.slice(8));
    });
    expect(rows2).toHaveLength(0);
    const page = await owner.get(`/setup/${token}`);
    expect(plain(page.html)).toContain(
      "Your API key was already shown. If you lost it, ask the bridge admin for a new setup link.",
    );
    expect(page.html).not.toMatch(KEY_RE);
    expect(plain(page.html)).not.toContain("Reveal my API key");
  });
});

describe("setup links: doorbell", () => {
  it("A-43 reveal first, then save: mock gets bridge.test with both headers; pass → OK and the link completes", async () => {
    const m = await mock([200]);
    const { owner, token, link, bot } = await fixture();
    const { csrf } = await open(owner, token);
    await owner.post(`/setup/${token}/reveal-key`, {}, { csrf });

    const rows = await newAudits(async () => {
      const r = await save(owner, token, csrf, m.url);
      expect(r.status).toBe(200);
      expectSetupHeaders(r);
      const t = plain(r.html);
      expect(t).toContain(PASS);
      expect(t).toContain(DONE("Justin Bot"));
      expect(r.html).not.toContain(SENDER_KEY);
      expect(r.html).not.toContain(m.url);
    });
    expect(m.requests).toHaveLength(1);
    const req = m.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/automations/webhook/routine-abc123");
    expect(req.body.startsWith('{"event":"bridge.test"')).toBe(true);
    expect(JSON.parse(req.body).event).toBe("bridge.test");
    expect(req.headers["authorization"]).toBe(`Bearer ${SENDER_KEY}`);
    expect(req.headers["x-automation-key"]).toBe(SENDER_KEY);

    expect(actions(rows)).toEqual(["BOT_DOORBELL_SET", "BOT_DOORBELL_TESTED", "SETUP_LINK_COMPLETED"]);
    const set = one(rows, "BOT_DOORBELL_SET", ["host"]);
    expect(set.metadata).toEqual({ host: "127.0.0.1" });
    expect(set.actorType).toBe("OWNER");
    expect(set.actorId).toBe(link.id);
    expect(set.targetId).toBe(bot.id);
    const tested = one(rows, "BOT_DOORBELL_TESTED", ["ok", "statusCode"]);
    expect(tested.metadata).toEqual({ ok: true, statusCode: 200 });
    expect(tested.actorType).toBe("OWNER");
    const done = one(rows, "SETUP_LINK_COMPLETED", ["botId"]);
    expect(done.metadata).toEqual({ botId: bot.id });
    expect(done.targetId).toBe(link.id);

    const b = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(b.doorbellState).toBe("OK");
    expect(b.lastDoorbellError).toBeNull();
    expect(b.webhookUrl).toBe(m.url);
    expect(b.webhookKeyEnc).not.toContain(SENDER_KEY);
    expect((await prisma.setupLink.findUnique({ where: { id: link.id } }))!.usedAt).not.toBeNull();
    // The link no longer works.
    const after = await owner.get(`/setup/${token}`);
    expect(after.status).toBe(404);
    expect(plain(after.html)).toContain(INVALID_H1);
  });

  it("A-43 save first (key still waiting): passes but doesn't complete; revealing the key then completes the link", async () => {
    const m = await mock([200]);
    const { app, owner, token, link, bot } = await fixture();
    const { csrf } = await open(owner, token);
    const rows = await newAudits(async () => {
      const r = await save(owner, token, csrf, m.url);
      expect(r.status).toBe(200);
      const t = plain(r.html);
      expect(t).toContain(PASS);
      expect(t).not.toContain("You're connected.");
      expect(t).toContain("A doorbell is saved (127.0.0.1/…/abc123).");
      expect(t).toContain("Send test doorbell");
      expect(t).toContain("Reveal my API key");
    });
    expect(actions(rows)).toEqual(["BOT_DOORBELL_SET", "BOT_DOORBELL_TESTED"]);
    expect((await prisma.bot.findUnique({ where: { id: bot.id } }))!.doorbellState).toBe("OK");
    expect((await prisma.setupLink.findUnique({ where: { id: link.id } }))!.usedAt).toBeNull();
    expect((await owner.get(`/setup/${token}`)).status).toBe(200);

    let key = "";
    const rows2 = await newAudits(async () => {
      const r = await owner.post(`/setup/${token}/reveal-key`, {}, { csrf });
      expect(r.status).toBe(200);
      key = KEY_RE.exec(r.html)![0];
      expect(plain(r.html)).toContain(DONE("Justin Bot"));
    });
    expect(actions(rows2)).toEqual(["SETUP_LINK_COMPLETED", "SETUP_LINK_KEY_REVEALED"]);
    one(rows2, "SETUP_LINK_COMPLETED", ["botId"]);
    one(rows2, "SETUP_LINK_KEY_REVEALED", ["botId"]);
    expect((await prisma.setupLink.findUnique({ where: { id: link.id } }))!.usedAt).not.toBeNull();
    expect((await owner.get(`/setup/${token}`)).status).toBe(404);
    await new McpTestClient(app, key).ok("whoami");
  });

  it("a link that carries no key completes as soon as the doorbell test passes", async () => {
    const m = await mock([200]);
    const { owner, token, link } = await fixture({ includeNewKey: false });
    const { csrf } = await open(owner, token);
    const r = await save(owner, token, csrf, m.url);
    expect(plain(r.html)).toContain(DONE("Justin Bot"));
    expect((await prisma.setupLink.findUnique({ where: { id: link.id } }))!.usedAt).not.toBeNull();
  });

  it("A-44 401 → exact rejected-key banner, BROKEN, link still usable; bad sender key message; 11th save → too many attempts", async () => {
    const m = await mock([401]);
    const { owner, token, link, bot } = await fixture({ includeNewKey: false });
    const { csrf } = await open(owner, token);
    const rows = await newAudits(async () => {
      const r = await save(owner, token, csrf, m.url);
      expect(r.status).toBe(200);
      expect(plain(r.html)).toContain(REJECTED);
      expect(plain(r.html)).not.toContain("You're connected.");
    });
    expect(actions(rows)).toEqual(["BOT_DOORBELL_SET", "BOT_DOORBELL_TESTED"]);
    const tested = one(rows, "BOT_DOORBELL_TESTED", ["ok", "statusCode", "error"]);
    expect(tested.metadata).toEqual({ ok: false, statusCode: 401, error: "HTTP 401 (sender key rejected)" });
    const b = (await prisma.bot.findUnique({ where: { id: bot.id } }))!;
    expect(b.doorbellState).toBe("BROKEN");
    expect(b.lastDoorbellError).toBe("HTTP 401 (sender key rejected)");
    expect((await prisma.setupLink.findUnique({ where: { id: link.id } }))!.usedAt).toBeNull();
    expect((await owner.get(`/setup/${token}`)).status).toBe(200);

    // Bad sender keys (saves 2..10) — each counts as an attempt, nothing is saved or sent.
    const badKeys = ["", "   ", "short", "has space inside", "tab\tinside1", "x".repeat(501), "1234567", " a b c d e ", "new\nline12"];
    for (const k of badKeys) {
      const r = await save(owner, token, csrf, m.url, k);
      expect(r.status, JSON.stringify(k)).toBe(400);
      expect(plain(r.html)).toContain(BAD_SENDER);
    }
    expect(m.requests).toHaveLength(1);
    expect((await prisma.setupLink.findUnique({ where: { id: link.id } }))!.saveAttempts).toBe(10);

    // 11th save, even a good one, is refused without touching the webhook.
    m.setScript([200]);
    const rows2 = await newAudits(async () => {
      const r = await save(owner, token, csrf, m.url);
      expect(plain(r.html)).toContain(TOO_MANY_SAVES);
      expect(plain(r.html)).not.toContain(PASS);
    });
    expect(rows2).toHaveLength(0);
    expect(m.requests).toHaveLength(1);
    expect((await prisma.bot.findUnique({ where: { id: bot.id } }))!.doorbellState).toBe("BROKEN");
  });

  it("failure banners: 404/410 and 5xx; invalid URL rejected before saving", async () => {
    const m = await mock([404]);
    const { owner, token, bot } = await fixture();
    const { csrf } = await open(owner, token);
    expect(plain((await save(owner, token, csrf, m.url)).html)).toContain(NOT_FOUND);
    m.setScript([410]);
    expect(plain((await save(owner, token, csrf, m.url)).html)).toContain(NOT_FOUND);
    m.setScript([503]);
    const r = await save(owner, token, csrf, m.url);
    expect(plain(r.html)).toContain(SERVER_ERR(503));
    expect((await prisma.bot.findUnique({ where: { id: bot.id } }))!.lastDoorbellError).toBe("HTTP 503");
    m.setScript([302]);
    expect(plain((await save(owner, token, csrf, m.url)).html)).toContain(
      "Doorbell test failed: redirect not allowed (HTTP 302).",
    );

    const before = await prisma.bot.findUnique({ where: { id: bot.id } });
    const bad = await save(owner, token, csrf, "http://example.com/automations/webhook/zzz");
    expect(bad.status).toBe(400);
    expect(bad.html).not.toContain("example.com/automations");
    const after = await prisma.bot.findUnique({ where: { id: bot.id } });
    expect(after!.webhookUrl).toBe(before!.webhookUrl);
    expect(m.requests).toHaveLength(4);
  });

  it("re-test: needs a saved doorbell; same pass/fail handling; 6th test in 10 minutes → rate limited", async () => {
    setNow(Date.now());
    const m = await mock([500]);
    const { owner, token, link, bot } = await fixture(); // key waiting → never completes here
    const { csrf } = await open(owner, token);
    const none = await owner.post(`/setup/${token}/test`, {}, { csrf });
    expect(none.status).toBe(400);
    expect(plain(none.html)).toContain("Save a doorbell first.");

    await save(owner, token, csrf, m.url);
    expect(m.requests).toHaveLength(1);
    m.setScript([200]);
    const rows = await newAudits(async () => {
      const r = await owner.post(`/setup/${token}/test`, {}, { csrf });
      expect(plain(r.html)).toContain(PASS);
    });
    expect(actions(rows)).toEqual(["BOT_DOORBELL_TESTED"]);
    expect(one(rows, "BOT_DOORBELL_TESTED", ["ok", "statusCode"]).actorId).toBe(link.id);
    expect((await prisma.bot.findUnique({ where: { id: bot.id } }))!.doorbellState).toBe("OK");

    m.setScript([401]);
    expect(plain((await owner.post(`/setup/${token}/test`, {}, { csrf })).html)).toContain(REJECTED);
    expect((await prisma.bot.findUnique({ where: { id: bot.id } }))!.doorbellState).toBe("BROKEN");
    m.setScript([200]);
    for (let i = 0; i < 3; i++) await owner.post(`/setup/${token}/test`, {}, { csrf });
    expect(m.requests).toHaveLength(6); // 1 save + 5 tests

    const rows2 = await newAudits(async () => {
      const r = await owner.post(`/setup/${token}/test`, {}, { csrf });
      expect(plain(r.html)).toContain(TOO_MANY_TESTS);
    });
    expect(rows2).toHaveLength(0);
    expect(m.requests).toHaveLength(6);

    advance(10 * 60_000 + 1000);
    const ok = await owner.post(`/setup/${token}/test`, {}, { csrf });
    expect(plain(ok.html)).toContain(PASS);
    expect(m.requests).toHaveLength(7);
  });

  it("A-45 the sender key and full webhook URL never appear in any HTML after save (only host + /…/ + last 6)", async () => {
    const m = await mock([500]);
    const { owner, token } = await fixture();
    const pages: Resp[] = [];
    const { csrf, ...first } = await open(owner, token);
    pages.push(first);
    pages.push(await save(owner, token, csrf, m.url));
    pages.push(await owner.get(`/setup/${token}`));
    pages.push(await owner.post(`/setup/${token}/test`, {}, { csrf }));
    pages.push(await save(owner, token, csrf, m.url, "bad key with spaces")); // error re-render
    pages.push(await save(owner, token, csrf, "http://example.com/automations/webhook/routine-abc123", SENDER_KEY));
    m.setScript([200]);
    pages.push(await owner.post(`/setup/${token}/test`, {}, { csrf }));
    pages.push(await owner.post(`/setup/${token}/reveal-key`, {}, { csrf })); // completes
    pages.push(await owner.get(`/setup/${token}`));
    const withoutScheme = m.url.replace("http://", "");
    for (const [i, p] of pages.entries()) {
      for (const h of [p.html, p.text]) {
        expect(h, `page ${i}`).not.toContain(SENDER_KEY);
        expect(h, `page ${i}`).not.toContain(withoutScheme);
        expect(h, `page ${i}`).not.toContain("automations/webhook");
        expect(h, `page ${i}`).not.toContain("routine-abc123");
      }
    }
    expect(pages[2]!.text).toContain("127.0.0.1/…/abc123");
  });
});
