-- AI Hub schema. Idempotent — safe to run repeatedly.
-- Postgres is the single source of truth (see docs/07-tech-stack).

-- pgvector is used by RAG/Memory (Thing 5); enable it here so the DB is ready.
create extension if not exists vector;

-- A Skill: a captured expert workflow, launchable from the hub.
create table if not exists skills (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  description text not null default '',
  enabled     boolean not null default true,   -- admin control-plane on/off switch
  knowledge_collection text,                    -- curation: RAG scope for this skill's runs
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
-- Backfills for databases created before these columns existed (idempotent).
alter table skills add column if not exists enabled boolean not null default true;
alter table skills add column if not exists knowledge_collection text;

-- Skills are versioned IP — each version pins the captured process + its config.
create table if not exists skill_versions (
  id               uuid primary key default gen_random_uuid(),
  skill_id         uuid not null references skills(id) on delete cascade,
  version          int  not null,
  instructions     text not null,          -- the skillified process (system prompt)
  model            text,
  effort           text,
  mcp_servers      jsonb not null default '[]'::jsonb,
  baseline_minutes int,                     -- manual time this replaces (ROI input)
  created_at       timestamptz not null default now(),
  unique (skill_id, version)
);

-- Every run captures the ROI substrate: cost, latency, tokens, trace.
create table if not exists skill_runs (
  id         uuid primary key default gen_random_uuid(),
  skill_id   uuid not null references skills(id) on delete cascade,
  version    int  not null,
  input      text not null,
  output     text,
  status     text not null default 'succeeded',
  cost_usd   numeric,
  latency_ms int,
  tokens     jsonb,
  trace_id   text,
  retrieved  jsonb not null default '[]'::jsonb,   -- RAG provenance: chunks this run pulled
  created_at timestamptz not null default now()
);
create index if not exists skill_runs_skill_idx on skill_runs (skill_id, created_at desc);
alter table skill_runs add column if not exists retrieved jsonb not null default '[]'::jsonb;

-- Scheduled automations: run a Skill unattended on a cadence (once/daily/weekly/
-- monthly) with a fixed input. next_run_at is the computed fire time the runner
-- polls; times are interpreted in the server's local timezone.
create table if not exists skill_schedules (
  id           uuid primary key default gen_random_uuid(),
  skill_id     uuid not null references skills(id) on delete cascade,
  input        text not null,                       -- the prompt to run each time
  retrieve     boolean not null default false,      -- use the knowledge base (RAG)
  kind         text not null,                       -- once | daily | weekly | monthly
  time_of_day  text,                                -- 'HH:MM' (daily/weekly/monthly)
  weekday      int,                                 -- 0=Sun..6=Sat (weekly)
  day_of_month int,                                 -- 1..31 (monthly)
  run_at       timestamptz,                         -- absolute instant (once)
  enabled      boolean not null default true,
  next_run_at  timestamptz,                         -- computed next fire; null once done
  last_run_at  timestamptz,
  last_status  text,
  last_run_id  uuid,
  created_at   timestamptz not null default now()
);
create index if not exists skill_schedules_due_idx
  on skill_schedules (next_run_at) where enabled and next_run_at is not null;

-- Skillification (docs/04): an ad-hoc agent session run by a practitioner in the
-- workbench. We persist the whole transcript so it can later be *distilled* into a
-- reusable Skill. skill_id is set once the session has been skillified.
create table if not exists agent_sessions (
  id          uuid primary key default gen_random_uuid(),
  prompt      text not null,
  system      text,
  model       text,
  effort      text,
  mcp_servers jsonb not null default '[]'::jsonb,   -- server names connected this session
  transcript  jsonb not null default '[]'::jsonb,   -- full Anthropic message array
  tools_used  jsonb not null default '[]'::jsonb,   -- tool names actually invoked
  output      text,
  status      text not null default 'succeeded',
  cost_usd    numeric,
  latency_ms  int,
  tokens      jsonb,
  trace_id    text,
  skill_id    uuid references skills(id) on delete set null,  -- set when skillified
  created_at  timestamptz not null default now()
);
create index if not exists agent_sessions_created_idx on agent_sessions (created_at desc);

-- AI Readiness Assessment (docs/02 — the free on-ramp / lead-gen). Stores each
-- prospect's questionnaire answers, the deterministic readiness scores, and the
-- Claude-generated opportunity report, so the consultancy can review leads.
create table if not exists assessments (
  id           uuid primary key default gen_random_uuid(),
  company      text,
  answers      jsonb not null default '{}'::jsonb,   -- questionId -> option score
  workflow     text,                                 -- described recurring workflow
  usage_score  numeric,
  data_score   numeric,
  overall      numeric,
  report       jsonb not null default '{}'::jsonb,   -- generated AssessmentReport
  rate         numeric,                              -- analyst hourly rate used
  monthly_value_usd numeric,                         -- priced recoverable time / mo
  created_at   timestamptz not null default now()
);
create index if not exists assessments_created_idx on assessments (created_at desc);

-- Security / AuthZ (Thing 6): explicit per-skill run grants. When a skill has
-- any grants, only listed principals (or admins) may run it — this is the
-- resource-level policy the OwnedPolicyEngine enforces.
create table if not exists skill_grants (
  id           uuid primary key default gen_random_uuid(),
  skill_id     uuid not null references skills(id) on delete cascade,
  principal_id text not null,
  created_at   timestamptz not null default now(),
  unique (skill_id, principal_id)
);

-- MCP server registry (control plane). The runnable stdio config lives in code
-- (@ai-hub/mcp), keyed by name; this table is the admin-owned overlay: which
-- servers are exposed and whether each is currently enabled. A disabled server is
-- dropped from every run (session and skill), so it's a global kill switch.
create table if not exists mcp_servers (
  name        text primary key,
  label       text not null default '',
  description text not null default '',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Seed the built-in servers so the registry matches @ai-hub/mcp out of the box.
insert into mcp_servers (name, label, description) values
  ('sample',        'Sample',        'Reference MCP server (a simple add tool) used to smoke-test the runtime.'),
  ('market-data',   'Market data',   'Investment-firm demo: market summaries and per-asset performance.'),
  ('customer-data', 'Customer data', 'Investment-firm demo: client profiles, portfolios, and allocations.'),
  ('pptx',          'PowerPoint',    'Investment-firm demo: renders a client-ready presentation from sections.')
on conflict (name) do nothing;

-- RAG / Memory (Thing 5): the client's docs become retrievable context.
-- source_type names the connector that produced the doc (manual today; confluence/
-- sharepoint/office later) so pluggable sources layer on without a schema change.
-- collection is a curation label so retrieval can be scoped to a set (see docs/knowledge-rag.md).
create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  source_type text not null default 'manual',
  source      text,
  collection  text,
  title       text not null default '',
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Backfills for databases created before the knowledge management work (idempotent).
alter table documents add column if not exists source_type text not null default 'manual';
alter table documents add column if not exists collection  text;
alter table documents add column if not exists updated_at   timestamptz not null default now();

-- Chunk embeddings. 1024 dims matches Voyage (voyage-3.5) and the dev fallback.
create table if not exists document_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index int  not null,
  content     text not null,
  embedding   vector(1024) not null,
  created_at  timestamptz not null default now()
);
create index if not exists document_chunks_embedding_idx
  on document_chunks using hnsw (embedding vector_cosine_ops);

-- Investment-firm demo skill (see docs/use-cases/investment-firm.md) — wired to
-- the customer-data, market-data, and pptx MCP servers. Baseline: ~120 min manual.
insert into skills (slug, name, description)
values ('weekly-client-presentation', 'Weekly Client Presentation',
        'Investment-firm demo: generate a client''s weekly presentation from their portfolio and market data.')
on conflict (slug) do nothing;

insert into skill_versions (skill_id, version, instructions, model, mcp_servers, baseline_minutes)
select id, 1,
'You are a senior investment analyst producing a client''s weekly presentation.

Steps:
1. Identify the client. If needed, call list_clients (customer-data). Then call get_client and get_portfolio for their profile, holdings, allocation, and period return.
2. Call get_market_summary (market-data) for the period''s market context. Optionally call get_asset_performance for notable holdings.
3. If house-style or commentary context is provided, follow its tone and structure.
4. Compose a concise, client-ready deck with three sections: Market Overview, Portfolio Review (allocation and period return), and Outlook & Commentary.
5. Call create_presentation (pptx) with a title like "<Client Name> - Weekly Review", a subtitle with the period, and the sections. Return the generated file path and a one-paragraph summary for the relationship manager.',
       'claude-opus-4-8',
       '[{"name":"customer-data"},{"name":"market-data"},{"name":"pptx"}]'::jsonb,
       120
from skills where slug = 'weekly-client-presentation'
on conflict (skill_id, version) do nothing;

-- Seed a demo skill wired to the sample MCP server, so the hub is runnable
-- out of the box (see packages/mcp).
insert into skills (slug, name, description)
values ('adder-demo', 'Adder Demo',
        'Demo skill: adds numbers using the sample MCP server''s add tool.')
on conflict (slug) do nothing;

insert into skill_versions (skill_id, version, instructions, model, mcp_servers, baseline_minutes)
select id, 1,
       'You are a calculator skill. Use the add tool from the sample MCP server to compute any sum the user asks for. Respond with just the numeric result.',
       'claude-opus-4-8',
       '[{"name":"sample"}]'::jsonb,
       5
from skills where slug = 'adder-demo'
on conflict (skill_id, version) do nothing;
