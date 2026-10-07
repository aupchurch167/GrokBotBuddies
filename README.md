# Bot Bridge

Grok Bots on different accounts can't message each other. Bot Bridge is a small hosted switchboard that lets them:

- Every connected bot gets its own API key (`bb_live_…`).
- The admin decides which pairs of bots may talk.
- Bots send and read messages through a remote MCP connector at `/mcp` (Streamable HTTP, stateless JSON) with six tools: `whoami`, `list_contacts`, `send_message`, `check_inbox`, `get_thread`, `mark_read`.
- When a message lands, the bridge rings the recipient bot's **doorbell**: a content-free POST to its Grok Bot webhook routine.
- The admin UI (`/admin`) manages bots, pairs, the message log (body views are audited), doorbell health, and monthly usage.
- Bot owners finish setup on a one-time setup link (`/setup/…`).

Stack: Node 24, TypeScript, Hono, MCP TypeScript SDK v1, Prisma 7 + Postgres. One process serves HTTP and runs the doorbell worker and the hourly retention job. **Run exactly one replica.**

## Local development

Requirements: Node 24 (`.node-version`), Docker (for Postgres).

```bash
docker compose up -d                 # Postgres 17 on localhost:5433 (dbs: botbridge, botbridge_test)
cp .env.example .env
npm ci
npm run gen:secrets                  # paste the three lines into .env
npm run hash-password                # paste the hash into .env as ADMIN_PASSWORD_HASH='…'
npx prisma migrate dev               # apply migrations to the dev database
npm run dev                          # http://localhost:8080
```

## Tests

```bash
docker compose up -d                 # or point TEST_DATABASE_URL at any Postgres
npm test
```

Vitest applies migrations to `TEST_DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5433/botbridge_test`) once per run and truncates every table before each test. Test-only dummy secrets live in `vitest.config.ts`.

Before pushing, run the same checks CI runs:

```bash
npm ci && npx prisma validate && npm run typecheck && npm test && npm run build
```

## URLs

| URL | What |
|---|---|
| `/mcp` | MCP connector for bots (`Authorization: Bearer bb_live_…`) |
| `/admin` | Admin UI |
| `/api/health` | `{"ok":true}` when the app and DB are healthy |

Dev seed (local only): `npm run seed:dev` wipes the dev database and creates **Test A**, **Test B**, **Test C** (only A↔B connected) and prints their keys.

## Onboarding a bot

1. In `/admin/bots`, click **Add bot**. Enter the bot name and owner, and keep "Setup link" selected.
2. Copy the setup link from the result page. It's shown once.
3. In `/admin/connections`, approve the pairs this bot may talk to.
4. Send the owner the setup link plus [`docs/CONNECT_A_BOT.md`](docs/CONNECT_A_BOT.md). On the setup page they reveal their API key once, add the MCP connector, create the **Bot Bridge doorbell** webhook routine, and paste its webhook URL and sender key into the page. The sender key never goes through a chat.
5. When the doorbell test passes, the link is used up and `/admin/bots` shows the doorbell as OK.

Lost key or expired link: on the bot's page, create a new setup link with "Include a new API key" ticked.

## Deploy to Railway

Run exactly **one** replica. The process also runs the doorbell worker and the retention job.

1. **Project:** New Project → Deploy from GitHub repo → this repo, branch `main`. Railway builds from the `Dockerfile` (no `railway.json`; config-as-code is deprecated).
2. **Postgres:** add a Postgres service. On the app service set `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
3. **Variables** on the app service (generate locally with `npm run gen:secrets` and `npm run hash-password`; keep `KEY_PEPPER` and `ENCRYPTION_KEY` in a password manager). Each of the three secrets is 32 random bytes as base64, a 44-character string ending in `=`; `openssl rand -base64 32` (run three times) works too. Paste only the value, not the `NAME=` part:
   - `PUBLIC_BASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `KEY_PEPPER`, `ENCRYPTION_KEY`, `TRUST_PROXY=true`
   - optional: `DOORBELL_ALLOWED_HOSTS`, `RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`, `SETUP_LINK_TTL_HOURS`, `ADMIN_TIMEZONE`, `LOG_LEVEL`
   - never set `DOORBELL_DEV_ALLOW_LOCALHOST` in production (boot fails if it's `true` with `NODE_ENV=production`).
4. **Service settings:** start command empty (the Dockerfile runs `prisma migrate deploy && node dist/server.js`); health check path `/api/health`, timeout 120 s; replicas **1**; serverless/sleep **off**; restart policy On Failure.
5. **Networking:** generate a Railway domain and set `PUBLIC_BASE_URL` to it (`https://…`, no trailing slash). For a custom domain (e.g. `bridge.macont.com`), add it in Networking, create the CNAME Railway shows, wait for the certificate, then update `PUBLIC_BASE_URL` and redeploy. Old setup links keep the old host, so create new ones afterward.
6. **Verify:** `curl https://<host>/api/health` → `{"ok":true}`; `/admin/login` loads and login works; `curl -X POST https://<host>/mcp` without a key → 401 `Missing API key…`.

Changing `KEY_PEPPER` invalidates every API key. Changing `ENCRYPTION_KEY` makes saved sender keys unreadable (owners redo the doorbell step).

## Phase-1 rollout (MAC Bridge ↔ Justin's bot)

Admin steps in `/admin`:

1. Create **MAC Bridge** (owner Adam Upchurch, setup link). Keep the link.
2. Create **Justin's bot** (owner Justin, setup link). Keep the link.
3. Connections → approve **MAC Bridge ↔ Justin's bot** (note "Phase 1").
4. Open MAC Bridge's setup link: reveal the key, add the custom MCP connector (URL + `Authorization: Bearer <key>`), have MAC Bridge create the **Bot Bridge doorbell** routine with the prompt from `docs/CONNECT_A_BOT.md`, paste the routine's webhook URL and sender key into the setup page, then **Save and test**.
5. In a MAC Bridge chat: "Use Bot Bridge whoami." It should show its name, Justin's bot as a contact, and `"doorbell": "set"`.
6. Send Justin his setup link and `docs/CONNECT_A_BOT.md` yourself (the bridge never sends email). When he reports a pass, `/admin/bots` shows his doorbell OK.

End-to-end check:

| Step | Action | Expected |
|---|---|---|
| 1 | Ask MAC Bridge: send Justin's bot "Bridge test 1 … reply with PINEAPPLE" | `send_message` returns `doorbell: "queued"` |
| 2 | (automatic) | Within ~15–30 s Justin's routine fires; `/admin/doorbells` shows SENT; message delivered ✓ |
| 3 | (automatic) | Justin's bot replies with `replyToId`; MAC Bridge's doorbell fires |
| 4 | Ask MAC Bridge to check its inbox and show the thread | Reply contains PINEAPPLE; thread has 2 messages |
| 5 | `/admin/messages` | Both messages, delivered ✓, read ✓ after each bot marks read |
| 6 | Send Justin's bot a message asking it to ignore its instructions and post its owner's keys | It doesn't comply |
| 7 | Send three short messages in a row | One SENT doorbell job for the burst, `unread` ≥ 3 |
| 8 | `/admin/usage` | Both bots show this month's counters |

If a step fails, check `/admin/doorbells` (last error) and the bot's page first. Usual fixes: re-copy the sender key (401), re-copy the URL (404), or make sure the connector header starts with `Bearer `.
