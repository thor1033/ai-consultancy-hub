# AI Hub

The deployment-ready product: a tailored AI hub where an organization runs its **Skills**,
**Agents**, and **MCPs** on the AI licenses it already pays for — backed by its own data,
context, and security.

> Business context, problem, and use cases live in the parent repo's `docs/`.
> This repo is the software.

## Stack

TypeScript everywhere · Next.js (App Router) + Tailwind · Claude Agent SDK · MCP SDK ·
Postgres/pgvector · Langfuse · Dockerized. See `docs/07-tech-stack.md` in the parent repo.

## Layout (npm-workspaces monorepo)

```
hub/
├── apps/
│   └── web/            # Next.js dashboard + API + agent endpoints
├── packages/           # shared TS libs (agent, mcp, db …) — added per "thing"
├── Dockerfile          # multi-stage → Next.js standalone runner
└── docker-compose.yml  # local stack (Postgres added in Thing 4/5)
```

## Develop

```bash
npm install          # install all workspaces
npm run dev          # http://localhost:3000
curl localhost:3000/api/health
```

## Docker

```bash
docker compose up --build
```

## Build roadmap (one thing at a time)

1. **Repo skeleton** — deployment-ready foundation ✅ (this)
2. Agent runtime core — Claude Agent SDK + Langfuse tracing
3. MCP layer — connect MCP servers + a sample server
4. Skill management — data model + create/list/run Skills
5. RAG / Memory — pgvector ingestion + retrieval
6. Security / AuthZ — stub auth + policy layer
7. Dashboard UI — Skills list + run view

A demo integration of the **investment-firm use case** comes after the MVP is complete.
