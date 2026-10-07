import { describe, expect, it } from "vitest";
import { testApp } from "../helpers/app.js";

describe("A-01 health", () => {
  it("returns 200 {ok:true} when the DB answers", async () => {
    const res = await testApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 503 {ok:false} when the DB is unreachable", async () => {
    const failing = { $queryRaw: async () => Promise.reject(new Error("connect ECONNREFUSED")) };
    const res = await testApp({ healthDb: failing }).request("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("serves the root text and a 404 for unknown paths", async () => {
    const app = testApp();
    const root = await app.request("/");
    expect(await root.text()).toBe("Bot Bridge is running. Bots connect at /mcp.");
    const nf = await app.request("/nope", { headers: { accept: "application/json" } });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "Not found." });
    const nfHtml = await app.request("/nope");
    expect(nfHtml.status).toBe(404);
    expect(nfHtml.headers.get("content-type")).toContain("text/html");
  });

  it("sets security headers and a request id", async () => {
    const res = await testApp().request("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9A-Za-z]{12}$/);
  });
});
