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
