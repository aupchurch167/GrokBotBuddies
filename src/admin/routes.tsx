import argon2 from "argon2";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { config } from "../config.js";
import { prisma } from "../db.js";
import type { Bot } from "../generated/prisma/client.js";
import { serverErrorResponse } from "../http/errorPages.js";
import { Page } from "../http/Page.js";
import { noStore } from "../http/securityHeaders.js";
import { clientIp } from "../lib/clientIp.js";
import { safeEqualStr } from "../lib/crypto.js";
import { BOT_ID_RE, nameKey } from "../lib/ids.js";
import { limiters } from "../lib/rateLimit.js";
import { utcMonth } from "../lib/time.js";
import { audit } from "../services/audit.js";
import { cancelPendingDoorbells, createBot, disableBot, DuplicateNameError, enableBot, isUniqueViolation, rotateKey } from "../services/bots.js";
import { approveConnection, revokeConnection } from "../services/connections.js";
import { testDoorbell } from "../services/doorbellTest.js";
import { createSetupLink, revokeSetupLink } from "../services/setupLinks.js";
import type { AppEnv } from "../types.js";
import { CSRF_FAILED_TEXT, csrfMatches, loginCsrf, newLoginNonce } from "./csrf.js";
import { createSession, destroySession, loadSession, requireAdmin } from "./session.js";
import { Audit } from "./views/Audit.js";
import { BotDetail } from "./views/BotDetail.js";
import { BotNew, type BotFormValues } from "./views/BotNew.js";
import { Bots } from "./views/Bots.js";
import { Connections } from "./views/Connections.js";
import { Doorbells } from "./views/Doorbells.js";
import { Login } from "./views/Login.js";
import { Messages, type MessageRow } from "./views/Messages.js";
import { MessageView } from "./views/MessageView.js";
import { SecretOnce } from "./views/SecretOnce.js";
import { Usage } from "./views/Usage.js";

type C = Context<AppEnv>;
type Form = Record<string, string>;
type Flash = { kind: "ok" | "bad" | "warn"; text: string };

export const LOGIN_FAILED_TEXT = "Wrong email or password.";
export const LOGIN_LOCKED_TEXT = "Too many login attempts. Wait 15 minutes and try again.";
export const TOO_MANY_TESTS_TEXT = "Too many tests. Wait 10 minutes and try again.";
const LOGIN_NONCE = "bb_login_nonce";
const PAGE_SIZE = 50;

/** Fixed flash messages, chosen by code (never reflected from the query string). */
const FLASH: Record<string, Flash> = {
  created: { kind: "ok", text: "Bot created." },
  updated: { kind: "ok", text: "Changes saved." },
  disabled: { kind: "ok", text: "Bot disabled. Its key stops working on the next request." },
  enabled: { kind: "ok", text: "Bot enabled." },
  cleared: { kind: "ok", text: "Doorbell cleared." },
  link_revoked: { kind: "ok", text: "Setup link revoked." },
  approved: { kind: "ok", text: "Connection approved." },
  reactivated: { kind: "ok", text: "Connection reactivated." },
  already_active: { kind: "warn", text: "That connection is already active." },
  revoked: { kind: "ok", text: "Connection revoked." },
  retried: { kind: "ok", text: "Doorbell requeued." },
  already_queued: { kind: "warn", text: "A doorbell is already queued for this bot." },
  confirm: { kind: "bad", text: "Tick the confirmation box first." },
  retention: { kind: "ok", text: "Retention purge finished." },
};

const flashFrom = (c: C): Flash | null => FLASH[c.req.query("ok") ?? ""] ?? null;

async function readForm(c: C): Promise<Form> {
  const body = await c.req.parseBody();
  const out: Form = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

const forbidden = (c: C) =>
  c.html(
    <Page title="Forbidden · Bot Bridge">
      <h1>Forbidden</h1>
      <p>{CSRF_FAILED_TEXT}</p>
    </Page>,
    403,
  );

const notFoundPage = (c: C) =>
  c.html(
    <Page title="Not found · Bot Bridge">
      <h1>Not found</h1>
      <p>That page doesn't exist.</p>
    </Page>,
    404,
  );

function pageNum(c: C): number {
  const n = Number(c.req.query("page") ?? "1");
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

function intField(raw: string | undefined, def: number, min: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

interface ParsedBot {
  name: string;
  ownerName: string;
  ownerEmail: string | null;
  notes: string | null;
  sendLimitPerHour: number;
  mcpCallLimitPerHour: number;
}

function validateBotForm(f: Form): { errors: string[]; value: ParsedBot } {
  const errors: string[] = [];
  const name = (f["name"] ?? "").trim().replace(/\s+/g, " ");
  const ownerName = (f["ownerName"] ?? "").trim();
  const ownerEmail = (f["ownerEmail"] ?? "").trim();
  const notes = (f["notes"] ?? "").trim();
  if (!name) errors.push("Name is required.");
  else if ([...name].length > 60) errors.push("Name can be at most 60 characters.");
  else if (name.toLowerCase().startsWith("bot_")) errors.push("Name can't start with bot_.");
  if (!ownerName) errors.push("Owner name is required.");
  else if ([...ownerName].length > 80) errors.push("Owner name can be at most 80 characters.");
  if (ownerEmail && (ownerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)))
    errors.push("Owner email doesn't look like a valid email address.");
  if ([...notes].length > 1000) errors.push("Notes can be at most 1000 characters.");
  const send = intField(f["sendLimitPerHour"], 60, 1, 10000);
  if (send === null) errors.push("Send limit must be a whole number from 1 to 10000.");
  const mcp = intField(f["mcpCallLimitPerHour"], 600, 1, 100000);
  if (mcp === null) errors.push("Tool call limit must be a whole number from 1 to 100000.");
  return {
    errors,
    value: {
      name,
      ownerName,
      ownerEmail: ownerEmail || null,
      notes: notes || null,
      sendLimitPerHour: send ?? 60,
      mcpCallLimitPerHour: mcp ?? 600,
    },
  };
}

const formValues = (f: Form): BotFormValues => ({
  name: f["name"],
  ownerName: f["ownerName"],
  ownerEmail: f["ownerEmail"],
  notes: f["notes"],
  sendLimitPerHour: f["sendLimitPerHour"],
  mcpCallLimitPerHour: f["mcpCallLimitPerHour"],
  deliverVia: f["deliverVia"],
});

async function renderBotDetail(c: C, bot: Bot, extra: { flash?: Flash | null; errors?: string[]; values?: BotFormValues } = {}, status: 200 | 400 = 200) {
  const [conns, links, jobs, usage, audits] = await Promise.all([
    prisma.connection.findMany({
      where: { OR: [{ botAId: bot.id }, { botBId: bot.id }] },
      include: { botA: true, botB: true },
      orderBy: { approvedAt: "desc" },
    }),
    prisma.setupLink.findMany({ where: { botId: bot.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.doorbellJob.findMany({ where: { botId: bot.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.usageCounter.findMany({ where: { botId: bot.id }, orderBy: { month: "desc" }, take: 6 }),
    prisma.auditLog.findMany({
      where: { OR: [{ targetId: bot.id }, { metadata: { path: ["botId"], equals: bot.id } }] },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  return c.html(
    <BotDetail
      csrf={c.get("adminSession").csrfToken}
      bot={bot}
      connections={conns.map((x) => ({ ...x, other: x.botAId === bot.id ? x.botB : x.botA }))}
      links={links}
      jobs={jobs}
      usage={usage}
      audits={audits}
      flash={extra.flash ?? flashFrom(c)}
      errors={extra.errors}
      values={extra.values}
    />,
    status,
  );
}

async function loadBot(id: string): Promise<Bot | null> {
  return BOT_ID_RE.test(id) ? prisma.bot.findUnique({ where: { id } }) : null;
}

export interface AdminOptions {
  /** Retention runner for "Run retention now" (wired in phase 5). */
  runRetention?: (actor: { type: "ADMIN"; ip: string | null }) => Promise<unknown>;
}

export function registerAdmin(app: Hono<AppEnv>, opts: AdminOptions = {}): void {
  const origin = new URL(config.PUBLIC_BASE_URL).origin;
  app.use("/admin", noStore);
  app.use("/admin/*", noStore);
  app.use("/admin/*", csrf({ origin }));
  app.use(
    "/admin/*",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => serverErrorResponse(c as C, 413, "Request too large.") }),
  );

  // ---- login / logout ----
  app.get("/admin/login", async (c) => {
    if (await loadSession(c)) return c.redirect("/admin/bots", 302);
    const nonce = newLoginNonce();
    setCookie(c, LOGIN_NONCE, nonce, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/admin/login",
      secure: config.PUBLIC_BASE_URL.startsWith("https://"),
    });
    return c.html(<Login csrf={loginCsrf(nonce)} />);
  });

  app.post("/admin/login", async (c) => {
    const ip = clientIp(c);
    if (limiters.adminLoginIp.isBlocked(ip) || limiters.adminLoginGlobal.isBlocked("global")) {
      return c.html(
        <Page title="Too many attempts · Bot Bridge">
          <h1>Too many attempts</h1>
          <p>{LOGIN_LOCKED_TEXT}</p>
        </Page>,
        429,
      );
    }
    const f = await readForm(c);
    const nonce = getCookie(c, LOGIN_NONCE);
    if (!nonce || !csrfMatches(loginCsrf(nonce), f["_csrf"])) return forbidden(c);
    const email = (f["email"] ?? "").trim().toLowerCase();
    const password = f["password"] ?? "";
    const emailMatched = safeEqualStr(email, config.ADMIN_EMAIL.trim().toLowerCase());
    let pwOk = false;
    try {
      pwOk = await argon2.verify(config.ADMIN_PASSWORD_HASH, password); // always runs (timing)
    } catch {
      pwOk = false;
    }
    if (!emailMatched || !pwOk) {
      limiters.adminLoginIp.fail(ip);
      limiters.adminLoginGlobal.fail("global");
      await audit({ actorType: "ADMIN", actorId: null, action: "ADMIN_LOGIN_FAILED", ip, metadata: { emailMatched } });
      return c.html(<Login csrf={loginCsrf(nonce)} email={f["email"] ?? ""} error={LOGIN_FAILED_TEXT} />, 401);
    }
    limiters.adminLoginIp.reset(ip);
    await createSession(c, ip);
    await audit({ actorType: "ADMIN", actorId: "admin", action: "ADMIN_LOGIN", ip });
    return c.redirect("/admin/bots", 302);
  });

  // Everything else needs a session; POSTs also need the session's CSRF token.
  const guard = async (c: C, next: () => Promise<void>) => {
    if (c.req.path === "/admin/login") return next();
    return requireAdmin(c, async () => {
      if (c.req.method === "POST") {
        const f = await readForm(c);
        if (!csrfMatches(c.get("adminSession").csrfToken, f["_csrf"])) {
          c.res = await forbidden(c);
          return;
        }
      }
      await next();
    });
  };
  app.use("/admin", guard);
  app.use("/admin/*", guard);

  app.post("/admin/logout", async (c) => {
    const s = c.get("adminSession");
    await destroySession(c, s);
    await audit({ actorType: "ADMIN", actorId: "admin", action: "ADMIN_LOGOUT", ip: clientIp(c) });
    return c.redirect("/admin/login", 302);
  });

  app.get("/admin", (c) => c.redirect("/admin/bots", 302));

  // ---- bots ----
  app.get("/admin/bots", async (c) => {
    const status = ["active", "disabled", "all"].includes(c.req.query("status") ?? "") ? c.req.query("status")! : "all";
    const bots = await prisma.bot.findMany({
      where: status === "all" ? {} : { status: status === "active" ? "ACTIVE" : "DISABLED" },
      orderBy: { nameKey: "asc" },
    });
    const usage = await prisma.usageCounter.findMany({ where: { month: utcMonth(), botId: { in: bots.map((b) => b.id) } } });
    return c.html(
      <Bots csrf={c.get("adminSession").csrfToken} bots={bots} usage={new Map(usage.map((u) => [u.botId, u]))} status={status} flash={flashFrom(c)} />,
    );
  });

  app.get("/admin/bots/new", (c) => c.html(<BotNew csrf={c.get("adminSession").csrfToken} />));

  app.post("/admin/bots", async (c) => {
    const f = await readForm(c);
    const ip = clientIp(c);
    const csrfToken = c.get("adminSession").csrfToken;
    const { errors, value } = validateBotForm(f);
    const deliverVia = f["deliverVia"] === "show_now" ? "show_now" : "setup_link";
    if (errors.length) return c.html(<BotNew csrf={csrfToken} values={formValues(f)} errors={errors} />, 400);
    let created: { bot: Bot; key: string };
    try {
      created = await createBot(value);
    } catch (e) {
      if (e instanceof DuplicateNameError)
        return c.html(<BotNew csrf={csrfToken} values={formValues(f)} errors={[e.message]} />, 400);
      throw e;
    }
    const { bot, key } = created;
    await audit({
      actorType: "ADMIN",
      actorId: "admin",
      action: "BOT_CREATED",
      targetType: "bot",
      targetId: bot.id,
      ip,
      metadata: { name: bot.name, ownerName: bot.ownerName, deliverVia },
    });
    if (deliverVia === "show_now") {
      return c.html(
        <SecretOnce
          csrf={csrfToken}
          title="Bot created: API key"
          label="API key"
          value={key}
          botId={bot.id}
          botName={bot.name}
          mcpUrl={`${config.PUBLIC_BASE_URL}/mcp`}
        />,
      );
    }
    const link = await createSetupLink(bot.id, { includeNewKey: false, existingKey: key, actorIp: ip });
    return c.html(
      <SecretOnce
        csrf={csrfToken}
        title="Bot created: setup link"
        label="Setup link"
        value={link.url}
        botId={bot.id}
        botName={bot.name}
        note="Send this link to the bot's owner along with docs/CONNECT_A_BOT.md. The API key travels only inside the link."
      />,
    );
  });

  app.get("/admin/bots/:id", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    return renderBotDetail(c, bot);
  });

  app.post("/admin/bots/:id/edit", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    const f = await readForm(c);
    const { errors, value } = validateBotForm(f);
    if (!errors.length && nameKey(value.name) !== bot.nameKey) {
      const other = await prisma.bot.findUnique({ where: { nameKey: nameKey(value.name) } });
      if (other) errors.push(`A bot named '${value.name}' already exists.`);
    }
    if (errors.length) return renderBotDetail(c, bot, { errors, values: formValues(f) }, 400);
    const changed: string[] = [];
    const cmp: [keyof ParsedBot, unknown][] = [
      ["name", bot.name],
      ["ownerName", bot.ownerName],
      ["ownerEmail", bot.ownerEmail],
      ["notes", bot.notes],
      ["sendLimitPerHour", bot.sendLimitPerHour],
      ["mcpCallLimitPerHour", bot.mcpCallLimitPerHour],
    ];
    for (const [k, old] of cmp) if (value[k] !== old) changed.push(k);
    if (changed.length) {
      try {
        await prisma.bot.update({ where: { id: bot.id }, data: { ...value, nameKey: nameKey(value.name) } });
      } catch (e) {
        if (isUniqueViolation(e, "nameKey"))
          return renderBotDetail(c, bot, { errors: [`A bot named '${value.name}' already exists.`], values: formValues(f) }, 400);
        throw e;
      }
      const limitsChanged = changed.includes("sendLimitPerHour") || changed.includes("mcpCallLimitPerHour");
      await audit({
        actorType: "ADMIN",
        actorId: "admin",
        action: "BOT_UPDATED",
        targetType: "bot",
        targetId: bot.id,
        ip: clientIp(c),
        metadata: {
          changed,
          ...(limitsChanged
            ? {
                limits: {
                  old: { sendLimitPerHour: bot.sendLimitPerHour, mcpCallLimitPerHour: bot.mcpCallLimitPerHour },
                  new: { sendLimitPerHour: value.sendLimitPerHour, mcpCallLimitPerHour: value.mcpCallLimitPerHour },
                },
              }
            : {}),
        },
      });
    }
    return c.redirect(`/admin/bots/${bot.id}?ok=updated`, 302);
  });

  app.post("/admin/bots/:id/disable", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    await prisma.$transaction(async (tx) => {
      await disableBot(bot.id, tx);
      await audit({ actorType: "ADMIN", actorId: "admin", action: "BOT_DISABLED", targetType: "bot", targetId: bot.id, ip: clientIp(c), metadata: {} }, tx);
    });
    return c.redirect(`/admin/bots/${bot.id}?ok=disabled`, 302);
  });

  app.post("/admin/bots/:id/enable", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    await enableBot(bot.id);
    await audit({ actorType: "ADMIN", actorId: "admin", action: "BOT_ENABLED", targetType: "bot", targetId: bot.id, ip: clientIp(c), metadata: {} });
    return c.redirect(`/admin/bots/${bot.id}?ok=enabled`, 302);
  });

  app.post("/admin/bots/:id/rotate-key", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    const f = await readForm(c);
    if (!f["confirm"]) return c.redirect(`/admin/bots/${bot.id}?ok=confirm`, 302);
    const r = await rotateKey(bot.id);
    await audit({
      actorType: "ADMIN",
      actorId: "admin",
      action: "BOT_KEY_ROTATED",
      targetType: "bot",
      targetId: bot.id,
      ip: clientIp(c),
      metadata: { newPrefix: r.bot.apiKeyPrefix, via: "rotate" },
    });
    return c.html(
      <SecretOnce
        csrf={c.get("adminSession").csrfToken}
        title="New API key"
        label="API key"
        value={r.key}
        botId={bot.id}
        botName={bot.name}
        mcpUrl={`${config.PUBLIC_BASE_URL}/mcp`}
        note="The previous key has stopped working."
      />,
    );
  });

  app.post("/admin/bots/:id/setup-links", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    const f = await readForm(c);
    const ttl = intField(f["ttlHours"], config.SETUP_LINK_TTL_HOURS, 1, 168);
    if (ttl === null) return renderBotDetail(c, bot, { errors: ["Expiry must be a whole number of hours from 1 to 168."] }, 400);
    const link = await createSetupLink(bot.id, { includeNewKey: !!f["includeNewKey"], ttlHours: ttl, actorIp: clientIp(c) });
    return c.html(
      <SecretOnce
        csrf={c.get("adminSession").csrfToken}
        title="New setup link"
        label="Setup link"
        value={link.url}
        botId={bot.id}
        botName={bot.name}
        note={
          f["includeNewKey"]
            ? "This link carries a new API key. The bot's previous key has stopped working."
            : "This link carries no key. The owner keeps their current key."
        }
      />,
    );
  });

  app.post("/admin/setup-links/:linkId/revoke", async (c) => {
    const linkId = c.req.param("linkId");
    const link = /^sl_[0-9A-Za-z]{20}$/.test(linkId) ? await revokeSetupLink(linkId, clientIp(c)) : null;
    if (!link) return notFoundPage(c);
    return c.redirect(`/admin/bots/${link.botId}?ok=link_revoked`, 302);
  });

  app.post("/admin/bots/:id/doorbell/test", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    if (limiters.adminTest.isBlocked(bot.id)) return renderBotDetail(c, bot, { flash: { kind: "bad", text: TOO_MANY_TESTS_TEXT } });
    limiters.adminTest.hit(bot.id);
    const r = await testDoorbell(bot.id);
    await audit({
      actorType: "ADMIN",
      actorId: "admin",
      action: "BOT_DOORBELL_TESTED",
      targetType: "bot",
      targetId: bot.id,
      ip: clientIp(c),
      metadata: { ok: r.ok, statusCode: r.statusCode, ...(r.ok ? {} : { error: r.summary }) },
    });
    const fresh = (await loadBot(bot.id))!;
    return renderBotDetail(c, fresh, { flash: { kind: r.ok ? "ok" : "bad", text: r.banner } });
  });

  app.post("/admin/bots/:id/doorbell/clear", async (c) => {
    const bot = await loadBot(c.req.param("id"));
    if (!bot) return notFoundPage(c);
    const f = await readForm(c);
    if (!f["confirm"]) return c.redirect(`/admin/bots/${bot.id}?ok=confirm`, 302);
    await prisma.$transaction(async (tx) => {
      await tx.bot.update({
        where: { id: bot.id },
        data: { webhookUrl: null, webhookKeyEnc: null, doorbellState: "NONE", lastDoorbellError: null, doorbellUpdatedAt: new Date() },
      });
      await cancelPendingDoorbells(bot.id, "doorbell cleared", tx);
      await audit({ actorType: "ADMIN", actorId: "admin", action: "BOT_DOORBELL_CLEARED", targetType: "bot", targetId: bot.id, ip: clientIp(c), metadata: {} }, tx);
    });
    return c.redirect(`/admin/bots/${bot.id}?ok=cleared`, 302);
  });

  // ---- connections ----
  async function renderConnections(c: C, extra: { errors?: string[]; values?: Form } = {}, status: 200 | 400 = 200) {
    const q = c.req.query("status") ?? "all";
    const st = ["active", "revoked", "all"].includes(q) ? q : "all";
    const [bots, rows] = await Promise.all([
      prisma.bot.findMany({ orderBy: { nameKey: "asc" } }),
      prisma.connection.findMany({
        where: st === "all" ? {} : { status: st === "active" ? "ACTIVE" : "REVOKED" },
        include: { botA: true, botB: true, _count: { select: { messages: true } } },
        orderBy: { approvedAt: "desc" },
      }),
    ]);
    return c.html(
      <Connections
        csrf={c.get("adminSession").csrfToken}
        bots={bots}
        rows={rows.map((r) => ({ ...r, messageCount: r._count.messages }))}
        status={st}
        errors={extra.errors}
        values={extra.values}
        flash={flashFrom(c)}
      />,
      status,
    );
  }

  app.get("/admin/connections", (c) => renderConnections(c));

  app.post("/admin/connections", async (c) => {
    const f = await readForm(c);
    const x = (f["botX"] ?? "").trim();
    const y = (f["botY"] ?? "").trim();
    const note = (f["note"] ?? "").trim();
    const errors: string[] = [];
    const [bx, by] = await Promise.all([loadBot(x), loadBot(y)]);
    if (!bx || !by || x === y) errors.push("Pick two different bots.");
    if ([...note].length > 500) errors.push("Note can be at most 500 characters.");
    if (errors.length) return renderConnections(c, { errors, values: f }, 400);
    const r = await approveConnection(x, y, note || null);
    if (r.alreadyActive) return c.redirect("/admin/connections?ok=already_active", 302);
    await audit({
      actorType: "ADMIN",
      actorId: "admin",
      action: r.reactivated ? "CONNECTION_REACTIVATED" : "CONNECTION_APPROVED",
      targetType: "connection",
      targetId: r.connection.id,
      ip: clientIp(c),
      metadata: { botAId: r.connection.botAId, botBId: r.connection.botBId },
    });
    return c.redirect(`/admin/connections?ok=${r.reactivated ? "reactivated" : "approved"}`, 302);
  });

  app.post("/admin/connections/:id/revoke", async (c) => {
    const id = c.req.param("id");
    const conn = /^con_[0-9A-Za-z]{20}$/.test(id) ? await prisma.connection.findUnique({ where: { id } }) : null;
    if (!conn) return notFoundPage(c);
    const f = await readForm(c);
    if (!f["confirm"]) return c.redirect("/admin/connections?ok=confirm", 302);
    if (conn.status === "ACTIVE") {
      await revokeConnection(conn.id);
      await audit({
        actorType: "ADMIN",
        actorId: "admin",
        action: "CONNECTION_REVOKED",
        targetType: "connection",
        targetId: conn.id,
        ip: clientIp(c),
        metadata: { botAId: conn.botAId, botBId: conn.botBId },
      });
    }
    return c.redirect("/admin/connections?ok=revoked", 302);
  });

  // ---- messages (metadata only in the list) ----
  app.get("/admin/messages", async (c) => {
    const page = pageNum(c);
    const bot = c.req.query("bot") ?? "";
    const connection = c.req.query("connection") ?? "";
    const where = {
      ...(BOT_ID_RE.test(bot) ? { OR: [{ fromBotId: bot }, { toBotId: bot }] } : {}),
      ...(/^con_[0-9A-Za-z]{20}$/.test(connection) ? { connectionId: connection } : {}),
    };
    const rows = await prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        createdAt: true,
        subject: true,
        threadId: true,
        deliveredAt: true,
        readAt: true,
        fromBot: { select: { name: true } },
        toBot: { select: { name: true } },
      },
    });
    const ids = rows.slice(0, PAGE_SIZE).map((r) => r.id);
    const lengths = ids.length
      ? await prisma.$queryRaw<{ id: string; n: number }[]>`
          SELECT id, char_length(body)::int AS n FROM "Message" WHERE id = ANY(${ids}::text[])`
      : [];
    const lenMap = new Map(lengths.map((l) => [l.id, l.n]));
    const out: MessageRow[] = rows.slice(0, PAGE_SIZE).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      fromName: r.fromBot.name,
      toName: r.toBot.name,
      subject: r.subject,
      bodyLength: lenMap.get(r.id) ?? 0,
      threadId: r.threadId,
      deliveredAt: r.deliveredAt,
      readAt: r.readAt,
    }));
    const params = new URLSearchParams();
    if (BOT_ID_RE.test(bot)) params.set("bot", bot);
    if (/^con_[0-9A-Za-z]{20}$/.test(connection)) params.set("connection", connection);
    const qs = params.toString();
    return c.html(
      <Messages
        csrf={c.get("adminSession").csrfToken}
        rows={out}
        page={page}
        hasNext={rows.length > PAGE_SIZE}
        base={`/admin/messages${qs ? `?${qs}` : ""}`}
        filter={qs}
      />,
    );
  });

  app.get("/admin/messages/:id", async (c) => {
    const id = c.req.param("id");
    const m = /^msg_[0-9A-Za-z]{20}$/.test(id)
      ? await prisma.message.findUnique({ where: { id }, include: { fromBot: true, toBot: true } })
      : null;
    if (!m) return notFoundPage(c);
    await audit({
      actorType: "ADMIN",
      actorId: "admin",
      action: "MESSAGE_VIEWED",
      targetType: "message",
      targetId: m.id,
      ip: clientIp(c),
      metadata: { connectionId: m.connectionId },
    });
    const thread = await prisma.message.findMany({
      where: { threadId: m.threadId, connectionId: m.connectionId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      select: { id: true, createdAt: true, fromBot: { select: { name: true } } },
    });
    return c.html(
      <MessageView
        csrf={c.get("adminSession").csrfToken}
        m={m}
        fromName={m.fromBot.name}
        toName={m.toBot.name}
        thread={thread.map((t) => ({ id: t.id, createdAt: t.createdAt, fromName: t.fromBot.name }))}
      />,
    );
  });

  // ---- doorbells ----
  app.get("/admin/doorbells", async (c) => {
    const page = pageNum(c);
    const status = c.req.query("status") ?? "";
    const bot = c.req.query("bot") ?? "";
    const STATUSES = ["PENDING", "SENDING", "RETRYING", "SENT", "FAILED", "CANCELLED"] as const;
    const st = (STATUSES as readonly string[]).includes(status) ? (status as (typeof STATUSES)[number]) : null;
    const where = { ...(st ? { status: st } : {}), ...(BOT_ID_RE.test(bot) ? { botId: bot } : {}) };
    const [rows, grouped] = await Promise.all([
      prisma.doorbellJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE + 1,
        include: { bot: { select: { name: true } } },
      }),
      prisma.doorbellJob.groupBy({
        by: ["status"],
        where: { createdAt: { gt: new Date(Date.now() - 86_400_000) } },
        _count: { _all: true },
      }),
    ]);
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const params = new URLSearchParams();
    if (st) params.set("status", st);
    if (BOT_ID_RE.test(bot)) params.set("bot", bot);
    const qs = params.toString();
    return c.html(
      <Doorbells
        csrf={c.get("adminSession").csrfToken}
        counts={counts}
        rows={rows.slice(0, PAGE_SIZE).map((r) => ({ ...r, botName: r.bot.name }))}
        page={page}
        hasNext={rows.length > PAGE_SIZE}
        base={`/admin/doorbells${qs ? `?${qs}` : ""}`}
        flash={flashFrom(c)}
      />,
    );
  });

  app.post("/admin/doorbells/:id/retry", async (c) => {
    const id = c.req.param("id");
    const job = /^dbj_[0-9A-Za-z]{20}$/.test(id) ? await prisma.doorbellJob.findUnique({ where: { id } }) : null;
    if (!job) return notFoundPage(c);
    if (job.status !== "FAILED") return c.redirect("/admin/doorbells", 302);
    try {
      await prisma.doorbellJob.update({
        where: { id: job.id },
        data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), coalesceKey: job.botId, claimedAt: null },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return c.redirect("/admin/doorbells?ok=already_queued", 302);
      throw e;
    }
    await audit({
      actorType: "ADMIN",
      actorId: "admin",
      action: "DOORBELL_JOB_RETRIED",
      targetType: "doorbell_job",
      targetId: job.id,
      ip: clientIp(c),
      metadata: { botId: job.botId },
    });
    return c.redirect("/admin/doorbells?ok=retried", 302);
  });

  // ---- usage ----
  app.get("/admin/usage", async (c) => {
    const q = c.req.query("month") ?? "";
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : utcMonth();
    const [bots, counters] = await Promise.all([
      prisma.bot.findMany({ orderBy: { nameKey: "asc" } }),
      prisma.usageCounter.findMany({ where: { month } }),
    ]);
    const byBot = new Map(counters.map((u) => [u.botId, u]));
    const rows = bots
      .filter((b) => byBot.has(b.id) || b.status === "ACTIVE")
      .map((b) => {
        const u = byBot.get(b.id);
        return {
          botId: b.id,
          name: b.name,
          messagesSent: u?.messagesSent ?? 0,
          messagesReceived: u?.messagesReceived ?? 0,
          mcpCalls: u?.mcpCalls ?? 0,
          doorbellsSent: u?.doorbellsSent ?? 0,
          doorbellsFailed: u?.doorbellsFailed ?? 0,
        };
      });
    return c.html(<Usage csrf={c.get("adminSession").csrfToken} month={month} rows={rows} />);
  });

  // ---- audit ----
  app.get("/admin/audit", async (c) => {
    const page = pageNum(c);
    const action = c.req.query("action") ?? "";
    const target = c.req.query("target") ?? "";
    const where = {
      ...(/^[A-Z_]{3,40}$/.test(action) ? { action: action as never } : {}),
      ...(/^[A-Za-z0-9_]{3,64}$/.test(target) ? { targetId: target } : {}),
    };
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    });
    const params = new URLSearchParams();
    if (where.action) params.set("action", action);
    if (where.targetId) params.set("target", target);
    const qs = params.toString();
    return c.html(
      <Audit
        csrf={c.get("adminSession").csrfToken}
        rows={rows.slice(0, PAGE_SIZE)}
        page={page}
        hasNext={rows.length > PAGE_SIZE}
        base={`/admin/audit${qs ? `?${qs}` : ""}`}
        flash={flashFrom(c)}
      />,
    );
  });

  // ---- maintenance ----
  app.post("/admin/maintenance/retention", async (c) => {
    const f = await readForm(c);
    if (!f["confirm"]) return c.redirect("/admin/audit?ok=confirm", 302);
    if (!opts.runRetention) return c.redirect("/admin/bots", 302);
    await opts.runRetention({ type: "ADMIN", ip: clientIp(c) });
    return c.redirect("/admin/audit?ok=retention", 302);
  });
}
