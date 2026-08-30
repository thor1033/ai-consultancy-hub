import { getSql } from "./client";

// Standing agents and the memory they keep between conversations. Agents are now
// the hub's only unit of work; nothing here is versioned, because an agent is a
// thing that changes as it goes rather than a release you pin.

/**
 * One entry in an agent's stored MCP server list. Deliberately open: a bare
 * `{name}` marker for a server the hub resolves itself, and room for a connector
 * to carry its own fields without a migration.
 */
export type McpEntry = Record<string, unknown>;

export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Agent extends AgentSummary {
  instructions: string;
  model: string | null;
  effort: string | null;
  mcpServers: McpEntry[];
  knowledgeCollection: string | null;
}

export interface AgentMemory {
  id: string;
  key: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInput {
  slug: string;
  name: string;
  description?: string;
  instructions?: string;
  model?: string | null;
  effort?: string | null;
  mcpServers?: McpEntry[];
  knowledgeCollection?: string | null;
  enabled?: boolean;
}

// Unqualified on purpose: this list is reused in a RETURNING clause, where
// there is no table alias to qualify against.
const AGENT_COLUMNS = `
  id, slug, name, description, instructions, model, effort,
  mcp_servers as "mcpServers", knowledge_collection as "knowledgeCollection",
  enabled, created_at as "createdAt", updated_at as "updatedAt"
`;

export async function listAgents(): Promise<AgentSummary[]> {
  const sql = getSql();
  // The memory count is what tells a reader an agent has actually been used,
  // so it belongs in the list rather than one level down.
  return sql<AgentSummary[]>`
    select a.id, a.slug, a.name, a.description, a.enabled,
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
                        mcp_servers, knowledge_collection, enabled)
    values (${input.slug}, ${input.name}, ${input.description ?? ""},
            ${input.instructions ?? ""}, ${input.model ?? null}, ${input.effort ?? null},
            ${sql.json((input.mcpServers ?? []) as Parameters<typeof sql.json>[0])},
            ${input.knowledgeCollection ?? null}, ${input.enabled ?? true})
    returning ${sql.unsafe(AGENT_COLUMNS)}, 0 as "memoryCount"
  `;
  return rows[0];
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
      knowledge_collection = ${next.knowledgeCollection ?? null},
      enabled = ${next.enabled ?? true},
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

export async function listMemories(agentId: string): Promise<AgentMemory[]> {
  const sql = getSql();
  return sql<AgentMemory[]>`
    select id, key, content, created_at as "createdAt", updated_at as "updatedAt"
    from agent_memories
    where agent_id = ${agentId}
    order by updated_at desc
  `;
}

/** Upsert by key — an agent correcting itself replaces the fact, never doubles it. */
export async function rememberMemory(
  agentId: string,
  key: string,
  content: string,
): Promise<AgentMemory> {
  const sql = getSql();
  const rows = await sql<AgentMemory[]>`
    insert into agent_memories (agent_id, key, content)
    values (${agentId}, ${key}, ${content})
    on conflict (agent_id, key) do update
      set content = excluded.content, updated_at = now()
    returning id, key, content, created_at as "createdAt", updated_at as "updatedAt"
  `;
  return rows[0];
}

export async function forgetMemory(agentId: string, key: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    delete from agent_memories where agent_id = ${agentId} and key = ${key}
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
): Promise<AgentMemory[]> {
  const sql = getSql();
  const term = `%${query.trim()}%`;
  return sql<AgentMemory[]>`
    select id, key, content, created_at as "createdAt", updated_at as "updatedAt"
    from agent_memories
    where agent_id = ${agentId}
      and (key ilike ${term} or content ilike ${term})
    order by updated_at desc
    limit ${limit}
  `;
}
