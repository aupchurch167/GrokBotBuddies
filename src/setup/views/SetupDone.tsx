import { Page } from "../../http/Page.js";

export const SETUP_DONE_REST = (botName: string) =>
  `"${botName}" can now use Bot Bridge, and its doorbell works. You can close this page. This link no longer works.`;
export const SETUP_DONE_TEXT = (botName: string) => `You're connected. ${SETUP_DONE_REST(botName)}`;

export function SetupDone(p: { botName: string; banner?: string }) {
  return (
    <Page title="You're connected">
      {p.banner ? <div class="banner ok">{p.banner}</div> : null}
      <h1>You're connected.</h1>
      <p>{SETUP_DONE_REST(p.botName)}</p>
    </Page>
  );
}
