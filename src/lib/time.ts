import { config } from "../config.js";

/** UTC "YYYY-MM" */
export function utcMonth(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

function zoneLabel(tz: string): string {
  if (tz === "America/New_York") return "ET";
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

/** e.g. "Oct 8, 2026 10:05 AM ET" */
export function formatET(d: Date | null | undefined, tz: string = config.ADMIN_TIMEZONE): string {
  if (!d) return "–";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${s.replace(/,(?=[^,]*$)/, "").replace(/ /g, " ")} ${zoneLabel(tz)}`;
}

export function relative(d: Date | null | undefined, now: number = Date.now()): string {
  if (!d) return "never";
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
