import { getSql } from "./client";
import { identifierRefusal } from "../../mcp/servers/detect.mjs";
import type { ImportSource } from "./skillmd";

// Standing agents and the memory they keep between conversations. Agents are now
// the hub's only unit of work; nothing here is versioned, because an agent is a
// thing that changes as it goes rather than a release you pin.

/**
 * One entry in an agent's stored MCP server list. Deliberately open: a bare
 * `{name}` marker for a server the hub resolves itself, and room for a connector
 * to carry its own fields without a migration.
 */
export type McpEntry = Record<string, unknown>;

/**
 * Where an agent runs: on the hub's runtime, in a Claude Code session as a
 * synced sub-agent, or both. See docs/local-agents.md.
 */
export type Placement = "hub" | "local" | "both";

export const PLACEMENTS: readonly Placement[] = ["hub", "local", "both"];

export function isPlacement(value: unknown): value is Placement {
  return value === "hub" || value === "local" || value === "both";
}

/** Whether the hub itself may run this agent (chat, MCP tools, schedules). */
export const runsOnHub = (p: Placement) => p !== "local";

/** Whether this agent is synced into Claude Code as a sub-agent. */
export const runsLocally = (p: Placement) => p !== "hub";

/**
 * Where an agent came from, when a pattern made it (docs/agent-patterns.md).
 * A label for the org chart and the agent's page; never consulted at run time.
 */
export interface PatternTag {
  slug: string;
  instance: string;
  role: string;
}

export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  placement: Placement;
  /** The company function it is filed under (Delivery, Product, …). Blank = not filed. */
  functionName: string;
  /** The person who answers for it. Blank = nobody yet. */
  owner: string;
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Agent extends AgentSummary {
  instructions: string;
  model: string | null;
  effort: string | null;
  mcpServers: McpEntry[];
  /** Collections this agent retrieves from. Ignored when knowledgeAll is set. */
  knowledgeCollections: string[];
  /** Retrieve from everything the caller may read, rather than a curated set. */
  knowledgeAll: boolean;
  /** Rounds of tool use one run may take. Null ⇒ the runtime default. */
  maxIterations: number | null;
  /**
   * Whether it keeps memory between runs. False is for a worker meant to start
   * clean every time (the goldfish of docs/agent-patterns.md): no memory
   * server is attached, so nothing from one job reaches the next.
   */
  keepsMemory: boolean;
  pattern: PatternTag | null;
  /** Where it was imported from, if it was (docs/skill-import.md). */
  source: ImportSource | null;
}

/**
 * What an agent reads, as one value the run paths can switch on. Curation
 * only: whichever kind it is, retrieval is still filtered by the caller's
 * access (docs/knowledge-access.md).
 */
export type KnowledgeScope =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "collections"; names: string[] };

export function knowledgeScope(agent: Pick<Agent, "knowledgeAll" | "knowledgeCollections">): KnowledgeScope {
  if (agent.knowledgeAll) return { kind: "all" };
  const names = (agent.knowledgeCollections ?? []).filter((n) => typeof n === "string" && n.trim());
  return names.length ? { kind: "collections", names } : { kind: "none" };
}

/**
 * The retrieval options for a scope, or null when the agent reads nothing.
 * Every path that retrieves for an agent goes through this, so "no knowledge"
 * means the same thing in the console, on a schedule and at the per-agent
 * endpoint.
 */
export function retrievalScope(scope: KnowledgeScope): { collection?: string[] } | null {
  if (scope.kind === "none") return null;
  if (scope.kind === "all") return {};
  return { collection: scope.names };
}

/** "Everything", "None", or the collection names — for rosters and previews. */
export function knowledgeLabel(agent: Pick<Agent, "knowledgeAll" | "knowledgeCollections">): string {
  const scope = knowledgeScope(agent);
  if (scope.kind === "all") return "Everything";
  if (scope.kind === "none") return "None";
  return scope.names.join(", ");
}

export interface AgentMemory {
  id: string;
  key: string;
  content: string;
  active: boolean;
  /** Who may have it loaded: everyone using the agent, readers of a collection, or one person. */
  scope: MemoryScope;
  /** '' for agent; the collection's name; the person's principal id. */
  scopeRef: string;
  /** The person whose run wrote it, when known. */
  writtenBy: string | null;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

/*
 * Memory scopes (docs/memory-scopes.md). A memory is loaded only into runs of
 * people its scope reaches:
 *
 *   agent       everyone who uses the agent
 *   collection  people who may read that knowledge collection
 *   personal    the one person whose run wrote it
 *
 * The scope is decided by the hub from what the writing run touched — never
 * by the model — and widening one is an admin's act (shareMemory).
 */
export type MemoryScope = "agent" | "collection" | "personal";
export const MEMORY_SCOPES: readonly MemoryScope[] = ["agent", "collection", "personal"];

/** Where a memory is kept. `ref` is '' for agent, a collection name, or a principal id. */
export interface MemoryPlace {
  scope: MemoryScope;
  ref: string;
}
export const SHARED_MEMORY: MemoryPlace = { scope: "agent", ref: "" };

/**
 * Who is looking, for reads: their principal id (null for nobody — a
 * workbench run), and which collections they may read, in the shape of
 * @ai-hub/authz's KnowledgeAccess (structural, so this package need not import
 * that one). Omitted on a read means "everything", for admins' review pages,
 * seeds and harnesses — never for a run.
 */
export interface MemoryReach {
  principalId: string | null;
  collections: { kind: "all" } | { kind: "allow"; collections: string[] } | { kind: "deny"; collections: string[] };
}

/**
 * The SQL predicate a reach allows, over `agent_memories` (unaliased). With no
 * principal, '' matches no personal memory: the check constraint keeps every
 * personal memory's ref non-empty.
 */
export function memoryReachPredicate(reach: MemoryReach | undefined) {
  const sql = getSql();
  if (!reach) return sql`true`;
  const c = reach.collections;
  const collection =
    c.kind === "all"
      ? sql`true`
      : c.kind === "allow"
        ? c.collections.length
          ? sql`scope_ref = any(${c.collections}::text[])`
          : sql`false`
        : c.collections.length
          ? sql`not (scope_ref = any(${c.collections}::text[]))`
          : sql`true`;
  return sql`(scope = 'agent'
    or (scope = 'personal' and scope_ref = ${reach.principalId ?? ""})
    or (scope = 'collection' and ${collection}))`;
}

/** Narrowest first: a person's own memory under a key wins over a shared one. */
const NARROWEST_FIRST = `case scope when 'personal' then 0 when 'collection' then 1 else 2 end`;

export interface AgentInput {
  slug: string;
  name: string;
  description?: string;
  instructions?: string;
  model?: string | null;
  effort?: string | null;
  mcpServers?: McpEntry[];
  knowledgeCollections?: string[];
  knowledgeAll?: boolean;
  maxIterations?: number | null;
  enabled?: boolean;
  placement?: Placement;
  functionName?: string;
  owner?: string;
  keepsMemory?: boolean;
  pattern?: PatternTag | null;
  source?: ImportSource | null;
}

// Unqualified on purpose: this list is reused in a RETURNING clause, where
// there is no table alias to qualify against.
const AGENT_COLUMNS = `
  id, slug, name, description, instructions, model, effort,
  mcp_servers as "mcpServers", knowledge_collections as "knowledgeCollections",
  knowledge_all as "knowledgeAll", max_iterations as "maxIterations",
  enabled, placement, function_name as "functionName", owner,
  keeps_memory as "keepsMemory", pattern, source,
  created_at as "createdAt", updated_at as "updatedAt"
`;

export async function listAgents(): Promise<AgentSummary[]> {
  const sql = getSql();
  // The memory count is what tells a reader an agent has actually been used,
  // so it belongs in the list rather than one level down.
  return sql<AgentSummary[]>`
    select a.id, a.slug, a.name, a.description, a.enabled, a.placement,
           a.function_name as "functionName", a.owner,
           count(m.id)::int as "memoryCount",
           a.created_at as "createdAt", a.updated_at as "updatedAt"
    from agents a
    left join agent_memories m on m.agent_id = a.id
    group by a.id
    order by a.created_at desc
  `;
}

export async function getAgent(idOrSlug: string): Promise<Agent | null> {
  const sql = getSql();
  // Accepts either form: the UI routes by slug (readable URLs), while a run
  // carries the id.
  const rows = await sql<Agent[]>`
    select ${sql.unsafe(AGENT_COLUMNS)},
           (select count(*)::int from agent_memories m where m.agent_id = agents.id)
             as "memoryCount"
    from agents
    where slug = ${idOrSlug} or id::text = ${idOrSlug}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function createAgent(input: AgentInput): Promise<Agent> {
  const sql = getSql();
  const rows = await sql<Agent[]>`
    insert into agents (slug, name, description, instructions, model, effort,
                        mcp_servers, knowledge_collections, knowledge_all, max_iterations,
                        enabled, placement, function_name, owner, keeps_memory, pattern, source)
    values (${input.slug}, ${input.name}, ${input.description ?? ""},
            ${input.instructions ?? ""}, ${input.model ?? null}, ${input.effort ?? null},
            ${sql.json((input.mcpServers ?? []) as Parameters<typeof sql.json>[0])},
            ${cleanNames(input.knowledgeCollections)}::text[], ${input.knowledgeAll ?? false},
            ${input.maxIterations ?? null}, ${input.enabled ?? true}, ${input.placement ?? "hub"},
            ${(input.functionName ?? "").trim()}, ${(input.owner ?? "").trim()},
            ${input.keepsMemory ?? true}, ${sql.json((input.pattern ?? null) as never)},
            ${sql.json((input.source ?? null) as never)})
    returning ${sql.unsafe(AGENT_COLUMNS)}, 0 as "memoryCount"
  `;
  return rows[0];
}

// Trimmed, de-duplicated, blanks dropped: a name is matched exactly against
// documents.collection, so a trailing space would scope an agent to nothing.
function cleanNames(names: readonly string[] | undefined): string[] {
  return [...new Set((names ?? []).map((n) => (typeof n === "string" ? n.trim() : "")).filter(Boolean))];
}

export async function updateAgent(
  id: string,
  input: Partial<AgentInput>,
): Promise<Agent | null> {
  const sql = getSql();

  // Read-modify-write rather than a conditional SET list. Three of these fields
  // are nullable, so "leave it alone" and "set it to null" are different
  // intentions that coalesce cannot tell apart; merging in JS keeps an omitted
  // field untouched while still letting the editor clear one deliberately.
  const current = await getAgent(id);
  if (!current) return null;
  const next = { ...current, ...input };

  const rows = await sql<Agent[]>`
    update agents set
      name = ${next.name},
      description = ${next.description ?? ""},
      instructions = ${next.instructions ?? ""},
      model = ${next.model ?? null},
      effort = ${next.effort ?? null},
      mcp_servers = ${sql.json((next.mcpServers ?? []) as Parameters<typeof sql.json>[0])},
      knowledge_collections = ${cleanNames(next.knowledgeCollections)}::text[],
      knowledge_all = ${next.knowledgeAll ?? false},
      max_iterations = ${next.maxIterations ?? null},
      enabled = ${next.enabled ?? true},
      placement = ${next.placement ?? "hub"},
      function_name = ${(next.functionName ?? "").trim()},
      owner = ${(next.owner ?? "").trim()},
      keeps_memory = ${next.keepsMemory ?? true},
      pattern = ${sql.json((next.pattern ?? null) as never)},
      source = ${sql.json((next.source ?? null) as never)},
      updated_at = now()
    where id = ${id}
    returning ${sql.unsafe(AGENT_COLUMNS)},
      (select count(*)::int from agent_memories m where m.agent_id = agents.id)
        as "memoryCount"
  `;
  return rows[0] ?? null;
}

export async function deleteAgent(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from agents where id = ${id}`;
  return rows.count > 0;
}

// ── memory ──────────────────────────────────────────────────────────────────
// These are the primitives the `memory` MCP server exposes as tools. They live
// here rather than in the server so the /agents UI can read and prune what an
// agent believes without going through the model.

const MEMORY_COLUMNS = `id, key, content, active, scope, scope_ref as "scopeRef",
  written_by as "writtenBy", source_run_id as "sourceRunId",
  created_at as "createdAt", updated_at as "updatedAt"`;

/**
 * Active memories first, then most recently updated — those `reach` may see,
 * or all of them when it is omitted (review pages, seeds, harnesses).
 */
export async function listMemories(agentId: string, reach?: MemoryReach): Promise<AgentMemory[]> {
  const sql = getSql();
  return sql<AgentMemory[]>`
    select ${sql.unsafe(MEMORY_COLUMNS)}
    from agent_memories
    where agent_id = ${agentId} and ${memoryReachPredicate(reach)}
    order by active desc, updated_at desc
  `;
}

export async function getMemory(id: string): Promise<(AgentMemory & { agentId: string }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const sql = getSql();
  const [row] = await sql<(AgentMemory & { agentId: string })[]>`
    select ${sql.unsafe(MEMORY_COLUMNS)}, agent_id as "agentId" from agent_memories where id = ${id}`;
  return row ?? null;
}

/**
 * Upsert by key within a scope — an agent correcting itself replaces the
 * fact, never doubles it; two people's personal memories under one key stay
 * two memories. A write is active unless said otherwise. Shared (agent) scope
 * unless a place is given.
 */
export async function rememberMemory(
  agentId: string,
  key: string,
  content: string,
  active = true,
  place: MemoryPlace = SHARED_MEMORY,
  meta: { writtenBy?: string | null; sourceRunId?: string | null } = {},
): Promise<AgentMemory> {
  // CPR, card and account numbers are never kept in memory, whoever writes
  // (docs/sensitivity.md). The message is the one an agent reads, so it can
  // write the fact without the number.
  const refusal = identifierRefusal(`${key}\n${content}`);
  if (refusal) throw new Error(refusal);
  const sql = getSql();
  const ref = place.scope === "agent" ? "" : place.ref;
  if (place.scope !== "agent" && !ref) throw new Error(`A ${place.scope} memory needs to say whose.`);
  const rows = await sql<AgentMemory[]>`
    insert into agent_memories (agent_id, key, content, active, scope, scope_ref, written_by, source_run_id)
    values (${agentId}, ${key}, ${content}, ${active}, ${place.scope}, ${ref}, ${meta.writtenBy ?? null}, ${meta.sourceRunId ?? null})
    on conflict (agent_id, key, scope, scope_ref) do update
      set content = excluded.content, active = excluded.active, updated_at = now(),
          written_by = coalesce(excluded.written_by, agent_memories.written_by),
          source_run_id = coalesce(excluded.source_run_id, agent_memories.source_run_id)
    returning ${sql.unsafe(MEMORY_COLUMNS)}
  `;
  return rows[0];
}

/**
 * The one memory a key names for this reach: the narrowest visible (a
 * person's own before a collection's before the shared one). Without a reach,
 * the shared one — so a by-key change from a review page or a seed never
 * reaches into someone's personal memory by accident.
 */
function byKey(agentId: string, key: string, reach?: MemoryReach) {
  const sql = getSql();
  return sql`(select id from agent_memories
     where agent_id = ${agentId} and key = ${key}
       and ${reach ? memoryReachPredicate(reach) : sql`scope = 'agent'`}
     order by ${sql.unsafe(NARROWEST_FIRST)} limit 1)`;
}

/** Move a memory between active and inactive work without rewriting it. */
export async function setMemoryActive(
  agentId: string,
  key: string,
  active: boolean,
  reach?: MemoryReach,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update agent_memories set active = ${active}, updated_at = now()
     where id = ${byKey(agentId, key, reach)}
  `;
  return rows.count > 0;
}

export async function setMemoryActiveById(id: string, active: boolean): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const sql = getSql();
  const rows = await sql`update agent_memories set active = ${active}, updated_at = now() where id = ${id}`;
  return rows.count > 0;
}

export async function forgetMemoryById(id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const sql = getSql();
  const rows = await sql`delete from agent_memories where id = ${id}`;
  return rows.count > 0;
}

/**
 * Widen a memory to everyone who uses the agent. An admin's act, recorded by
 * the caller: it can put what one person's run learned from a restricted
 * collection or a mailbox in front of everyone. Refused when a shared memory
 * under the same key exists — two facts with one name, the person decides.
 */
export async function shareMemory(id: string): Promise<{ ok: true } | { error: string }> {
  const m = await getMemory(id);
  if (!m) return { error: "That memory no longer exists." };
  if (m.scope === "agent") return { ok: true };
  const sql = getSql();
  try {
    await sql`update agent_memories set scope = 'agent', scope_ref = '', updated_at = now() where id = ${id}`;
    return { ok: true };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return { error: `A shared memory called "${m.key}" already exists. Forget one of the two first.` };
    }
    throw e;
  }
}

export interface AgentRosterRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  placement: Placement;
  functionName: string;
  owner: string;
  model: string | null;
  knowledgeCollections: string[];
  knowledgeAll: boolean;
  mcpServers: McpEntry[];
  memoriesLoaded: number;
  memoriesAside: number;
  skills: number;
  schedules: number;
  schedulesEnabled: number;
  scheduleError: string | null;
  runs7d: number;
  failed7d: number;
  spend7d: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  /** Runs per day for the last 7 days, oldest first (UTC days). */
  runsByDay: number[];
  /** Writes this agent has proposed that nobody has decided on yet. */
  pendingProposals: number;
  keepsMemory: boolean;
  pattern: PatternTag | null;
}

/**
 * Every agent with what it is equipped with and how it has been doing — one
 * query, so the agents overview reads as a roster rather than a list of names.
 */
export async function agentRoster(): Promise<AgentRosterRow[]> {
  const sql = getSql();
  return sql<AgentRosterRow[]>`
    select a.id, a.slug, a.name, a.description, a.enabled, a.placement, a.model,
           a.keeps_memory as "keepsMemory", a.pattern,
           a.function_name as "functionName", a.owner,
           a.knowledge_collections as "knowledgeCollections", a.knowledge_all as "knowledgeAll",
           a.mcp_servers as "mcpServers",
           (select count(*)::int from proposals p where p.agent_id = a.id and p.status = 'pending') as "pendingProposals",
           (select count(*)::int from agent_memories m where m.agent_id = a.id and m.active) as "memoriesLoaded",
           (select count(*)::int from agent_memories m where m.agent_id = a.id and not m.active) as "memoriesAside",
           (select count(*)::int from agent_skills k where k.agent_id = a.id) as skills,
           (select count(*)::int from agent_schedules c where c.agent_id = a.id) as schedules,
           (select count(*)::int from agent_schedules c where c.agent_id = a.id and c.enabled) as "schedulesEnabled",
           (select c.last_error from agent_schedules c
             where c.agent_id = a.id and c.last_error is not null
             order by c.updated_at desc limit 1) as "scheduleError",
           r.runs7d as "runs7d", r.failed7d as "failed7d", r.spend7d as "spend7d",
           last.at as "lastRunAt", last.status as "lastRunStatus",
           (select array_agg(coalesce(x.n, 0) order by d)
              from generate_series(current_date - 6, current_date, interval '1 day') d
              left join lateral (
                select count(*)::int as n from agent_sessions s
                 where s.agent_id = a.id
                   and coalesce(s.started_at, s.created_at)::date = d::date
              ) x on true) as "runsByDay"
      from agents a
      left join lateral (
        select count(*)::int as runs7d,
               count(*) filter (where s.status = 'failed')::int as failed7d,
               coalesce(sum(s.cost_usd), 0)::float8 as spend7d
          from agent_sessions s
         where s.agent_id = a.id
           and coalesce(s.started_at, s.created_at) > now() - interval '7 days'
      ) r on true
      left join lateral (
        select coalesce(s.started_at, s.created_at) as at, s.status
          from agent_sessions s where s.agent_id = a.id
         order by coalesce(s.started_at, s.created_at) desc limit 1
      ) last on true
     order by a.enabled desc, a.name
  `;
}

/** Every function and owner in use, for the form's suggestions. */
export async function agentOrgLabels(): Promise<{ functions: string[]; owners: string[] }> {
  const sql = getSql();
  const rows = await sql<{ functions: string[] | null; owners: string[] | null }[]>`
    select (select array_agg(distinct function_name order by function_name) from agents where function_name <> '') as functions,
           (select array_agg(distinct owner order by owner) from agents where owner <> '') as owners
  `;
  return { functions: rows[0]?.functions ?? [], owners: rows[0]?.owners ?? [] };
}

export interface AgentRun {
  id: string;
  /** Who the run was for (the person, or a schedule's owner); null for a workbench run. */
  principalId: string | null;
  /** Their name, for "a run by …" where the prompt itself is not shown. */
  askedBy: string | null;
  at: string;
  prompt: string;
  status: string;
  costUsd: number | null;
  latencyMs: number | null;
  skill: string | null;
  error: string | null;
}

/** An agent's most recent runs, newest first. */
export async function listAgentRuns(agentId: string, limit = 12): Promise<AgentRun[]> {
  const sql = getSql();
  return sql<AgentRun[]>`
    select s.id, coalesce(s.started_at, s.created_at) as at, s.prompt, s.status,
           s.cost_usd::float8 as "costUsd", s.latency_ms as "latencyMs",
           k.name as skill, s.error, s.principal_id as "principalId", coalesce(nullif(pr.display_name, ''), pr.email, s.principal_id) as "askedBy"
      from agent_sessions s
      left join agent_skills k on k.id = s.agent_skill_id
      left join principals pr on pr.id = s.principal_id
     where s.agent_id = ${agentId}
     order by coalesce(s.started_at, s.created_at) desc
     limit ${limit}
  `;
}

export interface HubDay {
  /** YYYY-MM-DD, in the database's time zone. */
  day: string;
  runs: number;
  failed: number;
  spend: number;
}

/**
 * Runs, failures and spend per day across every agent, oldest first, with the
 * empty days filled in — for the Overview's activity chart.
 */
export async function hubActivity(days = 14): Promise<HubDay[]> {
  const sql = getSql();
  const span = Math.max(1, Math.min(Math.trunc(days), 90));
  return sql<HubDay[]>`
    select to_char(d, 'YYYY-MM-DD') as day,
           coalesce(x.runs, 0) as runs, coalesce(x.failed, 0) as failed, coalesce(x.spend, 0) as spend
      from generate_series(current_date - ${span - 1}::int, current_date, interval '1 day') d
      left join lateral (
        select count(*)::int as runs,
               count(*) filter (where s.status = 'failed')::int as failed,
               coalesce(sum(s.cost_usd), 0)::float8 as spend
          from agent_sessions s
         where coalesce(s.started_at, s.created_at)::date = d::date
      ) x on true
     order by d
  `;
}

export interface HubRun extends AgentRun {
  agentName: string | null;
  agentSlug: string | null;
}

/** The latest runs across the whole hub, newest first, with the agent that made each. */
export async function listRecentRuns(limit = 8): Promise<HubRun[]> {
  const sql = getSql();
  return sql<HubRun[]>`
    select s.id, coalesce(s.started_at, s.created_at) as at, s.prompt, s.status,
           s.cost_usd::float8 as "costUsd", s.latency_ms as "latencyMs",
           k.name as skill, s.error, a.name as "agentName", a.slug as "agentSlug", s.principal_id as "principalId", coalesce(nullif(pr.display_name, ''), pr.email, s.principal_id) as "askedBy"
      from agent_sessions s
      left join agents a on a.id = s.agent_id
      left join agent_skills k on k.id = s.agent_skill_id
      left join principals pr on pr.id = s.principal_id
     order by coalesce(s.started_at, s.created_at) desc
     limit ${limit}
  `;
}

/**
 * Which agents retrieve from which knowledge collection — one row per pair,
 * for the Knowledge page. Agents reading "everything" name no collection and
 * so do not appear: the page asks who works out of this drawer, not who could.
 */
export async function listAgentKnowledgeScopes(): Promise<{ name: string; slug: string; collection: string }[]> {
  const sql = getSql();
  return sql<{ name: string; slug: string; collection: string }[]>`
    select a.name, a.slug, c.collection
      from agents a, unnest(a.knowledge_collections) as c(collection)
     where not a.knowledge_all
     order by a.name, c.collection
  `;
}

export const MEMORY_REGIONS = ["projects", "people", "rules", "routines"] as const;
export type MemoryRegion = (typeof MEMORY_REGIONS)[number];

/**
 * File a memory under a region of the Context map, or null to untag it. Not a
 * change to what the memory says, so updated_at is left alone.
 */
export async function setMemoryRegion(
  agentId: string,
  key: string,
  region: MemoryRegion | null,
  reach?: MemoryReach,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update agent_memories set region = ${region}
     where id = ${byKey(agentId, key, reach)}
  `;
  return rows.count > 0;
}

export async function setMemoryRegionById(id: string, region: MemoryRegion | null): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const sql = getSql();
  const rows = await sql`update agent_memories set region = ${region} where id = ${id}`;
  return rows.count > 0;
}

export async function forgetMemory(agentId: string, key: string, reach?: MemoryReach): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    delete from agent_memories where id = ${byKey(agentId, key, reach)}
  `;
  return rows.count > 0;
}

/**
 * Substring search over an agent's memories.
 *
 * Deliberately not vector search: memories are short, few, and keyed by a name
 * the agent chose, so exact-ish matching beats an embedding round trip — and it
 * works without an embeddings key, which the whole memory feature otherwise
 * would not.
 */
export async function searchMemories(
  agentId: string,
  query: string,
  limit = 20,
  reach?: MemoryReach,
): Promise<AgentMemory[]> {
  const sql = getSql();
  const term = `%${query.trim()}%`;
  return sql<AgentMemory[]>`
    select ${sql.unsafe(MEMORY_COLUMNS)}
    from agent_memories
    where agent_id = ${agentId} and ${memoryReachPredicate(reach)}
      and (key ilike ${term} or content ilike ${term})
    order by updated_at desc
    limit ${limit}
  `;
}

// ── local activity ──────────────────────────────────────────────────────────
// One row per tool call a local agent made through the hub. See schema.sql for
// why this is not agent_sessions.

export interface LocalCallInput {
  agentId: string;
  principalId: string | null;
  tool: string;
  ok: boolean;
  latencyMs: number;
}

export async function recordLocalCall(input: LocalCallInput): Promise<void> {
  const sql = getSql();
  await sql`
    insert into agent_local_calls (agent_id, principal_id, tool, ok, latency_ms)
    values (${input.agentId}, ${input.principalId}, ${input.tool}, ${input.ok},
            ${Math.round(input.latencyMs)})
  `;
}

export interface LocalActivity {
  calls: number;
  failed: number;
  people: number;
  lastAt: string | null;
}

/** What a local agent did through the hub in the last `days` days. */
export async function localActivity(agentId: string, days = 30): Promise<LocalActivity> {
  const sql = getSql();
  const [row] = await sql<LocalActivity[]>`
    select count(*)::int                          as calls,
           count(*) filter (where not ok)::int    as failed,
           count(distinct principal_id)::int      as people,
           max(at)                                as "lastAt"
      from agent_local_calls
     where agent_id = ${agentId}
       and at > now() - make_interval(days => ${days})
  `;
  return row ?? { calls: 0, failed: 0, people: 0, lastAt: null };
}
