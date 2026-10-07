import type { DoorbellJob } from "../../generated/prisma/client.js";
import { formatET } from "../../lib/time.js";
import { Csrf, Layout, Pager } from "./Layout.js";

export function Doorbells(p: {
  csrf: string;
  counts: Record<string, number>;
  rows: (DoorbellJob & { botName: string })[];
  page: number;
  hasNext: boolean;
  base: string;
  flash?: { kind: "ok" | "bad" | "warn"; text: string } | null;
}) {
  return (
    <Layout title="Doorbells" csrf={p.csrf} flash={p.flash}>
      <h1>Doorbells</h1>
      <p>
        Last 24 h:{" "}
        {["PENDING", "SENDING", "RETRYING", "SENT", "FAILED", "CANCELLED"].map((s) => (
          <span class="badge">
            <a href={`/admin/doorbells?status=${s}`}>{s}</a> {p.counts[s] ?? 0}
          </span>
        ))}{" "}
        <a href="/admin/doorbells">all</a>
      </p>
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Bot</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Next attempt</th>
            <th>Last code</th>
            <th>Last error</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((j) => (
            <tr>
              <td>
                <code>{j.id}</code>
              </td>
              <td>
                <a href={`/admin/bots/${j.botId}`}>{j.botName}</a>
              </td>
              <td>{j.status}</td>
              <td>{j.attempts}</td>
              <td>{j.status === "PENDING" || j.status === "RETRYING" ? formatET(j.nextAttemptAt) : "–"}</td>
              <td>{j.lastStatusCode ?? "–"}</td>
              <td>{j.lastError ?? ""}</td>
              <td>{formatET(j.createdAt)}</td>
              <td>
                {j.status === "FAILED" ? (
                  <form method="post" action={`/admin/doorbells/${j.id}/retry`}>
                    <Csrf token={p.csrf} />
                    <button type="submit">Retry</button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={p.page} hasNext={p.hasNext} base={p.base} />
    </Layout>
  );
}
