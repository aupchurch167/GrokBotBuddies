import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { checkWebhookUrl } from "../doorbell/ssrf.js";
import { serverErrorResponse } from "../http/errorPages.js";
import { Page } from "../http/Page.js";
import { clientIp } from "../lib/clientIp.js";
import { limiters } from "../lib/rateLimit.js";
import { formatET } from "../lib/time.js";
import { csrfMatches, setupCsrf, CSRF_FAILED_TEXT } from "../admin/csrf.js";
import { audit } from "../services/audit.js";
import { testDoorbell, type TestResult } from "../services/doorbellTest.js";
import {
  bumpSaveAttempts,
  loadValidLink,
  maskWebhook,
  maybeComplete,
  revealKey,
  saveDoorbell,
  type LinkWithBot,
} from "../services/setupLinks.js";
import type { AppEnv } from "../types.js";
import { KeyOnce } from "./views/KeyOnce.js";
import { SetupDone } from "./views/SetupDone.js";
import { SetupInvalid } from "./views/SetupInvalid.js";
import { SetupPage } from "./views/SetupPage.js";

type C = Context<AppEnv>;
type Banner = { kind: "ok" | "bad" | "warn"; text: string };

export const ALREADY_REVEALED_TEXT =
  "Your key was already shown. If you lost it, ask the bridge admin for a new setup link.";
export const TOO_MANY_SAVES_TEXT = "Too many attempts on this link. Ask the bridge admin for a new one.";
export const BAD_SENDER_KEY_TEXT =
  "Paste the sender key from your routine's panel. It can't be empty or contain spaces.";
export const TOO_MANY_TESTS_TEXT = "Too many tests. Wait 10 minutes and try again.";
export const TOO_MANY_TOKEN_HITS_TEXT = "Too many attempts. Wait 10 minutes and try again.";

const setupHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex");
};

async function invalid(c: C, ip: string) {
  limiters.setupTokenIp.hit(ip);
  return c.html(<SetupInvalid />, 404);
}

function tooMany(c: C) {
  return c.html(
    <Page title="Too many attempts · Bot Bridge">
      <h1>Too many attempts</h1>
      <p>{TOO_MANY_TOKEN_HITS_TEXT}</p>
    </Page>,
    429,
  );
}

/** Resolves the token to a valid link, or renders the shared invalid page. */
async function withLink(c: C, fn: (link: LinkWithBot, ip: string) => Promise<Response>): Promise<Response> {
  const ip = clientIp(c);
  if (limiters.setupTokenIp.isBlocked(ip)) return tooMany(c);
  const link = await loadValidLink(c.req.param("token") ?? "");
  if (!link) return invalid(c, ip);
  return fn(link, ip);
}

async function renderPage(c: C, token: string, link: LinkWithBot, extra: { banner?: Banner | null; errors?: string[] } = {}, status: 200 | 400 | 429 = 200) {
  const fresh = await prisma.setupLink.findUniqueOrThrow({ where: { id: link.id }, include: { bot: true } });
  return c.html(
    <SetupPage
      token={token}
      csrf={setupCsrf(link.id)}
      botName={fresh.bot.name}
      ownerName={fresh.bot.ownerName}
      expiresAtET={formatET(fresh.expiresAt)}
      mcpUrl={`${config.PUBLIC_BASE_URL}/mcp`}
      keyState={fresh.apiKeyEnc ? "waiting" : fresh.keyRevealedAt ? "revealed" : "none"}
      savedDoorbell={maskWebhook(fresh.bot.webhookUrl)}
      banner={extra.banner}
      errors={extra.errors}
    />,
    status,
  );
}

async function checkCsrf(c: C, link: LinkWithBot): Promise<Record<string, string> | null> {
  const body = await c.req.parseBody();
  const f: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") f[k] = v;
  return csrfMatches(setupCsrf(link.id), f["_csrf"]) ? f : null;
}

const forbidden = (c: C) =>
  c.html(
    <Page title="Forbidden · Bot Bridge">
      <h1>Forbidden</h1>
      <p>{CSRF_FAILED_TEXT}</p>
    </Page>,
    403,
  );

/** Runs a test doorbell, audits it, and completes the link when possible. */
async function runTest(c: C, token: string, link: LinkWithBot, ip: string): Promise<Response> {
  const r: TestResult = await testDoorbell(link.botId);
  await audit({
    actorType: "OWNER",
    actorId: link.id,
    action: "BOT_DOORBELL_TESTED",
    targetType: "bot",
    targetId: link.botId,
    ip,
    metadata: { ok: r.ok, statusCode: r.statusCode, ...(r.ok ? {} : { error: r.summary }) },
  });
  if (await maybeComplete(link.id, r.ok, ip)) return c.html(<SetupDone botName={link.bot.name} banner={r.banner} />);
  return renderPage(c, token, link, { banner: { kind: r.ok ? "ok" : "bad", text: r.banner } });
}

export function registerSetup(app: Hono<AppEnv>): void {
  const origin = new URL(config.PUBLIC_BASE_URL).origin;
  app.use("/setup/*", setupHeaders);
  app.use("/setup/*", csrf({ origin }));
  app.use(
    "/setup/*",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => serverErrorResponse(c as C, 413, "Request too large.") }),
  );

  app.get("/setup/:token", (c) =>
    withLink(c, async (link, ip) => {
      const opened = await prisma.auditLog.findFirst({
        where: { action: "SETUP_LINK_OPENED", targetId: link.id },
        select: { id: true },
      });
      if (!opened) {
        await audit({
          actorType: "OWNER",
          actorId: link.id,
          action: "SETUP_LINK_OPENED",
          targetType: "setup_link",
          targetId: link.id,
          ip,
          metadata: { botId: link.botId },
        });
      }
      return renderPage(c, c.req.param("token"), link);
    }),
  );

  app.post("/setup/:token/reveal-key", (c) =>
    withLink(c, async (link, ip) => {
      if (!(await checkCsrf(c, link))) return forbidden(c);
      const token = c.req.param("token");
      const key = await revealKey(link, ip);
      if (!key) return renderPage(c, token, link, { banner: { kind: "warn", text: ALREADY_REVEALED_TEXT } });
      // If the doorbell already works, revealing the key finishes setup.
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: link.botId } });
      const completed = await maybeComplete(link.id, bot.doorbellState === "OK" && !!bot.webhookUrl, ip);
      return c.html(<KeyOnce token={token} apiKey={key} completed={completed} botName={bot.name} />);
    }),
  );

  app.post("/setup/:token/doorbell", (c) =>
    withLink(c, async (link, ip) => {
      const f = await checkCsrf(c, link);
      if (!f) return forbidden(c);
      const token = c.req.param("token");
      const prev = await bumpSaveAttempts(link.id);
      if (prev >= 10) return renderPage(c, token, link, { errors: [TOO_MANY_SAVES_TEXT] }, 429);
      const errors: string[] = [];
      const urlCheck = await checkWebhookUrl(f["webhookUrl"] ?? "");
      if (!urlCheck.ok) errors.push(urlCheck.message);
      const senderKey = (f["senderKey"] ?? "").trim();
      if (senderKey.length < 8 || senderKey.length > 500 || /\s/.test(senderKey)) errors.push(BAD_SENDER_KEY_TEXT);
      if (errors.length || !urlCheck.ok) return renderPage(c, token, link, { errors }, 400);
      await saveDoorbell(link, urlCheck.url.toString(), senderKey, ip);
      return runTest(c, token, link, ip);
    }),
  );

  app.post("/setup/:token/test", (c) =>
    withLink(c, async (link, ip) => {
      if (!(await checkCsrf(c, link))) return forbidden(c);
      const token = c.req.param("token");
      if (!link.bot.webhookUrl) return renderPage(c, token, link, { errors: ["Save a doorbell first."] }, 400);
      if (limiters.setupTest.isBlocked(link.id))
        return renderPage(c, token, link, { errors: [TOO_MANY_TESTS_TEXT] }, 429);
      limiters.setupTest.hit(link.id);
      return runTest(c, token, link, ip);
    }),
  );
}
