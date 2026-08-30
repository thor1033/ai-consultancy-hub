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
- **Control plane** (`/admin`) — enable, disable or delete registered servers.
- **`/api/mcp`** — the hub exposed *as* an MCP server, so Claude Code can search the
  knowledge base from anywhere. Bearer auth via `HUB_API_TOKENS`.

## Develop

```bash
docker compose up -d db                      # local Postgres (pgvector)
npm install
npm run migrate -w @ai-hub/db                # idempotent
npm run dev                                  # http://localhost:3000
curl localhost:3000/api/health
```

`apps/web/.env.local` needs `DATABASE_URL`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
`HUB_API_TOKENS`, and the `WORKOS_*` set — AuthKit throws on every request, `/api/*`
included, when those are missing.

## Deploy

See `docs/deploy.md`. Fly.io + Neon; `flyctl deploy` from this directory.

## History

The hub previously carried a versioned **Skill** system, an ROI dashboard, a
skillification workbench, a lead-gen assessment, and a PowerPoint studio. All were removed
once agents proved to be the unit of work that survived real use. `packages/db/drop-legacy.sql`
drops their tables; it is deliberately not run by `migrate`.
