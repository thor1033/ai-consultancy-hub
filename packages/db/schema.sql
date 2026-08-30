-- AI Hub schema. Idempotent — safe to run repeatedly.
-- Postgres is the single source of truth (see docs/07-tech-stack).

-- pgvector is used by RAG/Memory (Thing 5); enable it here so the DB is ready.
create extension if not exists vector;

-- The record of one agent turn: prompt, model, servers connected, tools used and
-- the full transcript. Written on every /agents run so a run can be read back.
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
  created_at  timestamptz not null default now()
);
create index if not exists agent_sessions_created_idx on agent_sessions (created_at desc);
-- Backfill: drops the FK into the removed skills table (idempotent).
alter table agent_sessions drop column if exists skill_id;

-- MCP server registry (control plane). The runnable stdio config lives in code
-- (@ai-hub/mcp), keyed by name; this table is the admin-owned overlay: which
-- servers are exposed and whether each is currently enabled. A disabled server is
-- dropped from every run, so it's a global kill switch.
--
-- Nothing is seeded here any more. The only servers are the agent-scoped `memory`
-- server, resolved in code, and whatever HUB_REMOTE_MCP_SERVERS declares —
-- upserted on read by listRegisteredServers(), so the environment stays the
-- source of truth rather than a seed that drifts from it.
create table if not exists mcp_servers (
  name        text primary key,
  label       text not null default '',
  description text not null default '',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

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

-- A standing Agent: a named worker with its own instructions, tool access and
-- durable memory.
--
-- Agents are now the only unit of work in the hub. The versioned one-shot Skill
-- that used to sit beside them is gone: an Agent persists between conversations
-- and accumulates what it learns, which is the behaviour that survived contact
-- with real use.
create table if not exists agents (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  name         text not null,
  description  text not null default '',
  instructions text not null default '',      -- the agent's standing system prompt
  model        text,
  effort       text,
  mcp_servers  jsonb not null default '[]'::jsonb,  -- [{"name":"pm-tool"}, …]
  knowledge_collection text,                  -- curation: RAG scope for this agent
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- What an agent remembers between conversations.
--
-- Keyed by (agent, key) rather than appended: an agent that learns a client
-- prefers weekly summaries should overwrite that fact, not accumulate twelve
-- copies of it that all surface at once. The `memory` MCP server is the only
-- writer — see packages/mcp/servers/memory.
create table if not exists agent_memories (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references agents(id) on delete cascade,
  key        text not null,
  content    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, key)
);
create index if not exists agent_memories_agent_idx
  on agent_memories (agent_id, updated_at desc);
