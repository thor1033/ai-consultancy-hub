# Knowledge / RAG — direction and plan

## The decision

The hub should give each capability (RAG/knowledge, memory, MCP, agents) a
**management surface** — the same pattern as the `/admin` control plane. For
knowledge specifically, we deliberately split the idea in two and only pursue one
half aggressively:

- **Build: observability + curation.** Make it obvious *what* the RAG knows and
  *what context an agent actually retrieved on a run*. Let a human curate and
  scope that knowledge. This is underinvested, cheap (the data mostly already
  flows), and it is what makes retrieval trustworthy enough to act on.
- **Resist: becoming a data-integration platform.** "Connect Confluence + SharePoint,
  scrape every PowerPoint/Excel/Word, index it all into one big RAG" is a treadmill
  a boutique consultancy cannot win against Glean / Copilot / LlamaIndex. More data
  ≠ better retrieval — a giant undifferentiated index buries the relevant chunk and
  creates a permissions/governance liability. Curated, *scoped* knowledge per
  agent beats a mega-index.

Depth on the systems we actually work in beats connector breadth. So:

- The management/observability UI is **product** — build once, benefits everything.
- Connectors are **demand-driven** — build the one something actually needs,
  behind a small pluggable "source" abstraction, and design that source's
  permission model at that point. Do not ship connectors speculatively.

## Hard constraints to respect

- **Embedding consistency.** The dev hash-fallback embedder and Voyage produce
  incompatible vectors. Set `VOYAGE_API_KEY` before ingesting real content; switching
  later means re-ingesting everything. The management page must show which embedder
  is live so this is never a silent surprise.
- **Permissions.** Any access-scoped source (Confluence/SharePoint) carries its own
  ACLs. Retrieval today is global — any chunk can surface to any agent, and to
  anyone holding a token with `rag:search` who calls `hub_search_knowledge`
  through `/api/mcp`. Do not index confidential/scoped sources until retrieval
  can filter by principal. This ties into the authz engine (Phase-2 OpenFGA) and
  is a first-class design constraint, not a footnote.

## Phased plan

Status: Phases 1–3 shipped (the seam). Real connectors remain demand-driven.

### Phase 1 — Management page (observability)  ✅
A `/knowledge` page that answers "what does the RAG have, and when does it apply":
- Overview of indexed documents: source, title, chunk count, when added, metadata.
- Add a document (paste text) and delete a document — no more black-box API-only ingest.
- **Test retrieval**: type a query, see the top-k chunks with similarity scores — makes
  "what context would apply" concrete and inspectable.
- **Run provenance**: persist which chunks a run retrieved and show them back
  (title + score) in the run result — answers "what did the AI actually look at".
  Shipped for skill runs and lost with them; see "Where the code stands".
- **Embedder status**: surface whether Voyage or the hash-fallback is live.

### Phase 2 — Curation (scope knowledge to a consumer)  ✅
- Group documents into **collections** (an editable label), curated in the UI.
- `retrieveChunks` can filter by collection.
- An agent can be assigned a collection, so its runs retrieve from a curated set
  instead of the global soup. This is where retrieval *quality* improves.
  (Collections were originally scoped to skills; the mechanism outlived them.)

### Phase 3 — Pluggable sources  ✅ (seam)
- A `KnowledgeSource` interface + registry so connectors slot in behind a document's
  `source_type` (manual today; confluence/sharepoint/office later).
- Ship the manual/paste source; stub one connector to prove the seam.
- **Upsert-by-source** so re-syncing a source replaces its documents instead of
  duplicating them (the one real gap in today's ingest path).
- Each real connector is added demand-driven, with its permission model designed then.

## Where the code stands
- `@ai-hub/rag`: `ingestDocument` (chunk → embed → store), `listDocuments`,
  `retrieveChunks` (pgvector cosine), `chunksToContext`. Embedder is Voyage or a
  deterministic hash fallback.
- `documents` / `document_chunks` carry `source_type`, `source`, `collection` and
  `metadata`.
- Retrieval has three callers now: an agent run through `runSession`, the
  `/knowledge` retrieval tester, and `hub_search_knowledge` over `/api/mcp` —
  which is how Claude Code reads the knowledge base. Run provenance
  (`skill_runs.retrieved`) went with the skills tables; the agent path does not
  yet persist which chunks it used, so Phase 1's provenance promise is currently
  only half kept.

### Phase 4 — The PM-tool connector  ✅ (the first real source)

`pmToolSource()` in `packages/rag/src/sources.ts` indexes Atlas's project
documents. It is the first connector against a live system rather than a stub,
and it settles two questions the seam left open.

**Where the credential comes from.** It does not have one. The PM-tool already
exposes an authenticated MCP endpoint that the hub dials for live tool calls
(`docs/pm-tool-integration.md`), so the connector reuses that connection —
`remoteServerConfig("pm-tool") → connectMcpServers()` — and reads through
`pm_list_projects` / `pm_get_project`. Declare the server once in
`HUB_REMOTE_MCP_SERVERS` — now the only way any remote server enters the
registry — and both the agent's tool calls and this sync are configured. A second endpoint with a second token would have been two things to
rotate and two things to get wrong.

**What is a document and what is not.** Only the slow-moving prose: business
case, scope, assessment, comms and change plans, glossary, KPIs, financials,
startup — plus each project note as its own document. The board is deliberately
excluded. Task status changes hourly, and an embedded copy answers confidently
with yesterday's state; that is what the `pm_*` tools are for. `forecast` and
`settings` are configuration and `orgChart` is a diagram blob, so none of the
three is indexed either.

Sections are rendered by a generic walk over the jsonb rather than a per-section
formatter, so a field added in PM-tool starts being indexed the day it appears.
Empty values are dropped, which means an untouched section produces no document
at all instead of a page of blank labels that would embed as noise. External ids
are `pm-tool:<projectId>:<section>` (and `…:note:<noteId>`), so a re-sync
replaces through the Phase-3 upsert path instead of duplicating.

Verify with `npm run verify:pm-tool -w @ai-hub/rag` — 15 shape checks against a
live endpoint plus, with a database, a full sync, a re-sync that must not
duplicate, and a retrieval round-trip.

> **Voyage rate limits.** An unbilled Voyage account is capped at 3 requests per
> minute, and ingest is one request per document, so a sync of any real corpus
> hits 429 partway through. `VoyageEmbedder` now retries with backoff (honouring
> `Retry-After`), which makes the sync correct but slow — a 7-document sync took
> 16 retries. Adding a payment method removes the cap; the free token allowance
> still applies.
