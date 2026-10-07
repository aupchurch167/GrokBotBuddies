import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import { prisma } from "../db.js";
import type { AdminSession } from "../generated/prisma/client.js";
import { sha256Hex } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import type { AppEnv } from "../types.js";

export const SESSION_COOKIE = "bb_admin";
const ABSOLUTE_MS = 7 * 24 * 3_600_000;
const IDLE_MS = 12 * 3_600_000;
const TOUCH_MS = 5 * 60_000;
export const secureCookies = () => config.PUBLIC_BASE_URL.startsWith("https://");

export async function createSession(c: Context, ip: string | null): Promise<AdminSession> {
  const token = randomBytes(32).toString("base64url");
  const session = await prisma.adminSession.create({
    data: {
      id: newId("ses"),
      tokenHash: sha256Hex(token),
      csrfToken: randomBytes(32).toString("hex"),
      ip: ip?.slice(0, 64) ?? null,
      userAgent: (c.req.header("user-agent") ?? "").slice(0, 300) || null,
      expiresAt: new Date(Date.now() + ABSOLUTE_MS),
    },
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/admin",
    maxAge: 43200,
    secure: secureCookies(),
  });
  return session;
}

export async function loadSession(c: Context): Promise<AdminSession | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 200) return null;
  const s = await prisma.adminSession.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt.getTime() <= now || s.lastSeenAt.getTime() < now - IDLE_MS) {
    await prisma.adminSession.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  if (now - s.lastSeenAt.getTime() > TOUCH_MS) {
    await prisma.adminSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return s;
}

export async function destroySession(c: Context, session: AdminSession | null): Promise<void> {
  if (session) await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {});
  deleteCookie(c, SESSION_COOKIE, { path: "/admin", secure: secureCookies() });
}

/** Every /admin route except the login page needs a valid session. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await loadSession(c);
  if (!session) return c.redirect("/admin/login", 302);
  c.set("adminSession", session);
  await next();
};
