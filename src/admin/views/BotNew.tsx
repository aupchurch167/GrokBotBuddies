import { Csrf, Errors, Layout } from "./Layout.js";

export interface BotFormValues {
  name?: string;
  ownerName?: string;
  ownerEmail?: string;
  notes?: string;
  sendLimitPerHour?: string;
  mcpCallLimitPerHour?: string;
  deliverVia?: string;
}

export function BotFields(props: { v: BotFormValues }) {
  const v = props.v;
  return (
    <>
      <label for="name">Bot name (1–60 characters)</label>
      <input type="text" id="name" name="name" value={v.name ?? ""} required maxlength={60} />
      <label for="ownerName">Owner name</label>
      <input type="text" id="ownerName" name="ownerName" value={v.ownerName ?? ""} required maxlength={80} />
      <label for="ownerEmail">Owner email (optional)</label>
      <input type="email" id="ownerEmail" name="ownerEmail" value={v.ownerEmail ?? ""} maxlength={254} />
      <label for="notes">Notes (optional)</label>
      <textarea id="notes" name="notes" maxlength={1000} rows={3}>
        {v.notes ?? ""}
      </textarea>
      <label for="sendLimitPerHour">Messages per hour</label>
      <input type="number" id="sendLimitPerHour" name="sendLimitPerHour" value={v.sendLimitPerHour ?? "60"} min={1} max={10000} />
      <label for="mcpCallLimitPerHour">Tool calls per hour</label>
      <input
        type="number"
        id="mcpCallLimitPerHour"
        name="mcpCallLimitPerHour"
        value={v.mcpCallLimitPerHour ?? "600"}
        min={1}
        max={100000}
      />
    </>
  );
}

export function BotNew(props: { csrf: string; values?: BotFormValues; errors?: string[] }) {
  const v = props.values ?? {};
  const via = v.deliverVia ?? "setup_link";
  return (
    <Layout title="Add bot" csrf={props.csrf}>
      <h1>Add bot</h1>
      <div class="card">
        <Errors errors={props.errors} />
        <form method="post" action="/admin/bots">
          <Csrf token={props.csrf} />
          <BotFields v={v} />
          <label>How should the owner get the API key?</label>
          <p>
            <label class="inline">
              <input type="radio" name="deliverVia" value="setup_link" checked={via === "setup_link"} /> Setup link
              (recommended: the key travels only inside the link)
            </label>
          </p>
          <p>
            <label class="inline">
              <input type="radio" name="deliverVia" value="show_now" checked={via === "show_now"} /> Show the key to me
              now
            </label>
          </p>
          <button type="submit">Create bot</button>
        </form>
      </div>
    </Layout>
  );
}
