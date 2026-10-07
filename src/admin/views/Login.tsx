import { Page } from "../../http/Page.js";
import { Csrf } from "./Layout.js";

export function Login(props: { csrf: string; email?: string; error?: string }) {
  return (
    <Page title="Log in · Bot Bridge admin">
      <h1>Bot Bridge admin</h1>
      <div class="card">
        {props.error ? <p class="banner bad">{props.error}</p> : null}
        <form method="post" action="/admin/login">
          <Csrf token={props.csrf} />
          <label for="email">Email</label>
          <input type="email" id="email" name="email" value={props.email ?? ""} required autocomplete="username" />
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password" />
          <button type="submit">Log in</button>
        </form>
      </div>
    </Page>
  );
}
