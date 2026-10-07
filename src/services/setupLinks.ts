import { config } from "../config.js";
import { prisma } from "../db.js";
import type { Bot, Prisma, SetupLink } from "../generated/prisma/client.js";
import { randomBase62 } from "../lib/base62.js";
import { aad, aesGcmDecrypt, aesGcmEncrypt, sha256Hex } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { audit } from "./audit.js";
import { rotateKey } from "./bots.js";

export const TOKEN_RE = /^[0-9A-Za-z]{43}$/;

export interface CreateLinkOptions {
  /** Rotate the bot's key and park the new key (encrypted) on the link. */
  includeNewKey: boolean;
  /** Park this already-generated key instead of rotating (used right after bot creation). */
  existingKey?: string;
  ttlHours?: number;
  actorIp?: string | null;
}

export interface CreatedLink {
  link: SetupLink;
  token: string;
  url: string;
}

export function setupUrl(token: string): string {
  return `${config.PUBLIC_BASE_URL}/setup/${token}`;
}

/** Creates a setup link. Only the newest active link may carry a key, so older unused key links are revoked. */
export async function createSetupLink(botId: string, opts: CreateLinkOptions): Promise<CreatedLink> {
  const ttl = opts.ttlHours ?? config.SETUP_LINK_TTL_HOURS;
  const token = randomBase62(43);
  const id = newId("sl");
  const carriesKey = opts.includeNewKey || !!opts.existingKey;
  return prisma.$transaction(async (tx) => {
    let apiKeyEnc: string | null = null;
    if (carriesKey) {
      let key = opts.existingKey;
      if (!key) {
        const r = await rotateKey(botId, tx);
        key = r.key;
        await audit(
          {
            actorType: "ADMIN",
            actorId: "admin",
            action: "BOT_KEY_ROTATED",
            targetType: "bot",
            targetId: botId,
            ip: opts.actorIp,
            metadata: { newPrefix: r.bot.apiKeyPrefix, via: "setup_link" },
          },
          tx,
        );
      }
      apiKeyEnc = aesGcmEncrypt(key, aad.setupKey(id));
      await tx.setupLink.updateMany({
        where: { botId, usedAt: null, revokedAt: null, apiKeyEnc: { not: null } },
        data: { revokedAt: new Date(), apiKeyEnc: null },
      });
    }
    const link = await tx.setupLink.create({
      data: {
        id,
        botId,
        tokenHash: sha256Hex(token),
        apiKeyEnc,
        expiresAt: new Date(Date.now() + ttl * 3_600_000),
      },
    });
    await audit(
      {
        actorType: "ADMIN",
        actorId: "admin",
        action: "SETUP_LINK_CREATED",
        targetType: "setup_link",
        targetId: link.id,
        ip: opts.actorIp,
        metadata: { botId, includesKey: carriesKey, expiresAt: link.expiresAt.toISOString() },
      },
      tx,
    );
    return { link, token, url: setupUrl(token) };
  });
}

export async function revokeSetupLink(linkId: string, actorIp: string | null): Promise<SetupLink | null> {
  const link = await prisma.setupLink.findUnique({ where: { id: linkId } });
  if (!link) return null;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.setupLink.update({
      where: { id: linkId },
      data: { revokedAt: link.revokedAt ?? new Date(), apiKeyEnc: null },
    });
    await audit(
      {
        actorType: "ADMIN",
        actorId: "admin",
        action: "SETUP_LINK_REVOKED",
        targetType: "setup_link",
        targetId: linkId,
        ip: actorIp,
        metadata: { botId: link.botId, includesKey: link.apiKeyEnc !== null, expiresAt: link.expiresAt.toISOString() },
      },
      tx,
    );
    return updated;
  });
}

export type LinkWithBot = SetupLink & { bot: Bot };

/** Valid = exists, not revoked, not used, not expired, and the bot isn't DISABLED. */
export async function loadValidLink(token: string): Promise<LinkWithBot | null> {
  if (!TOKEN_RE.test(token)) return null;
  const link = await prisma.setupLink.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { bot: true } });
  if (!link) return null;
  if (link.revokedAt || link.usedAt || link.expiresAt.getTime() <= Date.now() || link.bot.status === "DISABLED") return null;
  return link;
}

/** Decrypts and clears the parked key in one transaction. Returns null if it was already revealed. */
export async function revealKey(link: SetupLink, ip: string | null = null): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.setupLink.findUnique({ where: { id: link.id } });
    if (!fresh?.apiKeyEnc) return null;
    const key = aesGcmDecrypt(fresh.apiKeyEnc, aad.setupKey(fresh.id));
    const r = await tx.setupLink.updateMany({
      where: { id: fresh.id, apiKeyEnc: { not: null } },
      data: { apiKeyEnc: null, keyRevealedAt: new Date() },
    });
    if (r.count !== 1) return null;
    await audit(
      {
        actorType: "OWNER",
        actorId: fresh.id,
        action: "SETUP_LINK_KEY_REVEALED",
        targetType: "setup_link",
        targetId: fresh.id,
        ip,
        metadata: { botId: fresh.botId },
      },
      tx,
    );
    return key;
  });
}

/** Increments saveAttempts and returns the value it had before. */
export async function bumpSaveAttempts(linkId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ prev: number }[]>`
    UPDATE "SetupLink" SET "saveAttempts" = "saveAttempts" + 1 WHERE id = ${linkId}
    RETURNING "saveAttempts" - 1 AS prev`;
  return Number(row?.prev ?? 0);
}

export async function saveDoorbell(link: SetupLink, webhookUrl: string, senderKey: string, ip: string | null) {
  const host = new URL(webhookUrl).hostname;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.bot.update({
      where: { id: link.botId },
      data: {
        webhookUrl,
        webhookKeyEnc: aesGcmEncrypt(senderKey, aad.webhookKey(link.botId)),
        doorbellUpdatedAt: new Date(),
      },
    });
    await audit(
      {
        actorType: "OWNER",
        actorId: link.id,
        action: "BOT_DOORBELL_SET",
        targetType: "bot",
        targetId: link.botId,
        ip,
        metadata: { host },
      },
      tx,
    );
  });
}

/** Marks the link used when the last test passed and no key is waiting. Returns true if completed. */
export async function maybeComplete(linkId: string, lastTestPassed: boolean, ip: string | null): Promise<boolean> {
  if (!lastTestPassed) return false;
  return prisma.$transaction(async (tx) => {
    const r = await tx.setupLink.updateMany({
      where: { id: linkId, apiKeyEnc: null, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (r.count !== 1) return false;
    const link = await tx.setupLink.findUniqueOrThrow({ where: { id: linkId } });
    await audit(
      {
        actorType: "OWNER",
        actorId: linkId,
        action: "SETUP_LINK_COMPLETED",
        targetType: "setup_link",
        targetId: linkId,
        ip,
        metadata: { botId: link.botId },
      },
      tx,
    );
    return true;
  });
}

/** "api2.cursor.sh/…/abc123": host plus the last 6 chars of the path. Never the full URL. */
export function maskWebhook(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, "");
    return `${u.hostname}/…/${p.slice(-6)}`;
  } catch {
    return "(invalid)";
  }
}
