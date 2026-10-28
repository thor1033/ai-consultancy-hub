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
  knowledge_collection text,                  -- superseded by knowledge_collections (below); dropped by drop-legacy.sql
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- What an agent reads: curation, never permission (docs/knowledge-access.md).
--
--   knowledge_all = true            retrieve from everything the CALLER may read
--   knowledge_collections = {a, b}  retrieve from these collections only
--   neither                         no retrieval: memory and tools only
--
-- A set rather than one name because real agents work out of a few drawers
-- (a client's material plus the delivery playbook). A document still sits in
-- exactly one collection: that is the unit people are granted, and it stays
-- simple enough to audit. Names are not foreign keys because a collection may
-- exist only as a label on documents, with no row in `collections` yet.
alter table agents add column if not exists knowledge_collections text[] not null default '{}';
alter table agents add column if not exists knowledge_all boolean not null default false;
-- Carry the old single value over, once. Clearing the old column as it is
-- copied is what makes this safe to re-run: an agent later set back to "no
-- knowledge" is not re-scoped from a stale value on the next migrate.
update agents
   set knowledge_collections = array[knowledge_collection],
       knowledge_collection = null
 where knowledge_collection is not null and knowledge_collection <> '';

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
-- Active memories are the work in flight and are what a conversation starts
-- from; inactive ones (finished, paused, background) are kept and searchable
-- but not loaded by default. Defaults to true so existing memories keep loading.
alter table agent_memories add column if not exists active boolean not null default true;
-- Where a memory sits on the Context page's map: projects | people | rules |
-- routines. Null means untagged; the page places those around the agent.
alter table agent_memories add column if not exists region text;

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

-- ---------------------------------------------------------------------------
-- Agent runs (increment 03: an agent you build in the hub, runnable from any
-- client). In org-chart terms: an Agent is an employee, and this is the record
-- of a piece of work you asked them to do.
-- ---------------------------------------------------------------------------

-- Which agent ran, and who asked. Neither was recorded before: agentId went
-- into the Langfuse metadata and nowhere else, so the table that "traces a run
-- back to the agent that made it" could not actually do so — and the ROI report
-- in increment 04 has nothing to count without it.
alter table agent_sessions add column if not exists agent_id uuid
  references agents(id) on delete set null;
alter table agent_sessions add column if not exists principal_id text;

-- A run reached over MCP cannot always finish inside one tool call: an agent
-- doing real multi-turn work takes minutes, and every MCP client has a timeout
-- far shorter than that. So a run is a row with a lifecycle — 'running' until
-- it is 'succeeded' or 'failed' — and a caller that hits the deadline is handed
-- the id to poll instead of an error. `status` already existed and defaulted to
-- 'succeeded', which stays true for the synchronous path.
alter table agent_sessions add column if not exists started_at timestamptz;
alter table agent_sessions add column if not exists finished_at timestamptz;
alter table agent_sessions add column if not exists error text;

create index if not exists agent_sessions_agent_idx
  on agent_sessions (agent_id, created_at desc);
-- Finding the runs still in flight, for polling and for spotting the stuck ones.
create index if not exists agent_sessions_running_idx
  on agent_sessions (status, started_at) where status = 'running';

-- A named, parameterised thing one agent knows how to do.
--
-- In the org chart we explain the hub with, an Agent is an employee and this is
-- their Expertise: "write the weekly client deck" rather than "here is a chat
-- box". An employee has several, which is why this is a table and not columns
-- on `agents`.
--
-- NOT the `skills` table deleted on 2026-08-30, and not an attempt to bring it
-- back. That was a standalone versioned artifact with its own runs, grants and
-- schedules, and it did not survive real use. This is a much smaller thing: a
-- prompt template plus the parameters that fill it, belonging to exactly one
-- agent, existing so the work shows up in a client's tool list with a real
-- input schema instead of a free-text box. A saved transcript is a transcript;
-- a named parameterised run is something a colleague can invoke.
create table if not exists agent_skills (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references agents(id) on delete cascade,
  -- Globally unique, not per-agent: the slug becomes an MCP tool name, and two
  -- agents owning `weekly-deck` would mean two tools a client cannot tell apart.
  slug            text unique not null,
  name            text not null,
  description     text not null default '',
  -- The prompt, with {{parameter}} placeholders filled at call time.
  prompt_template text not null default '',
  -- [{ "name": "client", "description": "...", "required": true,
  --    "type": "string" | "number" | "boolean", "options": ["a","b"] }]
  parameters      jsonb not null default '[]'::jsonb,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists agent_skills_agent_idx on agent_skills (agent_id, name);

-- Which skill produced a run, when one did. Null for a free-form agent call.
--
-- Deliberately NOT called `skill_id`: line 28 of this file drops a column by
-- that name (the FK into the deleted `skills` table), and this file is applied
-- top to bottom on every deploy. Reusing the name would mean dropping and
-- recreating this column on every migrate, silently emptying it each time.
alter table agent_sessions add column if not exists agent_skill_id uuid
  references agent_skills(id) on delete set null;

-- How many rounds of tool use one agent may take before a run is cut off. Null
-- means the runtime default (DEFAULT_MAX_ITERATIONS). A secretary working
-- through an inbox needs more rounds than an agent that looks one thing up, and
-- the ceiling is enforced in code so a bad row cannot cost unbounded money.
alter table agents add column if not exists max_iterations int;

-- The clock. Until this table existed every agent run began with a person, so
-- an agent could not act on its own — see docs/schedules.md.
--
-- A schedule belongs to a principal and runs AS that principal: retrieval is
-- scoped to the caller's grants, and an unattended run has no caller. The
-- cascade on that FK is deliberate — deleting a person takes their unattended
-- runs with them rather than leaving an ownerless job reading a mailbox.
create table if not exists agent_schedules (
  id                 uuid primary key default gen_random_uuid(),
  agent_id           uuid not null references agents(id) on delete cascade,
  name               text not null,
  prompt             text not null,              -- what the agent is asked, every time
  kind               text not null check (kind in ('every', 'daily')),
  interval_minutes   int,                        -- kind 'every'
  at_minute          int,                        -- kind 'daily': minutes past local midnight
  weekdays           jsonb not null default '[]'::jsonb,  -- [1,2,3,4,5]; empty = every day
  timezone           text not null default 'UTC',         -- IANA; the daily time is local to it
  owner_principal_id text not null references principals(id) on delete cascade,
  enabled            boolean not null default true,
  -- Stamped when a tick CLAIMS the schedule, not when the run finishes: a run
  -- takes minutes, and a stale timestamp would look due to every tick between.
  last_run_at        timestamptz,
  last_run_id        uuid references agent_sessions(id) on delete set null,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists agent_schedules_due_idx on agent_schedules (enabled, last_run_at);
create index if not exists agent_schedules_agent_idx on agent_schedules (agent_id);

-- A schedule may run a SKILL instead of a free-text prompt: the skill's
-- template is filled from skill_args at fire time, so the morning brief and a
-- brief asked for by hand are the same prompt from the same place. `prompt`
-- stays as the human-readable line for such a schedule. The cascade is
-- deliberate: deleting a skill ends its clock rather than leaving a schedule
-- that fires into nothing.
alter table agent_schedules add column if not exists agent_skill_id uuid
  references agent_skills(id) on delete cascade;
alter table agent_schedules add column if not exists skill_args jsonb not null default '{}'::jsonb;
create index if not exists agent_schedules_skill_idx on agent_schedules (agent_skill_id);

-- Where an agent runs (see docs/local-agents.md).
--
--   hub    the hub's own runtime: hub_agent_<slug>, the /agents console, schedules
--   local  synced into Claude Code as a sub-agent; the hub never runs it itself
--   both   both of the above
--
-- Defaults to 'hub' so every existing agent keeps doing exactly what it did.
-- Changing it is admin-only (agents/actions.ts): it changes where an agent's
-- instructions are copied to and who reaches its tools.
alter table agents add column if not exists placement text not null default 'hub'
  check (placement in ('hub', 'local', 'both'));

-- What a local agent did through the hub.
--
-- A local agent's model runs in someone's Claude Code session, so the hub never
-- sees a prompt, a transcript or a cost — only the tool calls that come back
-- through /api/mcp/agents/<slug>. That is what is recorded, one row per call,
-- and deliberately NOT in agent_sessions: a row there claims a run the hub
-- performed and priced, and the ROI report would count these as such.
create table if not exists agent_local_calls (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references agents(id) on delete cascade,
  principal_id text,
  tool         text not null,
  ok           boolean not null,
  latency_ms   int,
  at           timestamptz not null default now()
);
create index if not exists agent_local_calls_agent_idx on agent_local_calls (agent_id, at desc);

-- ---------------------------------------------------------------------------
-- Proposals: the approval gate (docs/approvals.md).
--
-- An agent's call to a tool that WRITES is not executed; it is written here
-- and the model is told it was held. A person approves it on /approvals (or
-- through the hub's MCP tools), and the hub executes the very call that was
-- held, with the arguments that were shown. Nothing is re-derived at approval
-- time: what the approver saw is what runs.
--
-- Which calls are held is decided per agent, per server entry
-- (`"writes": "allow"` lets an entry write unattended; the default asks).
-- A tool is a write unless its server says readOnlyHint: true — "not proven
-- read-only" is the safe reading, as it is for dropWrites in proxyTools.ts.
-- The agent's own memory is exempt: it never leaves the hub.
--
--   pending   held, nobody has decided
--   approved  claimed by an approver, being executed (transient)
--   executed  ran; `result` holds what the tool returned
--   failed    approved, but the tool call failed; `error` says why
--   rejected  a person said no; `note` may say why
-- ---------------------------------------------------------------------------
create table if not exists proposals (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid references agents(id) on delete cascade,
  run_id        uuid references agent_sessions(id) on delete set null,
  -- Whose reach the run had. Null for a workbench session with no principal.
  principal_id  text references principals(id) on delete cascade,
  server        text not null,
  tool          text not null,
  args          jsonb not null default '{}'::jsonb,
  description   text not null default '',      -- the tool's own description, for the reader
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'executed', 'failed', 'rejected')),
  decided_by    text,
  decided_at    timestamptz,
  note          text,
  result        text,
  error         text,
  created_at    timestamptz not null default now()
);
-- The agent's one line for the approver: what this changes and the evidence.
-- Captured from a `reason` argument the gate adds to every write tool's
-- schema and strips before the call is forwarded (apps/web/src/lib/approvals.ts).
alter table proposals add column if not exists reason text;
create index if not exists proposals_status_idx on proposals (status, created_at desc);
create index if not exists proposals_run_idx on proposals (run_id);
create index if not exists proposals_principal_idx on proposals (principal_id, status);

-- ---------------------------------------------------------------------------
-- Decks: presentations the hub renders and that change while they are shown
-- (docs/decks.md).
--
-- A deck is data, not a file. `slides` is an ordered array of structured
-- slides (a kind plus fields; validated in apps/web/src/lib/decks), each with
-- an id, a status and who made it:
--
--   live     part of the deck, shown in order
--   pending  in the presenter's tray: drafted by an agent (or asked for from
--            the question box) while the deck is being presented, never on
--            the audience's screen until a person puts it there
--
-- One row per deck, the slides as one array, so an ordering change and the
-- version bump are one atomic write. Every change bumps `version`; the views
-- poll it and redraw when it moves, and writers update conditionally on it,
-- so a presenter and an agent writing at the same second both land.
--
-- `collection` names the knowledge this deck is about. It is curation and a
-- fence at once: a deck about a restricted client collection is visible only
-- to people who may read that collection, and a slide drafted from the
-- question box retrieves from it.
-- ---------------------------------------------------------------------------
create table if not exists decks (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  owner_principal_id text references principals(id) on delete set null,
  collection         text,
  slides             jsonb not null default '[]'::jsonb,
  -- The slide on screen while presenting (a slide id), so every view follows.
  position           text,
  presenting         boolean not null default false,
  version            int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists decks_updated_idx on decks (updated_at desc);
