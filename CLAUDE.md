# CLAUDE.md

Guidance for Claude Code in this repo. Product overview and env setup are in
[README.md](README.md); design notes per feature are in [docs/](docs/).

## What this is

AI Hub: standing **agents** (instructions + tools + durable memory), a pgvector
**knowledge base**, and the **MCP servers** agents reach live systems through. The
hub is also an MCP server itself (`/api/mcp`, OAuth 2.1 via WorkOS AuthKit).

npm-workspaces + Turborepo monorepo, TypeScript throughout:

- `apps/web` — Next.js 15 App Router + Tailwind 4. UI, REST API, `/api/mcp`,
  the scheduler (`src/lib/scheduler.ts`, started from `src/instrumentation.ts`).
- `packages/agent` — the Anthropic tool-use loop (`runAgent.ts`), models, tracing.
- `packages/mcp` — MCP client/manager, remote (Streamable HTTP) registry, bundled
  stdio servers in `servers/` (e.g. `memory`, `microsoft365`, `teams`).
- `packages/db` — Postgres access; schema in `schema.sql`, applied by `migrate.mjs`.
  Agents that live in code are seeded from `src/seeds/*` (`seed:secretary`, `seed:product-owner`,
  `seed:project-manager`, `seed:context-steward`).
- `packages/rag` — ingest, chunking, Voyage embeddings, principal-aware retrieval.
- `packages/authz` — bearer principals, OAuth, credentials, policy engine.

Packages export raw `./src/index.ts` (no build step); Next bundles them. Package
names are `@ai-hub/<name>`.

## Commands

Node **22** is required (`.nvmrc`). The verify scripts use `registerHooks` and
`--experimental-transform-types`, which do not exist on older Node.

```bash
docker compose up -d db              # local Postgres + pgvector
npm install
npm run migrate -w @ai-hub/db        # idempotent; re-run after editing schema.sql (production runs it on every release)
npm run dev                          # http://localhost:3000
npm run build                        # turbo build — the only check that catches bundling errors
npm run lint
npm run typecheck --workspaces --if-present
```

`npm run typecheck` passing is **not** enough: edge-runtime bundling problems
(e.g. Node builtins pulled into the AuthKit middleware / instrumentation edge
bundle) only show up in `npm run build`. Run the build after touching imports in
`apps/web`, especially anything reachable from `instrumentation.ts` or `middleware.ts`.

## Verification

There is no test framework. Each package has `verify-*.mjs` scripts — real code
paths against throwaway fixtures (fake Messages API / Graph / MCP servers), with no
API spend. Each script's header comment says how to run it and what it needs.
Run them with the package script, e.g. `npm run verify:loop -w @ai-hub/agent`.

- No DB needed: `verify:loop` (agent), `verify:remote`, `verify:m365`, `verify:teams` (mcp),
  `verify:github` (rag; its sync half runs when `DATABASE_URL` is set), `verify:large-args`,
  `verify:work-log` (web).
- Need `DATABASE_URL` + a migrated DB: `verify:agents`, `verify:schedules` (db),
  `verify:memory`, `verify:knowledge` (mcp), `verify:access` (rag), `verify:credentials` (authz),
  `verify:hub-memory`, `verify:agent-tools`, `verify:scheduler` (web).
- `verify:pm-tool` talks to the real PM-tool endpoint — don't run it casually.

When adding behaviour, extend or add a verify script in the same style: drive the
shipping code path, create and delete its own fixtures, and report what it could
not prove rather than faking a pass.

## Env

Local config lives in `apps/web/.env.local` (template: `.env.example`). AuthKit
throws on every request, `/api/*` included, without the `WORKOS_*` set. Never
commit or print `.env*` files; `*.bak` is gitignored because backups held secrets.

## Conventions

- Match the surrounding style: explanatory comments that say *why*, especially
  around security and failure modes. Fail closed (e.g. malformed
  `HUB_REMOTE_MCP_SERVERS` ⇒ no remote servers).
- Authorization is structural: scheduled runs execute as the owning principal;
  retrieval filters by principal on every read path; the secretary's M365 access
  is read-only by construction. Don't widen these without being asked.
- Failures must surface in the output a person reads — never return an empty or
  truncated agent answer as success.
- Schema changes go in `packages/db/schema.sql` and must stay idempotent
  (`create … if not exists`, guarded `alter`). `drop-legacy.sql` is deliberately
  not run by migrate.
- Commit messages: imperative, plain-English subject; body explains what
  happened, why, what was verified, and what was deliberately left out.

## Deploy — be careful

Every push to `master` deploys to production on Fly.io (`.github/workflows/deploy.yml`,
app `teqneo-ai-hub`, health-checked at `https://hub.teqneo.co/api/health`). Work on a
branch, and only push to `master` when explicitly asked. Details: [docs/deploy.md](docs/deploy.md).
