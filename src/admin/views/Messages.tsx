import { formatET } from "../../lib/time.js";
import { Layout, Pager } from "./Layout.js";

export interface MessageRow {
  id: string;
  createdAt: Date;
  fromName: string;
  toName: string;
  subject: string | null;
  bodyLength: number;
  threadId: string;
  deliveredAt: Date | null;
  readAt: Date | null;
}

/** Metadata only: message bodies never appear on this page. */
export function Messages(p: { csrf: string; rows: MessageRow[]; page: number; hasNext: boolean; base: string; filter: string }) {
  return (
    <Layout title="Messages" csrf={p.csrf}>
      <h1>Messages</h1>
      {p.filter ? <p class="muted">Filtered: {p.filter} · <a href="/admin/messages">clear</a></p> : null}
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>From → To</th>
            <th>Subject</th>
            <th>Length</th>
            <th>Thread</th>
            <th>Delivered</th>
            <th>Read</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((m) => (
            <tr>
              <td>{formatET(m.createdAt)}</td>
              <td>
                {m.fromName} → {m.toName}
              </td>
              <td>{m.subject ? [...m.subject].slice(0, 80).join("") : ""}</td>
              <td>{m.bodyLength}</td>
              <td>
                <code>…{m.threadId.slice(-6)}</code>
              </td>
              <td>{m.deliveredAt ? "✓" : "–"}</td>
              <td>{m.readAt ? "✓" : "–"}</td>
              <td>
                <a href={`/admin/messages/${m.id}`}>View</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.rows.length === 0 ? <p class="muted">No messages.</p> : null}
      <Pager page={p.page} hasNext={p.hasNext} base={p.base} />
    </Layout>
  );
}
