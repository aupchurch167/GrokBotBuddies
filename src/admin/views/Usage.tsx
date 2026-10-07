import { Layout } from "./Layout.js";

export interface UsageRow {
  botId: string;
  name: string;
  messagesSent: number;
  messagesReceived: number;
  mcpCalls: number;
  doorbellsSent: number;
  doorbellsFailed: number;
}

export function Usage(p: { csrf: string; month: string; rows: UsageRow[] }) {
  const total = p.rows.reduce(
    (t, r) => ({
      messagesSent: t.messagesSent + r.messagesSent,
      messagesReceived: t.messagesReceived + r.messagesReceived,
      mcpCalls: t.mcpCalls + r.mcpCalls,
      doorbellsSent: t.doorbellsSent + r.doorbellsSent,
      doorbellsFailed: t.doorbellsFailed + r.doorbellsFailed,
    }),
    { messagesSent: 0, messagesReceived: 0, mcpCalls: 0, doorbellsSent: 0, doorbellsFailed: 0 },
  );
  return (
    <Layout title="Usage" csrf={p.csrf}>
      <h1>Usage</h1>
      <form method="get" action="/admin/usage">
        <label for="month">Month (UTC)</label>
        <input type="month" id="month" name="month" value={p.month} />
        <button type="submit">Show</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Bot</th>
            <th>Messages sent</th>
            <th>Received</th>
            <th>Tool calls</th>
            <th>Doorbells sent</th>
            <th>Doorbells failed</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr>
              <td>
                <a href={`/admin/bots/${r.botId}`}>{r.name}</a>
              </td>
              <td>{r.messagesSent}</td>
              <td>{r.messagesReceived}</td>
              <td>{r.mcpCalls}</td>
              <td>{r.doorbellsSent}</td>
              <td>{r.doorbellsFailed}</td>
            </tr>
          ))}
          <tr>
            <th>Total</th>
            <th>{total.messagesSent}</th>
            <th>{total.messagesReceived}</th>
            <th>{total.mcpCalls}</th>
            <th>{total.doorbellsSent}</th>
            <th>{total.doorbellsFailed}</th>
          </tr>
        </tbody>
      </table>
    </Layout>
  );
}
