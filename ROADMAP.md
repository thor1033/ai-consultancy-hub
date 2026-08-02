# AI Hub — MVP Build Roadmap

The generic hub MVP is **complete** — all 7 things built and verified. The
**investment-firm demo** plus two post-MVP capabilities — **ROI reporting** and the
**Skillification capture loop** — are built and verified live against a real key.

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

## ✅ Investment-firm demo
The weekly client-presentation workflow: PowerPoint-template MCP, market-data MCP,
customer-data MCP; the `weekly-client-presentation` skill. Verified end to end with a
real ROI number (≈120 min manual → ~45s, ~$0.10). See parent repo
`docs/use-cases/investment-firm.md`.

## ✅ ROI / money-saved dashboard (docs/02)
`@ai-hub/db` `roiSummary` aggregates every run against its version baseline; `/roi`
prices saved time at a configurable `ANALYST_HOURLY_RATE` into a net-value readout —
the number directors couldn't previously produce.

## ✅ Skillification capture loop (docs/04)
`/workbench` runs a practitioner's real workflow once (with MCP tools), persists the
session, and distills it via Claude into a reusable, versioned Skill anyone can run.
Answers the capture-and-package open question in docs/06.

## ✅ AI Readiness Assessment (docs/02)
`/assessment` — a free, no-login questionnaire scoring AI-usage maturity + data
readiness (deterministic rubric), plus a Claude-generated opportunity report that
names what to skillify first and prices recoverable expert time at the analyst
rate. Each submission persists to `assessments` as a reviewable lead, and the
report links straight into `/workbench` — the top of the funnel into the paid hub.

## ✅ MCP / Skill control plane
`/admin` — an admin-gated console (verifies an `admin:manage` bearer token) to
enable/disable MCP servers and Skills. Enforced, not cosmetic: a disabled skill
can't run and drops off the catalog (`getRunnableSkill`/`listSkills`), and a
disabled MCP server is dropped from every run (session and skill). Servers get a
DB registry (`mcp_servers`) overlaying the code-owned runnable config; skills gain
an `enabled` switch. Each skill also shows *why it can be run* — the roles allowed
plus any explicit per-skill grants.

## Next candidates
- **Phase 2 hardening** — see below.

## Deferred to Phase 2 (per docs/07-tech-stack)
WorkOS SSO · OpenFGA engine · secrets manager · Docker-time migrations · dedicated
vector store · per-client MCP server registry.
