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
