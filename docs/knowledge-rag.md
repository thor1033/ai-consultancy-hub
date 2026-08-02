# Knowledge / RAG — direction and plan

## The decision

The hub should give each capability (RAG/knowledge, memory, MCP, tools, agents,
skills) a **management surface** — the same pattern as the `/admin` control plane.
For knowledge specifically, we deliberately split the idea in two and only pursue
one half aggressively:

- **Build: observability + curation.** Make it obvious *what* the RAG knows, *which
  skills use what*, and *what context an agent actually retrieved on a run*. Let a
  human curate and scope that knowledge. This is underinvested, cheap (the data
  mostly already flows), and directly serves the trust + ROI story the consultancy
  sells.
- **Resist: becoming a data-integration platform.** "Connect Confluence + SharePoint,
  scrape every PowerPoint/Excel/Word, index it all into one big RAG" is a treadmill
  a boutique consultancy cannot win against Glean / Copilot / LlamaIndex. More data
  ≠ better retrieval — a giant undifferentiated index buries the relevant chunk and
  creates a permissions/governance liability. Curated, *scoped* knowledge per skill
  beats a mega-index.

The hub's moat is **capturing expert workflows as Skills and proving ROI**, not
connector breadth. So:

- The management/observability UI is **product** — build once, every client benefits.
- Connectors are mostly **billable engagement work** — build the one a paying client
  actually asks for, behind a small pluggable "source" abstraction, and design that
  source's permission model at that point. Do not ship connectors speculatively.

## Hard constraints to respect

- **Embedding consistency.** The dev hash-fallback embedder and Voyage produce
  incompatible vectors. Set `VOYAGE_API_KEY` before ingesting real content; switching
  later means re-ingesting everything. The management page must show which embedder
  is live so this is never a silent surprise.
- **Permissions.** Any access-scoped source (Confluence/SharePoint) carries its own
  ACLs. Retrieval today is global — any chunk can surface to anyone who runs a
  RAG-enabled skill. Do not index confidential/scoped sources until retrieval can
  filter by principal. This ties into the authz engine (Phase-2 OpenFGA) and is a
  first-class design constraint, not a footnote.

## Phased plan

Status: Phases 1–3 shipped (the seam). Real connectors remain demand-driven.

### Phase 1 — Management page (observability)  ✅
A `/knowledge` page that answers "what does the RAG have, and when does it apply":
- Overview of indexed documents: source, title, chunk count, when added, metadata.
- Add a document (paste text) and delete a document — no more black-box API-only ingest.
- **Test retrieval**: type a query, see the top-k chunks with similarity scores — makes
  "what context would apply" concrete and inspectable.
- **Run provenance**: persist which chunks a skill run retrieved and show them back
  (title + score) in the run result — answers "what did the AI actually look at".
- **Embedder status**: surface whether Voyage or the hash-fallback is live.

### Phase 2 — Curation (scope knowledge to skills)  ✅
- Group documents into **collections** (an editable label), curated in the UI.
- `retrieveChunks` can filter by collection.
- A skill can be assigned a collection, so its runs retrieve from a curated set
  instead of the global soup. This is where retrieval *quality* improves.

### Phase 3 — Pluggable sources  ✅ (seam)
- A `KnowledgeSource` interface + registry so connectors slot in behind a document's
  `source_type` (manual today; confluence/sharepoint/office later).
- Ship the manual/paste source; stub one connector to prove the seam.
- **Upsert-by-source** so re-syncing a source replaces its documents instead of
  duplicating them (the one real gap in today's ingest path).
- Each real connector is added demand-driven, with its permission model designed then.

## Where the current code stands (starting point)
- `@ai-hub/rag`: `ingestDocument` (chunk → embed → store), `listDocuments`,
  `retrieveChunks` (pgvector cosine), `chunksToContext`. Embedder is Voyage or a
  deterministic hash fallback.
- `documents` / `document_chunks` tables already carry `source` + `metadata`, so the
  source/collection model layers on cleanly.
- `runSkill` retrieves when `retrieve: true` but only counts chunks — it does not yet
  persist or surface which ones (the Phase-1 provenance gap).
- Ingest always inserts; there is no update/delete-by-source yet (the Phase-3 gap).
