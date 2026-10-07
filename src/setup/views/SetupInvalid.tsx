import { Page } from "../../http/Page.js";

export const SETUP_INVALID_REST =
  "It may have expired, been used already, or been replaced. Ask the bridge admin to send you a new one.";

export function SetupInvalid() {
  return (
    <Page title="Setup link not valid">
      <h1>This setup link isn't valid.</h1>
      <p>{SETUP_INVALID_REST}</p>
    </Page>
  );
}
