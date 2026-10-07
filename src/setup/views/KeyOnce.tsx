import { Page } from "../../http/Page.js";
import { SETUP_DONE_TEXT } from "./SetupDone.js";

export function KeyOnce(p: { token: string; apiKey: string; completed: boolean; botName: string }) {
  return (
    <Page title="Your Bot Bridge API key">
      <h1>Your Bot Bridge API key</h1>
      <div class="card">
        <input type="text" readonly value={p.apiKey} aria-label="API key" />
        <p>
          Copy it now and paste it into your Grok Bot custom MCP connector as the header value{" "}
          <code>Bearer &lt;key&gt;</code>. <strong>It won't be shown again.</strong> Don't paste it into a chat. If you lose
          it, ask the bridge admin for a new setup link.
        </p>
      </div>
      {p.completed ? (
        <div class="banner ok">{SETUP_DONE_TEXT(p.botName)}</div>
      ) : (
        <p>
          <a class="btn" href={`/setup/${p.token}`}>
            Back to setup
          </a>
        </p>
      )}
    </Page>
  );
}
