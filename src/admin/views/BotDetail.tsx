import type { AuditLog, Bot, Connection, DoorbellJob, SetupLink, UsageCounter } from "../../generated/prisma/client.js";
import { displayPrefix } from "../../lib/apiKeys.js";
import { formatET, relative } from "../../lib/time.js";
import { maskWebhook } from "../../services/setupLinks.js";
import { BotFields, type BotFormValues } from "./BotNew.js";
import { DoorbellCell, StatusBadge } from "./Bots.js";
import { Banner, Csrf, Errors, Layout } from "./Layout.js";

export interface BotDetailProps {
  csrf: string;
  bot: Bot;
  connections: (Connection & { other: Bot })[];
  links: SetupLink[];
  jobs: DoorbellJob[];
  usage: UsageCounter[];
  audits: AuditLog[];
  values?: BotFormValues;
  errors?: string[];
  flash?: { kind: "ok" | "bad" | "warn"; text: string } | null;
}

function linkState(l: SetupLink): string {
  if (l.revokedAt) return "revoked";
  if (l.usedAt) return "used";
  if (l.expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

export function BotDetail(p: BotDetailProps) {
  const b = p.bot;
  const v: BotFormValues = p.values ?? {
    name: b.name,
    ownerName: b.ownerName,
    ownerEmail: b.ownerEmail ?? "",
    notes: b.notes ?? "",
    sendLimitPerHour: String(b.sendLimitPerHour),
    mcpCallLimitPerHour: String(b.mcpCallLimitPerHour),
  };
  return (
    <Layout title={b.name} csrf={p.csrf} flash={p.flash}>
      <h1>
        {b.name} <StatusBadge status={b.status} />
      </h1>
      <p class="muted">
        <code>{b.id}</code> · owner {b.ownerName}
        {b.ownerEmail ? ` <${b.ownerEmail}>` : ""} · created {formatET(b.createdAt)} · last seen {relative(b.lastSeenAt)}
      </p>

      <h2>Status</h2>
      <div class="card">
        {b.status === "ACTIVE" ? (
          <form method="post" action={`/admin/bots/${b.id}/disable`} class="inline">
            <Csrf token={p.csrf} />
            <button type="submit" class="danger">
              Disable bot
            </button>
          </form>
        ) : (
          <form method="post" action={`/admin/bots/${b.id}/enable`} class="inline">
            <Csrf token={p.csrf} />
            <button type="submit">Enable bot</button>
          </form>
        )}
        {b.disabledAt ? <p class="muted">Disabled {formatET(b.disabledAt)}</p> : null}
      </div>

      <h2>API key</h2>
      <div class="card">
        <p>
          Key: <code>{displayPrefix(b.apiKeyPrefix)}</code> · last rotated {formatET(b.apiKeyRotatedAt)}
        </p>
        <form method="post" action={`/admin/bots/${b.id}/rotate-key`}>
          <Csrf token={p.csrf} />
          <label class="inline">
            <input type="checkbox" name="confirm" value="yes" /> Yes, the current key should stop working now
          </label>
          <button type="submit" class="danger">
            Rotate key (show new key once)
          </button>
        </form>
      </div>

      <h2>Doorbell</h2>
      <div class="card">
        <p>
          State: <DoorbellCell bot={b} />
          {b.webhookUrl ? (
            <>
              {" "}
              · webhook <code>{maskWebhook(b.webhookUrl)}</code>
            </>
          ) : null}
          {b.doorbellUpdatedAt ? <span class="muted"> · updated {formatET(b.doorbellUpdatedAt)}</span> : null}
        </p>
        {b.lastDoorbellError ? <p class="muted">Last error: {b.lastDoorbellError}</p> : null}
        {b.webhookUrl ? (
          <>
            <form method="post" action={`/admin/bots/${b.id}/doorbell/test`} class="inline">
              <Csrf token={p.csrf} />
              <button type="submit">Test doorbell</button>
            </form>{" "}
            <form method="post" action={`/admin/bots/${b.id}/doorbell/clear`}>
              <Csrf token={p.csrf} />
              <label class="inline">
                <input type="checkbox" name="confirm" value="yes" /> Remove the webhook URL and sender key
              </label>
              <button type="submit" class="danger">
                Clear doorbell
              </button>
            </form>
          </>
        ) : (
          <p class="muted">No doorbell saved. The owner sets it on a setup link.</p>
        )}
      </div>

      <h2>Setup links</h2>
      <div class="card">
        <form method="post" action={`/admin/bots/${b.id}/setup-links`}>
          <Csrf token={p.csrf} />
          <label class="inline">
            <input type="checkbox" name="includeNewKey" value="yes" checked={b.lastSeenAt === null} /> Include a new API key
            (rotates the current key now)
          </label>
          <label for="ttlHours">Expires after (hours, 1–168)</label>
          <input type="number" id="ttlHours" name="ttlHours" value="168" min={1} max={168} />
          <button type="submit">Create setup link (shown once)</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Expires</th>
              <th>State</th>
              <th>Key</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {p.links.map((l) => (
              <tr>
                <td>{formatET(l.createdAt)}</td>
                <td>{formatET(l.expiresAt)}</td>
                <td>{linkState(l)}</td>
                <td>{l.keyRevealedAt ? `revealed ${formatET(l.keyRevealedAt)}` : l.apiKeyEnc ? "waiting" : "none"}</td>
                <td>
                  {linkState(l) === "active" ? (
                    <form method="post" action={`/admin/setup-links/${l.id}/revoke`} class="inline">
                      <Csrf token={p.csrf} />
                      <button type="submit" class="danger">
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Connections</h2>
      <table>
        <thead>
          <tr>
            <th>With</th>
            <th>Status</th>
            <th>Approved</th>
          </tr>
        </thead>
        <tbody>
          {p.connections.map((c) => (
            <tr>
              <td>
                <a href={`/admin/bots/${c.other.id}`}>{c.other.name}</a>
              </td>
              <td>{c.status.toLowerCase()}</td>
              <td>{formatET(c.approvedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Profile and limits</h2>
      <div class="card">
        <Errors errors={p.errors} />
        <form method="post" action={`/admin/bots/${b.id}/edit`}>
          <Csrf token={p.csrf} />
          <BotFields v={v} />
          <button type="submit">Save changes</button>
        </form>
      </div>

      <h2>Recent doorbell jobs</h2>
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last code</th>
            <th>Last error</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {p.jobs.map((j) => (
            <tr>
              <td>
                <code>{j.id}</code>
              </td>
              <td>{j.status}</td>
              <td>{j.attempts}</td>
              <td>{j.lastStatusCode ?? "–"}</td>
              <td>{j.lastError ?? ""}</td>
              <td>{formatET(j.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Usage (last 6 months)</h2>
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Sent</th>
            <th>Received</th>
            <th>Tool calls</th>
            <th>Doorbells sent</th>
            <th>Doorbells failed</th>
          </tr>
        </thead>
        <tbody>
          {p.usage.map((u) => (
            <tr>
              <td>{u.month}</td>
              <td>{u.messagesSent}</td>
              <td>{u.messagesReceived}</td>
              <td>{u.mcpCalls}</td>
              <td>{u.doorbellsSent}</td>
              <td>{u.doorbellsFailed}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent audit entries</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Metadata</th>
          </tr>
        </thead>
        <tbody>
          {p.audits.map((a) => (
            <tr>
              <td>{formatET(a.createdAt)}</td>
              <td>
                {a.actorType}
                {a.actorId ? ` ${a.actorId}` : ""}
              </td>
              <td>{a.action}</td>
              <td>
                <code>{a.metadata ? JSON.stringify(a.metadata) : ""}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
}

export { Banner };
