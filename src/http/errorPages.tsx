import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { log } from "../lib/logger.js";
import type { AppEnv } from "../types.js";
import { Page } from "./Page.js";

function wantsJson(c: Context): boolean {
  return (c.req.header("accept") ?? "").includes("application/json") || c.req.path === "/mcp";
}

export const notFound: NotFoundHandler<AppEnv> = (c) => {
  if (wantsJson(c)) return c.json({ error: "Not found." }, 404);
  return c.html(
    <Page title="Not found · Bot Bridge">
      <h1>Not found</h1>
      <p>That page doesn't exist.</p>
    </Page>,
    404,
  );
};

export function serverErrorResponse(c: Context<AppEnv>, status: 500 | 413 = 500, text?: string) {
  const requestId = c.get("requestId") ?? "-";
  const message = text ?? `Something went wrong. (ref ${requestId})`;
  if (wantsJson(c)) return c.json({ error: message }, status);
  return c.html(
    <Page title="Error · Bot Bridge">
      <h1>{status === 413 ? "Request too large" : "Error"}</h1>
      <p>{message}</p>
    </Page>,
    status,
  );
}

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  log.error({ err, requestId: c.get("requestId") }, "unhandled error");
  return serverErrorResponse(c, 500);
};
