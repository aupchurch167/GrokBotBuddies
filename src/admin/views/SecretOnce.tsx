import { Layout } from "./Layout.js";

export const SECRET_ONCE_BANNER = "Copy this now. It won't be shown again. Refreshing this page will not show it again.";

export function SecretOnce(props: {
  csrf: string;
  title: string;
  label: string;
  value: string;
  botId: string;
  botName: string;
  mcpUrl?: string;
  note?: string;
}) {
  return (
    <Layout title={props.title} csrf={props.csrf}>
      <h1>{props.title}</h1>
      <div class="banner warn">{SECRET_ONCE_BANNER}</div>
      <div class="card">
        <label for="secret">{props.label} for "{props.botName}"</label>
        <input type="text" id="secret" readonly value={props.value} />
        {props.mcpUrl ? (
          <>
            <p>
              MCP connector URL: <code>{props.mcpUrl}</code>
            </p>
            <p>
              Header: <code>Authorization: Bearer &lt;the key above&gt;</code>
            </p>
          </>
        ) : null}
        {props.note ? <p class="muted">{props.note}</p> : null}
      </div>
      <p>
        <a href={`/admin/bots/${props.botId}`}>Back to bot</a>
      </p>
    </Layout>
  );
}
