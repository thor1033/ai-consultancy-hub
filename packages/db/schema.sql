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

-- ---------------------------------------------------------------------------
-- Identity and credentials (increment 01: OAuth 2.1 with WorkOS as the
-- authorization server). Replaces HUB_API_TOKENS — a JSON map in an environment
-- variable, hand-minted, unreadable once deployed, and replaced wholesale on
-- every deploy. See docs/auth.md for why that model had to go.
-- ---------------------------------------------------------------------------

-- Who a human is to the hub, independent of how they arrived.
--
-- An access token from AuthKit proves *identity* (a WorkOS user id and an
-- email); it says nothing about what that person may do here. This table is the
-- mapping, so roles are granted once per person rather than baked into whatever
-- credential they happen to be holding. Matched on workos_user_id when we have
-- seen the person before, otherwise on email — the first OAuth sign-in of an
-- allowlisted email binds the two together.
create table if not exists principals (
  id              text primary key,               -- the Principal.id callers see
  email           text unique,                    -- lowercased; the allowlist key
  workos_user_id  text unique,                    -- bound on first OAuth token seen
  display_name    text not null default '',
  roles           jsonb not null default '[]'::jsonb,
  agent_id        text,                           -- optional standing-agent binding
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists principals_email_idx on principals (email);

-- A long-lived bearer credential, for the clients that cannot do OAuth.
--
-- OAuth is the front door and every human surface should use it. This table is
-- the service door: CI, a cron job, the hub reaching another hub. Issued and
-- revoked from /admin, which is the whole point — the env-var map could do
-- neither without a deploy.
--
-- The secret is NOT stored. `token_hash` is a SHA-256 of the full token and
-- `token_prefix` is the leading, non-secret slice used to find the row before
-- comparing hashes, so a database dump yields no usable credential and the
-- console can still show an operator which token is which.
create table if not exists api_credentials (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,                    -- "Ditlev — laptop", "CI deploy"
  principal_id  text not null references principals(id) on delete cascade,
  token_prefix  text not null unique,             -- displayable, non-secret
  token_hash    text not null,                    -- sha256 hex of the full token
  roles         jsonb not null default '[]'::jsonb,  -- may narrow the principal's
  agent_id      text,
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    text
);
create index if not exists api_credentials_principal_idx
  on api_credentials (principal_id, created_at desc);
-- Live credentials only: what /admin lists and what authentication scans.
create index if not exists api_credentials_active_idx
  on api_credentials (token_prefix) where revoked_at is null;

-- The audit trail.
--
-- Deliberately NOT one row per authenticated request: /api/mcp authenticates on
-- every JSON-RPC call, and an insert per call would make the audit log the
-- hottest table in the database while burying the events anyone actually reads.
-- Successful authentication updates api_credentials.last_used_at instead. What
-- lands here is what an operator would want to reconstruct later: credentials
-- issued and revoked, principals changed, and every authentication that FAILED.
create table if not exists auth_events (
  id            uuid primary key default gen_random_uuid(),
  at            timestamptz not null default now(),
  event         text not null,                    -- credential.issued | auth.denied | …
  source        text,                             -- oauth | credential | env
  principal_id  text,
  credential_id uuid,                             -- no FK: survives the credential
  actor         text,                             -- who performed it, for lifecycle events
  detail        jsonb not null default '{}'::jsonb
);
create index if not exists auth_events_at_idx on auth_events (at desc);
create index if not exists auth_events_principal_idx on auth_events (principal_id, at desc);

-- ---------------------------------------------------------------------------
-- Knowledge access (increment 02: retrieval that respects the principal).
--
-- The client-facing model is an org chart: an Agent is an employee, a Tool is
-- what they operate, and Knowledge is the company's files. This is the part
-- that answers "which shared drives may this employee open" — and it exists
-- because once people arrive as themselves (increment 01), retrieval that
-- ignores who is asking is how an analyst's Copilot answer quotes the HR file.
-- ---------------------------------------------------------------------------

-- A collection, promoted from a bare text label on `documents` to a real row.
--
-- It had to become first-class to carry a visibility: you cannot grant access
-- to something that exists only as a distinct value in someone else's column.
-- Documents still reference it by name, so nothing about ingest changes.
--
--   open        any authenticated principal may read it
--   restricted  only principals with a row in collection_grants
--
-- A collection with NO row here is treated as open, which is what keeps the
-- existing corpus readable the moment this deploys. That default is a migration
-- affordance, not a policy: HUB_DEFAULT_COLLECTION_VISIBILITY=restricted flips
-- it once everything has been classified. See docs/knowledge-access.md.
create table if not exists collections (
  name        text primary key,
  label       text not null default '',
  description text not null default '',
  visibility  text not null default 'open' check (visibility in ('open', 'restricted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Who may open a restricted collection.
--
-- Grants are per principal rather than per role on purpose. Roles say what kind
-- of work someone does; this says which of the company's drawers they may open,
-- and the two are not the same question — two analysts on different client
-- engagements should not see each other's material.
create table if not exists collection_grants (
  collection   text not null references collections(name) on delete cascade,
  principal_id text not null references principals(id) on delete cascade,
  granted_by   text not null default '',
  granted_at   timestamptz not null default now(),
  primary key (collection, principal_id)
);
create index if not exists collection_grants_principal_idx
  on collection_grants (principal_id);
