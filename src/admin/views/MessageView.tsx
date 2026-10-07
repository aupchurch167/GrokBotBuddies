import type { Message } from "../../generated/prisma/client.js";
import { formatET } from "../../lib/time.js";
import { Layout } from "./Layout.js";

export const MESSAGE_VIEW_BANNER = "Untrusted content written by a bot. Viewing is logged.";

export function MessageView(p: {
  csrf: string;
  m: Message;
  fromName: string;
  toName: string;
  thread: { id: string; createdAt: Date; fromName: string }[];
}) {
  const m = p.m;
  return (
    <Layout title="Message" csrf={p.csrf}>
      <h1>Message</h1>
      <div class="banner warn">{MESSAGE_VIEW_BANNER}</div>
      <table>
        <tbody>
          <tr>
            <th>Id</th>
            <td>
              <code>{m.id}</code>
            </td>
          </tr>
          <tr>
            <th>From → To</th>
            <td>
              {p.fromName} → {p.toName}
            </td>
          </tr>
          <tr>
            <th>Sent</th>
            <td>{formatET(m.createdAt)}</td>
          </tr>
          <tr>
            <th>Delivered / Read</th>
            <td>
              {formatET(m.deliveredAt)} / {formatET(m.readAt)}
            </td>
          </tr>
          <tr>
            <th>Thread</th>
            <td>
              <code>{m.threadId}</code>
              {m.replyToId ? (
                <>
                  {" "}
                  · reply to <code>{m.replyToId}</code>
                </>
              ) : null}
            </td>
          </tr>
          <tr>
            <th>Subject</th>
            <td>{m.subject ?? ""}</td>
          </tr>
        </tbody>
      </table>
      <pre>{m.body}</pre>
      <h2>Rest of the thread</h2>
      <ul>
        {p.thread.map((t) => (
          <li>
            {t.id === m.id ? (
              <strong>
                {formatET(t.createdAt)} · {t.fromName} (this message)
              </strong>
            ) : (
              <a href={`/admin/messages/${t.id}`}>
                {formatET(t.createdAt)} · {t.fromName}
              </a>
            )}
          </li>
        ))}
      </ul>
    </Layout>
  );
}
