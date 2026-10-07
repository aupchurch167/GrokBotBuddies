import type { Hono } from "hono";
import type { AppEnv } from "../../src/types.js";

export const ORIGIN = "http://localhost:8080";
export const ADMIN_EMAIL = "admin@example.test";
export const ADMIN_PASSWORD = "test-admin-password-123";

export interface Resp {
  res: Response;
  status: number;
  html: string;
  /** html with the common entities decoded, for exact-copy assertions. */
  text: string;
  location: string | null;
}

export function decodeEntities(html: string): string {
  return html
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Pulls the hidden `_csrf` value out of a rendered form. */
export function extractCsrf(html: string): string | null {
  const m = /name="_csrf" value="([^"]+)"/.exec(html) ?? /value="([^"]+)" name="_csrf"/.exec(html);
  return m ? m[1]! : null;
}

/** Minimal cookie-jar browser for the in-process Hono app (admin + setup pages). */
export class Browser {
  cookies = new Map<string, string>();
  /** Session CSRF token for admin forms (set by login()). */
  csrf: string | null = null;

  constructor(
    private app: Hono<AppEnv>,
    public ip = "10.0.0.1",
  ) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Resp> {
    const headers: Record<string, string> = { "X-Forwarded-For": this.ip, ...(init.headers ?? {}) };
    const ck = this.cookieHeader();
    if (ck) headers["Cookie"] = ck;
    const res = await this.app.request(path, { method, headers, body: init.body });
    this.absorb(res);
    const html = await res.text();
    return { res, status: res.status, html, text: decodeEntities(html), location: res.headers.get("location") };
  }

  get(path: string): Promise<Resp> {
    return this.request("GET", path);
  }

  /**
   * Form POST. `_csrf` defaults to the admin session token; pass `csrf: null` to omit it,
   * or a string to override. `origin: null` omits the Origin header.
   */
  post(
    path: string,
    fields: Record<string, string> = {},
    opts: { csrf?: string | null; origin?: string | null } = {},
  ): Promise<Resp> {
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    const body = new URLSearchParams({ ...(csrf ? { _csrf: csrf } : {}), ...fields }).toString();
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    return this.request("POST", path, {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(origin ? { Origin: origin } : {}),
      },
    });
  }

  /** GET the login form, then POST credentials. Returns the POST response. */
  async tryLogin(email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<Resp> {
    const page = await this.get("/admin/login");
    const csrf = extractCsrf(page.html);
    if (!csrf) throw new Error(`no _csrf on login page (status ${page.status})`);
    return this.post("/admin/login", { email, password }, { csrf });
  }

  /** Logs in and records the session CSRF token. */
  async login(): Promise<this> {
    const r = await this.tryLogin();
    if (r.status !== 302 || !this.cookies.has("bb_admin")) throw new Error(`login failed: ${r.status} ${r.html.slice(0, 200)}`);
    const bots = await this.get("/admin/bots");
    this.csrf = extractCsrf(bots.html);
    if (!this.csrf) throw new Error("no _csrf on /admin/bots");
    return this;
  }
}

/** A logged-in admin browser. */
export async function loginAdmin(app: Hono<AppEnv>, ip = "10.0.0.1"): Promise<Browser> {
  return new Browser(app, ip).login();
}
