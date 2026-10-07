import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  DATABASE_URL: "postgresql://x@localhost/db",
  PUBLIC_BASE_URL: "https://bridge.example.com",
  ADMIN_EMAIL: "a@example.com",
  ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,p=4,t=3$6PmR0h5l9IQaHWmaVpqHBg$bdLWAJWFI59MBwDAENX/9pluRYjQ+dtrbIIPiZPDMIA",
  SESSION_SECRET: Buffer.alloc(32, 1).toString("base64"),
  KEY_PEPPER: Buffer.alloc(32, 2).toString("base64"),
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
};

describe("A-02 config", () => {
  it("loads a valid env with defaults", () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.RETENTION_DAYS).toBe(90);
    expect(c.DOORBELL_ALLOWED_HOSTS).toEqual(["api2.cursor.sh"]);
    expect(c.DOORBELL_DEV_ALLOW_LOCALHOST).toBe(false);
    expect(Object.isFrozen(c)).toBe(true);
  });

  for (const name of Object.keys(base)) {
    it(`throws naming ${name} when it is missing`, () => {
      const env: Record<string, string | undefined> = { ...base, [name]: undefined };
      expect(() => loadConfig(env)).toThrow(new RegExp(`${name}: is required but missing`));
    });
  }

  it("rejects secrets that are too short", () => {
    expect(() => loadConfig({ ...base, KEY_PEPPER: "c2hvcnQ=" })).toThrow(/KEY_PEPPER: is too short \(8 characters\)/);
  });

  it("derives a 32-byte key from a long random non-base64 secret", () => {
    const generated = "Xk9pLr7GqT2mBv4Nc8Zw1Hy6Jd3Fs5Qa"; // 32 chars, decodes to only 24 bytes as base64
    const c = loadConfig({ ...base, ENCRYPTION_KEY: generated, SESSION_SECRET: `${generated}!#%` });
    const key = Buffer.from(c.ENCRYPTION_KEY, "base64");
    expect(key).toHaveLength(32);
    expect(key).toEqual(createHash("sha256").update(generated).digest());
    expect(Buffer.from(c.SESSION_SECRET, "base64")).toHaveLength(32);
    expect(loadConfig({ ...base, ENCRYPTION_KEY: generated }).ENCRYPTION_KEY).toBe(c.ENCRYPTION_KEY);
  });

  it("accepts secrets pasted with whitespace, quotes, a NAME= prefix, or base64url", () => {
    const raw = Buffer.alloc(32, 7).toString("base64");
    const url = Buffer.alloc(32, 0xfb).toString("base64url");
    const c = loadConfig({
      ...base,
      SESSION_SECRET: `  ${raw}\n`,
      KEY_PEPPER: `"${raw}"`,
      ENCRYPTION_KEY: `ENCRYPTION_KEY=${raw}`,
    });
    expect(c.SESSION_SECRET).toBe(raw);
    expect(c.KEY_PEPPER).toBe(raw);
    expect(c.ENCRYPTION_KEY).toBe(raw);
    expect(Buffer.from(loadConfig({ ...base, KEY_PEPPER: url }).KEY_PEPPER, "base64")).toEqual(Buffer.alloc(32, 0xfb));
    // Padding is never mistaken for a NAME= prefix.
    const allUpper = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "latin1").toString("base64");
    expect(loadConfig({ ...base, KEY_PEPPER: allUpper }).KEY_PEPPER).toBe(allUpper);
  });

  it("explains what's wrong with a bad secret without echoing it", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadConfig({ ...base, KEY_PEPPER: short })).toThrow(/KEY_PEPPER: is too short \(24 characters\)/);
    let msg = "";
    try {
      loadConfig({ ...base, SESSION_SECRET: "my secret phrase!" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SESSION_SECRET: contains spaces/);
    expect(msg).not.toContain("my secret phrase");
  });

  it("rejects the .env.example placeholder hash and accepts a quoted real one", () => {
    expect(() =>
      loadConfig({ ...base, ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=4$REPLACE_ME$REPLACE_ME" }),
    ).toThrow(/ADMIN_PASSWORD_HASH: looks like an incomplete or placeholder argon2id hash/);
    // node-argon2 writes m,p,t; browser libraries write m,t,p. Both are accepted.
    const browserOrder = "$argon2id$v=19$m=65536,t=3,p=4$W5DzXl4KbQnF1vZbTq8m1A$zhWYmaYQQ2qJi3rChaxKHp1K27Rs7Az9mJFcxqvYGXc";
    expect(loadConfig({ ...base, ADMIN_PASSWORD_HASH: browserOrder }).ADMIN_PASSWORD_HASH).toBe(browserOrder);
    expect(loadConfig({ ...base, ADMIN_PASSWORD_HASH: `'${base.ADMIN_PASSWORD_HASH}' ` }).ADMIN_PASSWORD_HASH).toBe(
      base.ADMIN_PASSWORD_HASH,
    );
  });

  it("rejects a non-argon2id password hash and a trailing slash base url", () => {
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD_HASH: "plain" })).toThrow(/ADMIN_PASSWORD_HASH/);
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: "https://x.com/" })).toThrow(/PUBLIC_BASE_URL/);
  });

  it("refuses DOORBELL_DEV_ALLOW_LOCALHOST in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", DOORBELL_DEV_ALLOW_LOCALHOST: "true" })).toThrow(
      /DOORBELL_DEV_ALLOW_LOCALHOST/,
    );
    expect(loadConfig({ ...base, NODE_ENV: "development", DOORBELL_DEV_ALLOW_LOCALHOST: "true" })
      .DOORBELL_DEV_ALLOW_LOCALHOST).toBe(true);
  });
});
