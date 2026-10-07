import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  DATABASE_URL: "postgresql://x@localhost/db",
  PUBLIC_BASE_URL: "https://bridge.example.com",
  ADMIN_EMAIL: "a@example.com",
  ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
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

  it("rejects secrets that are not 32 bytes", () => {
    expect(() => loadConfig({ ...base, KEY_PEPPER: "c2hvcnQ=" })).toThrow(/KEY_PEPPER/);
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
    expect(() => loadConfig({ ...base, KEY_PEPPER: short })).toThrow(
      /KEY_PEPPER: decodes to 16 bytes but must be exactly 32 \(24 characters; expected 44\)/,
    );
    let msg = "";
    try {
      loadConfig({ ...base, SESSION_SECRET: "my secret phrase!" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SESSION_SECRET: isn't valid base64/);
    expect(msg).not.toContain("my secret phrase");
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
