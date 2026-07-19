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
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

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
  created_at timestamptz not null default now()
);
create index if not exists skill_runs_skill_idx on skill_runs (skill_id, created_at desc);

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

-- RAG / Memory (Thing 5): the client's docs become retrievable context.
create table if not exists documents (
  id         uuid primary key default gen_random_uuid(),
  source     text,
  title      text not null default '',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

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
