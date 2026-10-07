import type { Child } from "hono/jsx";

export const STYLE = `
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#1d2330;background:#f6f7f9}
main{max-width:1100px;margin:0 auto;padding:20px}h1{font-size:1.5rem;margin:.4em 0}h2{font-size:1.15rem;margin:1.4em 0 .4em}
a{color:#1f5fbf}table{border-collapse:collapse;width:100%;background:#fff;margin:.5em 0}th,td{border:1px solid #dde1e7;padding:6px 8px;text-align:left;vertical-align:top;font-size:.92rem}
th{background:#eef1f5}nav{background:#1d2330;padding:10px 20px}nav a,nav button{color:#fff;margin-right:14px;text-decoration:none;background:none;border:0;font:inherit;cursor:pointer;padding:0}
nav form{display:inline}.card{background:#fff;border:1px solid #dde1e7;border-radius:6px;padding:14px 18px;margin:12px 0}
label{display:block;margin:.5em 0 .2em;font-weight:600}input[type=text],input[type=email],input[type=password],input[type=number],input[type=url],select,textarea{width:100%;max-width:520px;padding:6px 8px;border:1px solid #b9c0cb;border-radius:4px;font:inherit}
input[readonly]{background:#f2f4f7;font-family:ui-monospace,Menlo,monospace}button,.btn{background:#1f5fbf;color:#fff;border:0;border-radius:4px;padding:7px 14px;font:inherit;cursor:pointer;margin-top:8px}
button.danger{background:#b3261e}.inline{display:inline}.inline button{margin:0}.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:.8rem;background:#e3e7ee}
.ok{background:#d6f0dc}.bad{background:#f8d7d5}.warn{background:#fff1c2}.banner{padding:10px 14px;border-radius:6px;margin:12px 0;border:1px solid}
.banner.ok{border-color:#9bd3a9}.banner.bad{border-color:#e6a19c}.banner.warn{border-color:#e6cf7a}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #dde1e7;padding:12px;border-radius:6px}
code{font-family:ui-monospace,Menlo,monospace;background:#eef1f5;padding:1px 4px;border-radius:3px}.muted{color:#5d6675}ul.errors{color:#b3261e}
`;

export function Page(props: { title: string; nav?: Child; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <style>{STYLE}</style>
      </head>
      <body>
        {props.nav}
        <main>{props.children}</main>
      </body>
    </html>
  );
}
