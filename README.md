# AI Hub

A private hub for the agents we actually run: standing **Agents** with durable memory, a
**knowledge base** they retrieve from, and the **MCP servers** they reach live systems
through — including our own PM-tool. It is also an MCP server itself, so Claude Code can
use the same knowledge and tools from the terminal.

> Business context, problem, and use cases live in the parent repo's `docs/`.
> This repo is the software.

## Stack

TypeScript everywhere · Next.js (App Router) + Tailwind · Anthropic SDK (hosted tool-use
loop) · MCP SDK · Postgres/pgvector · Voyage embeddings · WorkOS AuthKit · Dockerized,
deployed on Fly.io.

## Layout (npm-workspaces monorepo)

```
hub/
├── apps/
│   └── web/            # Next.js UI + REST API + the /api/mcp server endpoint
├── packages/
│   ├── agent/          # the Claude tool-use loop
│   ├── mcp/            # MCP client, remote registry, bundled stdio servers
│   ├── db/             # Postgres: agents, memories, sessions, documents, servers
│   ├── rag/            # pgvector ingest + retrieval, pluggable knowledge sources
│   └── authz/          # bearer principals + the policy engine
├── Dockerfile          # multi-stage → Next.js standalone runner
└── docker-compose.yml  # local Postgres (pgvector)
```

## What it does

- **Agents** (`/agents`) — a named worker with its own instructions, tool access and
  memory that survives between conversations.
- **Knowledge** (`/knowledge`) — documents indexed into pgvector, retrievable by agents
  and syncable from a source connector (PM-tool ships as one).
- **MCP servers** (`/mcp`) — what agents can reach. Remote servers are declared in
  `HUB_REMOTE_MCP_SERVERS`; the agent-scoped `memory` server is resolved in code.
  `microsoft365` gives the secretary agent read-only mail and calendar — it cannot
  send or change anything ([docs/secretary-agent.md](docs/secretary-agent.md)).
  `teams` reads Teams meeting transcripts and the team's SharePoint files, also
  read-only; `teams-notes` saves meeting notes as new files in one folder, and
  nothing else ([docs/teams.md](docs/teams.md)).
- **Agents anywhere** — every agent registers as `hub_agent_<slug>` in any MCP client,
  and its Skills as `hub_skill_<slug>` with real arguments, so work built in the hub runs
  from Claude Code, VS Code or Cursor ([docs/agents-anywhere.md](docs/agents-anywhere.md)).
- **Local agents** — set an agent to run locally (or both) and it is synced into Claude
  Code as a sub-agent with its skills; its tools, memory and knowledge stay behind a
  per-agent hub endpoint that checks every call ([docs/local-agents.md](docs/local-agents.md)).
  A colleague gets the whole setup with one command ([docs/claude-code-setup.md](docs/claude-code-setup.md)).
- **Sign in once** — add the hub to Claude Code, sign in in the browser, and the hub's
  knowledge, agents, skills *and the PM-tool* work as you: the first sign-in from the company
  domain provisions the account, and the hub forwards your own token to the PM-tool instead
  of its machine token ([docs/auth.md](docs/auth.md), "Signing in once").
- **Schedules** — an agent on a clock: `every N minutes`, or daily at a local
  time on chosen weekdays. Runs execute as the principal who owns the schedule,
  so an unattended run has exactly the reach of the person who asked for it.
  Off unless `HUB_SCHEDULER=1` ([docs/schedules.md](docs/schedules.md)).
- **Decks** (`/decks`) — presentations drawn in the Teqneo design that change while you
  present: a question from the room becomes a slide in the presenter's tray, and goes on
  screen when they say so. Built here or from Claude Code (`hub_deck_*`), exported as PDF
  ([docs/decks.md](docs/decks.md)).
- **Approvals** (`/approvals`) — no agent writes unattended. A tool call that would
  change something is held, shown to a person with its exact arguments, and run only
  when they approve ([docs/approvals.md](docs/approvals.md)).
- **Control plane** (`/admin`) — people, credentials and the audit trail; which shared
  drives each person may open ([docs/knowledge-access.md](docs/knowledge-access.md));
  and enabling or disabling registered servers.
- **`/api/mcp`** — the hub exposed *as* an MCP server, so Claude Code can search the
  knowledge base from anywhere. An OAuth 2.1 protected resource with WorkOS AuthKit
  as the authorization server, so any MCP client can enrol it; credentials issued
  from `/admin` cover clients that cannot do OAuth. See [docs/auth.md](docs/auth.md).

## Develop

```bash
docker compose up -d db                      # local Postgres (pgvector)
npm install
npm run migrate -w @ai-hub/db                # idempotent
npm run dev                                  # http://localhost:3000
curl localhost:3000/api/health
```

`apps/web/.env.local` needs `DATABASE_URL`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`
and the `WORKOS_*` set — AuthKit throws on every request, `/api/*` included, when
those are missing. Add `WORKOS_AUTHKIT_DOMAIN` and `HUB_MCP_RESOURCE` to turn on
OAuth; `HUB_API_TOKENS` still resolves but is deprecated ([docs/auth.md](docs/auth.md)).

## Deploy

See `docs/deploy.md`. Fly.io + Neon; `flyctl deploy` from this directory.

## History

The hub previously carried a versioned **Skill** system, an ROI dashboard, a
skillification workbench, a lead-gen assessment, and a PowerPoint studio. All were removed
once agents proved to be the unit of work that survived real use. `packages/db/drop-legacy.sql`
drops their tables; it is deliberately not run by `migrate`.
