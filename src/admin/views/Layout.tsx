import type { Child } from "hono/jsx";
import { Page } from "../../http/Page.js";

export function Csrf(props: { token: string }) {
  return <input type="hidden" name="_csrf" value={props.token} />;
}

export function Banner(props: { kind: "ok" | "bad" | "warn"; children?: Child }) {
  return <div class={`banner ${props.kind}`}>{props.children}</div>;
}

export function Errors(props: { errors?: string[] }) {
  if (!props.errors?.length) return null;
  return (
    <ul class="errors">
      {props.errors.map((e) => (
        <li>{e}</li>
      ))}
    </ul>
  );
}

export function Layout(props: { title: string; csrf: string; flash?: { kind: "ok" | "bad" | "warn"; text: string } | null; children?: Child }) {
  const nav = (
    <nav>
      <a href="/admin/bots">Bots</a>
      <a href="/admin/connections">Connections</a>
      <a href="/admin/messages">Messages</a>
      <a href="/admin/doorbells">Doorbells</a>
      <a href="/admin/usage">Usage</a>
      <a href="/admin/audit">Audit</a>
      <form method="post" action="/admin/logout">
        <Csrf token={props.csrf} />
        <button type="submit">Log out</button>
      </form>
    </nav>
  );
  return (
    <Page title={`${props.title} · Bot Bridge admin`} nav={nav}>
      {props.flash ? <Banner kind={props.flash.kind}>{props.flash.text}</Banner> : null}
      {props.children}
    </Page>
  );
}

export function Pager(props: { page: number; hasNext: boolean; base: string }) {
  const sep = props.base.includes("?") ? "&" : "?";
  return (
    <p>
      {props.page > 1 ? <a href={`${props.base}${sep}page=${props.page - 1}`}>← Newer</a> : null}{" "}
      {props.hasNext ? <a href={`${props.base}${sep}page=${props.page + 1}`}>Older →</a> : null}
    </p>
  );
}
