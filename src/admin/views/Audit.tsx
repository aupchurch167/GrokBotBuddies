import type { AuditLog } from "../../generated/prisma/client.js";
import { formatET } from "../../lib/time.js";
import { Csrf, Layout, Pager } from "./Layout.js";

export function Audit(p: {
  csrf: string;
  rows: AuditLog[];
  page: number;
  hasNext: boolean;
  base: string;
  flash?: { kind: "ok" | "bad" | "warn"; text: string } | null;
}) {
  return (
    <Layout title="Audit" csrf={p.csrf} flash={p.flash}>
      <h1>Audit log</h1>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>IP</th>
            <th>Metadata</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((a) => (
            <tr>
              <td>{formatET(a.createdAt)}</td>
              <td>
                {a.actorType}
                {a.actorId ? ` ${a.actorId}` : ""}
              </td>
              <td>
                <a href={`/admin/audit?action=${a.action}`}>{a.action}</a>
              </td>
              <td>{a.targetType ? `${a.targetType} ${a.targetId ?? ""}` : ""}</td>
              <td>{a.ip ?? ""}</td>
              <td>
                <pre>{a.metadata ? JSON.stringify(a.metadata, null, 2) : ""}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={p.page} hasNext={p.hasNext} base={p.base} />
      <h2>Maintenance</h2>
      <div class="card">
        <p class="muted">
          Retention runs automatically about once a day. It deletes old messages, finished doorbell jobs older than 30
          days, expired setup links, stale admin sessions, and old audit rows. Usage counters are kept.
        </p>
        <form method="post" action="/admin/maintenance/retention">
          <Csrf token={p.csrf} />
          <label class="inline">
            <input type="checkbox" name="confirm" value="yes" /> Yes, run the purge now
          </label>
          <button type="submit" class="danger">
            Run retention now
          </button>
        </form>
      </div>
    </Layout>
  );
}
