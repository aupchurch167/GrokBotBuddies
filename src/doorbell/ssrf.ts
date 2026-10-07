import dns from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { config } from "../config.js";

type Result = { ok: true; url: URL } | { ok: false; message: string };
const fail = (message: string): Result => ({ ok: false, message });

export function devLocalHost(hostname: string, allow: boolean = config.DOORBELL_DEV_ALLOW_LOCALHOST): boolean {
  return allow && ["localhost", "127.0.0.1"].includes(hostname);
}

export interface ValidateOptions {
  /** Defaults to DOORBELL_DEV_ALLOW_LOCALHOST (tests/local dev only). */
  devAllowLocalhost?: boolean;
}

/** Static checks on a webhook URL (scheme, port, credentials, host allowlist, Grok Bot path). */
export function validateWebhookUrl(raw: string, opts: ValidateOptions = {}): Result {
  if (raw.trim().length > 500) return fail("That URL is too long.");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return fail("That doesn't look like a valid URL.");
  }
  const devLocal = devLocalHost(u.hostname, opts.devAllowLocalhost);
  if (u.protocol !== "https:" && !(devLocal && u.protocol === "http:")) return fail("Webhook URL must start with https://.");
  if (u.username || u.password) return fail("Webhook URL can't include a username or password.");
  if (u.port && u.port !== "443" && !devLocal) return fail("Webhook URL must use the standard HTTPS port.");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!devLocal && (ipaddr.isValid(host) || host.startsWith("[")))
    return fail("Webhook URL must use a hostname, not an IP address.");
  if (!devLocal && !config.DOORBELL_ALLOWED_HOSTS.includes(host))
    return fail(
      `Webhook host '${host}' isn't on Bot Bridge's allowed list (${config.DOORBELL_ALLOWED_HOSTS.join(", ")}).`,
    );
  if (host === "api2.cursor.sh" && !u.pathname.startsWith("/automations/webhook/"))
    return fail(
      "That doesn't look like a Grok Bot webhook URL. It should start with https://api2.cursor.sh/automations/webhook/.",
    );
  u.hash = "";
  return { ok: true, url: u };
}

const EXTRA_DENY = [
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
  "64:ff9b::/96",
  "100::/64",
  "2001:db8::/32",
  "2002::/16",
].map((c) => ipaddr.parseCIDR(c));

export function isPublicAddress(addr: string): boolean {
  let ip: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    ip = ipaddr.process(addr); // unwraps IPv4-mapped IPv6 (::ffff:10.0.0.1 → 10.0.0.1)
  } catch {
    return false;
  }
  if (ip.range() !== "unicast") return false;
  // ipaddr.js reports 198.18.0.1 etc. as "unicast", hence the extra deny list.
  return !EXTRA_DENY.some(([net, bits]) => net.kind() === ip.kind() && ip.match(net as never, bits));
}

type Resolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

const defaultResolver: Resolver = (h, o, cb) => dns.lookup(h, o, cb);

/** A net/http `lookup` that refuses to connect to any non-public address (DNS pinned per connection). */
export function makeSafeLookup(resolver: Resolver = defaultResolver): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...a: unknown[]) => void) => {
    resolver(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return callback(err, "", 0);
      if (!addrs.length) return callback(Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }), "", 0);
      if (!devLocalHost(hostname) && addrs.some((a) => !isPublicAddress(a.address)))
        return callback(Object.assign(new Error("blocked: private address"), { code: "EBLOCKED" }), "", 0);
      if ((options as { all?: boolean }).all) return callback(null, addrs);
      callback(null, addrs[0]!.address, addrs[0]!.family);
    });
  }) as unknown as LookupFunction;
}

export const safeLookup = makeSafeLookup();

/** Save-time check: static validation plus a DNS resolution that must be all-public. */
export async function checkWebhookUrl(raw: string, resolver: Resolver = defaultResolver): Promise<Result> {
  const v = validateWebhookUrl(raw);
  if (!v.ok) return v;
  const host = v.url.hostname.toLowerCase().replace(/\.$/, "");
  if (devLocalHost(host)) return v;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await new Promise((resolve, reject) =>
      resolver(host, { all: true, verbatim: true }, (err, a) => (err ? reject(err) : resolve(a))),
    );
  } catch {
    return fail("Bot Bridge couldn't look up that webhook host. Check the URL and try again.");
  }
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address)))
    return fail("That webhook host resolves to a private network address, which Bot Bridge won't call.");
  return v;
}
