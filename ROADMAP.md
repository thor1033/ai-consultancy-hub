# AI Hub — MVP Build Roadmap

The generic hub MVP is **complete** — all 7 things built and verified. Next up is a
demo integration of the **investment-firm use case** on top of it.

Status: ✅ done

---

## ✅ Thing 1 — Repo skeleton (deployment-ready)
npm-workspaces monorepo (Turborepo) · Next.js 15 / TS / Tailwind · `/api/health` ·
multi-stage Dockerfile → standalone runner. Docker image builds + boots.

## ✅ Thing 2 — Agent runtime core
`@ai-hub/agent` — Claude Agent tool-use loop (Anthropic SDK), Opus 4.8, adaptive
thinking, prompt caching, Langfuse tracing + per-turn cost/latency (the ROI substrate).

## ✅ Thing 3 — MCP layer
`@ai-hub/mcp` — connect MCP servers, expose their tools to the agent, proxy calls.
Bundled sample stdio server; loop verified end to end.

## ✅ Thing 4 — Skill management
`@ai-hub/db` (Postgres) — skills · versions · runs. `runSkill` ties skill → MCP →
agent → recorded run with ROI. REST API for create/list/version/run.

## ✅ Thing 5 — RAG / Memory
`@ai-hub/rag` — pgvector ingestion + retrieval, Voyage embeddings behind a swappable
interface (dev fallback). Retrieval injected into agent/skill runs as context.

## ✅ Thing 6 — Security / AuthZ
`@ai-hub/authz` — token auth (WorkOS seam) + owned PolicyEngine (OpenFGA seam):
role + resource-level per-skill grants. Fails closed. Every sensitive route guarded.

## ✅ Thing 7 — Dashboard UI
Skills grid + per-skill run view with a RAG toggle and the ROI readout (manual
baseline vs actual cost/latency). Server components + a server action.

---

## Next — Investment-firm demo
The weekly/monthly client-presentation workflow: PowerPoint-template MCP, market-data
MCP, customer-data MCP; an analyst skill; a real ROI number. See parent repo
`docs/use-cases/investment-firm.md`.

## Deferred to Phase 2 (per docs/07-tech-stack)
WorkOS SSO · OpenFGA engine · secrets manager · Docker-time migrations · dedicated
vector store · per-client MCP server registry.
