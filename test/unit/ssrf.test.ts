import { describe, expect, it } from "vitest";
import { checkWebhookUrl, isPublicAddress, makeSafeLookup, validateWebhookUrl } from "../../src/doorbell/ssrf.js";
import { postDoorbell } from "../../src/doorbell/sender.js";

describe("A-34 SSRF: validateWebhookUrl", () => {
  const mustReject = [
    "http://api2.cursor.sh/automations/webhook/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://user:pw@api2.cursor.sh/automations/webhook/x",
    "https://api2.cursor.sh:8443/automations/webhook/x",
    "https://evil.example.com/x",
    "https://api2.cursor.sh/other",
  ];
  for (const url of mustReject) {
    it(`rejects ${url}`, () => {
      // Production rules: the dev-only localhost allowance is off.
      expect(validateWebhookUrl(url, { devAllowLocalhost: false }).ok).toBe(false);
    });
  }

  it("allows http://127.0.0.1 only in dev-localhost mode", () => {
    expect(validateWebhookUrl("http://127.0.0.1:9999/x", { devAllowLocalhost: true }).ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1:9999/x", { devAllowLocalhost: false }).ok).toBe(false);
  });

  it("accepts a Grok Bot webhook URL and strips the fragment", () => {
    const r = validateWebhookUrl("https://api2.cursor.sh/automations/webhook/abc123#frag");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.toString()).toBe("https://api2.cursor.sh/automations/webhook/abc123");
  });

  it("gives friendly messages", () => {
    expect(validateWebhookUrl("nope")).toEqual({ ok: false, message: "That doesn't look like a valid URL." });
    expect(validateWebhookUrl("http://api2.cursor.sh/automations/webhook/x")).toEqual({
      ok: false,
      message: "Webhook URL must start with https://.",
    });
    expect(validateWebhookUrl("https://evil.example.com/x")).toEqual({
      ok: false,
      message: "Webhook host 'evil.example.com' isn't on Bot Bridge's allowed list (api2.cursor.sh).",
    });
    expect(validateWebhookUrl("https://api2.cursor.sh/other")).toEqual({
      ok: false,
      message:
        "That doesn't look like a Grok Bot webhook URL. It should start with https://api2.cursor.sh/automations/webhook/.",
    });
    expect(validateWebhookUrl(`https://api2.cursor.sh/automations/webhook/${"a".repeat(500)}`)).toEqual({
      ok: false,
      message: "That URL is too long.",
    });
  });
});

describe("A-34 SSRF: isPublicAddress", () => {
  const priv = [
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.1.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:10.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
  ];
  for (const a of priv) it(`${a} is not public`, () => expect(isPublicAddress(a)).toBe(false));
  for (const a of ["8.8.8.8", "2606:4700::1111"]) it(`${a} is public`, () => expect(isPublicAddress(a)).toBe(true));
  it("garbage is not public", () => expect(isPublicAddress("not-an-ip")).toBe(false));
});

describe("A-34 SSRF: DNS pinning", () => {
  const privateResolver = (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: "10.0.0.1", family: 4 }]);

  it("safeLookup blocks an allowed host that resolves to a private address", async () => {
    const lookup = makeSafeLookup(privateResolver as never);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      (lookup as any)("api2.cursor.sh", {}, (e: NodeJS.ErrnoException | null) => resolve(e)),
    );
    expect(err?.code).toBe("EBLOCKED");
  });

  it("postDoorbell refuses to connect when DNS returns a private address", async () => {
    const r = await postDoorbell(
      "https://api2.cursor.sh/automations/webhook/x",
      "k",
      { event: "bridge.test", ts: 1 },
      { lookup: makeSafeLookup(privateResolver as never) },
    );
    expect(r).toEqual({ kind: "error", code: "blocked", detail: "blocked: private address" });
  });

  it("checkWebhookUrl rejects a private resolution at save time", async () => {
    const r = await checkWebhookUrl("https://api2.cursor.sh/automations/webhook/x", privateResolver as never);
    expect(r).toEqual({
      ok: false,
      message: "That webhook host resolves to a private network address, which Bot Bridge won't call.",
    });
  });

  it("safeLookup passes public addresses through (all and single forms)", async () => {
    const pub = (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: "8.8.8.8", family: 4 }]);
    const lookup = makeSafeLookup(pub as never) as any;
    const single = await new Promise((resolve) => lookup("x", {}, (_e: unknown, a: string) => resolve(a)));
    expect(single).toBe("8.8.8.8");
    const all = await new Promise((resolve) => lookup("x", { all: true }, (_e: unknown, a: unknown) => resolve(a)));
    expect(all).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });
});
