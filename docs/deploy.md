# Deploying the hub

The hub runs as a **container on Fly.io** against **Neon Postgres**. It is not a
serverless deployment, and that is deliberate: the hub spawns the stdio MCP
servers as child processes, holds a `postgres.js` TCP pool, runs the schedule
ticker in-process, and serves agent turns that outlive a typical function
timeout. `apps/web/src/app/api/agent/run/route.ts` sets `maxDuration = 60`, which
on a serverless host is a hard ceiling and here is not.

## What is already proven

Verified on 2026-08-29, before any host existed:

- `docker build -t ai-hub .` succeeds — 317MB final image.
- All six stdio servers, **including `servers/memory/server.mjs`**, are present at
  `/app/packages/mcp/servers/*/` in the image. This is the failure mode
  `next.config.ts` warns about: their paths are built at runtime, the tracer
  cannot follow them, and without `outputFileTracingIncludes` every agent would
  work in dev and silently lose its memory in production.
- The image boots and serves: `/api/health` 200, `/agents` 200 rendering a real
  agent from the database, `/mcp` 200 listing the registered servers.

## One-time setup

Both steps need a browser, so they are yours to run.

```bash
flyctl auth login
flyctl launch --no-deploy --copy-config --name teqneo-ai-hub --region ams
```

`--no-deploy` matters: the app must have its secrets and a migrated database
before it first serves traffic.

Then create a Neon project, enable the extension, and migrate. The migration runs
from your machine, not from the image — the runner stage carries only the
standalone server, not `migrate.mjs` or its dependencies.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

```bash
DATABASE_URL='<neon-pooled-url>' npm run migrate -w @ai-hub/db   # idempotent
```

Use Neon's **pooled** connection string. The hub opens an ordinary TCP pool
rather than Neon's HTTP driver.

## Secrets

```bash
flyctl secrets set \
  DATABASE_URL='postgresql://…neon…/aihub?sslmode=require' \
  ANTHROPIC_API_KEY='…' \
  VOYAGE_API_KEY='…' \
  HUB_API_TOKENS='{"…":{"id":"admin","roles":["admin"]}}' \
  HUB_BASE_URL='https://hub.teqneo.co' \
  PM_TOOL_MCP_TOKEN='…' \
  HUB_REMOTE_MCP_SERVERS='{"pm-tool":{"url":"https://pm.teqneo.co/api/mcp","label":"PM-tool","description":"Live project delivery data: projects, tasks, risks, scope.","tokenEnv":"PM_TOOL_MCP_TOKEN"}}'
```

Two of these fail **quietly** rather than loudly, which is why they are called
out rather than left to the reader:

- **`HUB_API_TOKENS` unset ⇒ every request is 401.** Fails closed by design. A
  deployment that 401s everything is almost always this.
- **`VOYAGE_API_KEY` unset ⇒ RAG drops to the hash-fallback embedder.** Ingest
  and retrieval both keep "working" and return nonsense. Nothing logs an error.

`HUB_BASE_URL` is the app's public origin, used to build redirects. It is
optional — `appBaseUrl()` falls back to the request's `x-forwarded-host` — but
set it anyway: behind Fly's proxy the standalone server resolves a request URL
to its own bind address (`HOSTNAME=0.0.0.0`, `PORT=3000`), and a redirect built
from that sends the user to `https://0.0.0.0:3000/`, which resolves for nobody.
Note it has no `NEXT_PUBLIC_` prefix on purpose: Next.js inlines those as
literals at **build** time, server code included, so a `NEXT_PUBLIC_*` read in
app code compiles to `undefined` in the Docker image and fails silently.

`PM_TOOL_MCP_TOKEN` is the same secret held in the PM-tool's Vercel
`PM_TOOL_MCP_TOKENS` map. Deploying the hub makes a third copy of it (the others
being `apps/web/.env.local` and Vercel), all rotated by hand.

## Deploy

```bash
flyctl deploy
```

## Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://teqneo-ai-hub.fly.dev/api/health     # 200
curl -s -o /dev/null -w '%{http_code}\n' https://teqneo-ai-hub.fly.dev/api/documents  # 401 without a token
```

Then, in a browser with a token: `/mcp` should show **pm-tool green with its 8
tools**, not merely present. A remote server renders from the `mcp_servers` table
even when its credential is missing — registered but `configured: false` — so
"pm-tool appears on the page" is not evidence the connection works. Finish with a
live agent turn against `{"servers":["pm-tool"]}` and a two-turn memory check.

## Known limits of this deployment

- **No tenancy.** There is no `org_id` anywhere in `schema.sql`, so one hub
  deployment maps to exactly one PM-tool org. Client #2 needs a second
  deployment or a schema change.
- **RAG retrieval has no principal filter.** Anyone who can authenticate can
  retrieve any indexed chunk. This is why the deployment is private to us.
- **`HUB_API_TOKENS` is a static-token MVP store**, not a secrets manager, and
  rotation means editing a JSON blob and redeploying.
