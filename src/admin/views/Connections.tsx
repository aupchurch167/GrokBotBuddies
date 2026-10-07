import type { Bot, Connection } from "../../generated/prisma/client.js";
import { formatET } from "../../lib/time.js";
import { Csrf, Errors, Layout } from "./Layout.js";

export function Connections(p: {
  csrf: string;
  bots: Bot[];
  rows: (Connection & { botA: Bot; botB: Bot; messageCount: number })[];
  status: string;
  errors?: string[];
  values?: { botX?: string; botY?: string; note?: string };
  flash?: { kind: "ok" | "bad" | "warn"; text: string } | null;
}) {
  const v = p.values ?? {};
  const options = (selected?: string) =>
    p.bots.map((b) => (
      <option value={b.id} selected={b.id === selected}>
        {b.name} ({b.ownerName}){b.status === "DISABLED" ? " [disabled]" : ""}
      </option>
    ));
  return (
    <Layout title="Connections" csrf={p.csrf} flash={p.flash}>
      <h1>Connections</h1>
      <div class="card">
        <h2>Approve a pair</h2>
        <Errors errors={p.errors} />
        <form method="post" action="/admin/connections">
          <Csrf token={p.csrf} />
          <label for="botX">Bot</label>
          <select id="botX" name="botX">
            <option value="">Choose…</option>
            {options(v.botX)}
          </select>
          <label for="botY">Bot</label>
          <select id="botY" name="botY">
            <option value="">Choose…</option>
            {options(v.botY)}
          </select>
          <label for="note">Note (optional)</label>
          <input type="text" id="note" name="note" maxlength={500} value={v.note ?? ""} />
          <button type="submit">Approve connection</button>
        </form>
      </div>
      <p>
        Show: <a href="/admin/connections?status=active">active</a> · <a href="/admin/connections?status=revoked">revoked</a> ·{" "}
        <a href="/admin/connections?status=all">all</a> <span class="muted">(showing {p.status})</span>
      </p>
      <table>
        <thead>
          <tr>
            <th>Pair</th>
            <th>Status</th>
            <th>Approved</th>
            <th>Revoked</th>
            <th>Note</th>
            <th>Messages</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((c) => (
            <tr>
              <td>
                <a href={`/admin/bots/${c.botA.id}`}>{c.botA.name}</a> ↔ <a href={`/admin/bots/${c.botB.id}`}>{c.botB.name}</a>
              </td>
              <td>{c.status.toLowerCase()}</td>
              <td>{formatET(c.approvedAt)}</td>
              <td>{formatET(c.revokedAt)}</td>
              <td>{c.note ?? ""}</td>
              <td>{c.messageCount}</td>
              <td>
                {c.status === "ACTIVE" ? (
                  <form method="post" action={`/admin/connections/${c.id}/revoke`}>
                    <Csrf token={p.csrf} />
                    <label class="inline">
                      <input type="checkbox" name="confirm" value="yes" /> confirm
                    </label>{" "}
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
    </Layout>
  );
}
