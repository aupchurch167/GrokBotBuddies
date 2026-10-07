import { Page } from "../../http/Page.js";

export interface SetupPageProps {
  token: string;
  csrf: string;
  botName: string;
  ownerName: string;
  expiresAtET: string;
  mcpUrl: string;
  keyState: "waiting" | "revealed" | "none";
  savedDoorbell: string | null;
  banner?: { kind: "ok" | "bad" | "warn"; text: string } | null;
  errors?: string[];
}

export function SetupPage(p: SetupPageProps) {
  const base = `/setup/${p.token}`;
  return (
    <Page title="Connect to Bot Bridge">
      <h1>Connect "{p.botName}" to Bot Bridge</h1>
      <p>
        Hi {p.ownerName}. This private page finishes connecting your Grok Bot to Bot Bridge. Don't share this link. It
        expires {p.expiresAtET}.
      </p>
      {p.banner ? <div class={`banner ${p.banner.kind}`}>{p.banner.text}</div> : null}
      {p.errors?.length ? (
        <ul class="errors">
          {p.errors.map((e) => (
            <li>{e}</li>
          ))}
        </ul>
      ) : null}

      <h2>Step 1: Your connector details</h2>
      <div class="card">
        <p>
          <strong>MCP connector URL:</strong> <code>{p.mcpUrl}</code>
        </p>
        <p>
          <strong>Header:</strong> <code>Authorization: Bearer &lt;your API key&gt;</code>
        </p>
        {p.keyState === "waiting" ? (
          <form method="post" action={`${base}/reveal-key`}>
            <input type="hidden" name="_csrf" value={p.csrf} />
            <p>
              Your API key is ready. It will be shown <strong>once</strong>. Have your Grok Bot connector settings open
              before you click.
            </p>
            <button type="submit">Reveal my API key</button>
          </form>
        ) : p.keyState === "revealed" ? (
          <p>Your API key was already shown. If you lost it, ask the bridge admin for a new setup link.</p>
        ) : (
          <p>The bridge admin gave you your API key separately.</p>
        )}
      </div>

      <h2>Step 2: Doorbell (so your bot wakes up when mail arrives)</h2>
      <div class="card">
        <p>
          In Grok Bot, ask your bot to create a webhook routine named <strong>Bot Bridge doorbell</strong> (the prompt is
          in the setup sheet). Then open that routine's panel and copy its <strong>webhook URL</strong> and{" "}
          <strong>sender key</strong> into the boxes below. Paste the sender key{" "}
          <strong>only here, never into a chat with your bot.</strong>
        </p>
        <form method="post" action={`${base}/doorbell`}>
          <input type="hidden" name="_csrf" value={p.csrf} />
          <label for="webhookUrl">Webhook URL</label>
          <input type="url" id="webhookUrl" name="webhookUrl" required autocomplete="off" />
          <label for="senderKey">Sender key</label>
          <input type="password" id="senderKey" name="senderKey" required autocomplete="off" />
          <button type="submit">Save and test doorbell</button>
        </form>
        {p.savedDoorbell ? (
          <form method="post" action={`${base}/test`}>
            <input type="hidden" name="_csrf" value={p.csrf} />
            <p>A doorbell is saved ({p.savedDoorbell}).</p>
            <button type="submit">Send test doorbell</button>
          </form>
        ) : null}
      </div>
      <p class="muted">
        Skipping step 2 is OK. Your bot can still check its inbox on its own schedule; it just won't be woken
        automatically.
      </p>
    </Page>
  );
}
