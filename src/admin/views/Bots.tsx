import type { Bot, UsageCounter } from "../../generated/prisma/client.js";
import { displayPrefix } from "../../lib/apiKeys.js";
import { formatET, relative } from "../../lib/time.js";
import { Layout } from "./Layout.js";

export function DoorbellCell(props: { bot: Bot }) {
  const b = props.bot;
  if (b.doorbellState === "OK") return <span class="badge ok">OK</span>;
  if (b.doorbellState === "BROKEN") return <span class="badge bad">BROKEN: {b.lastDoorbellError ?? "unknown error"}</span>;
  return <span class="badge">not set</span>;
}

export function StatusBadge(props: { status: string }) {
  return <span class={`badge ${props.status === "ACTIVE" ? "ok" : "bad"}`}>{props.status.toLowerCase()}</span>;
}

export function Bots(props: {
  csrf: string;
  bots: Bot[];
  usage: Map<string, UsageCounter>;
  status: string;
  flash?: { kind: "ok" | "bad" | "warn"; text: string } | null;
}) {
  return (
    <Layout title="Bots" csrf={props.csrf} flash={props.flash}>
      <h1>Bots</h1>
      <p>
        <a class="btn" href="/admin/bots/new">
          Add bot
        </a>
      </p>
      <p>
        Show: <a href="/admin/bots?status=active">active</a> · <a href="/admin/bots?status=disabled">disabled</a> ·{" "}
        <a href="/admin/bots?status=all">all</a> <span class="muted">(showing {props.status})</span>
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Owner</th>
            <th>Status</th>
            <th>Key</th>
            <th>Last seen</th>
            <th>Doorbell</th>
            <th>This month: sent / received / tool calls / doorbells</th>
          </tr>
        </thead>
        <tbody>
          {props.bots.map((b) => {
            const u = props.usage.get(b.id);
            return (
              <tr>
                <td>
                  <a href={`/admin/bots/${b.id}`}>{b.name}</a>
                </td>
                <td>{b.ownerName}</td>
                <td>
                  <StatusBadge status={b.status} />
                </td>
                <td>
                  <code>{displayPrefix(b.apiKeyPrefix)}</code>
                </td>
                <td>
                  {relative(b.lastSeenAt)}
                  {b.lastSeenAt ? <span class="muted"> ({formatET(b.lastSeenAt)})</span> : null}
                </td>
                <td>
                  <DoorbellCell bot={b} />
                </td>
                <td>
                  {u?.messagesSent ?? 0} / {u?.messagesReceived ?? 0} / {u?.mcpCalls ?? 0} / {u?.doorbellsSent ?? 0}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {props.bots.length === 0 ? <p class="muted">No bots yet.</p> : null}
    </Layout>
  );
}
