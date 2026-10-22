import { getSql } from "./client";

// The MCP server control plane (see schema.sql). Runnable config lives in code
// (@ai-hub/mcp); this is the admin-owned overlay of which servers are exposed and
// whether each is enabled. Disabled servers are dropped from every run.

export interface McpServerRow {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listMcpServers(): Promise<McpServerRow[]> {
  const sql = getSql();
  return sql<McpServerRow[]>`
    select name, label, description, enabled,
           created_at as "createdAt",
           updated_at as "updatedAt"
    from mcp_servers
    order by name
  `;
}

/**
 * Register (or refresh the description of) a server in the control plane.
 * Used for remote servers, which are declared by deployment config rather than
 * seeded in schema.sql. `enabled` is deliberately NOT touched — an admin who
 * switched a server off keeps it off across restarts.
 */
export async function upsertMcpServer(
  name: string,
  label: string,
  description: string,
): Promise<void> {
  const sql = getSql();
  await sql`
    insert into mcp_servers (name, label, description)
    values (${name}, ${label}, ${description})
    on conflict (name) do update
      set label = excluded.label,
          description = excluded.description,
          updated_at = now()
  `;
}

export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update mcp_servers set enabled = ${enabled}, updated_at = now()
    where name = ${name}
  `;
  return rows.count > 0;
}

/**
 * Remove a server from the registry entirely.
 *
 * Deleting is not the same as disabling, and only one of them is durable for
 * every kind of server. A remote server declared in HUB_REMOTE_MCP_SERVERS is
 * re-registered by `listRegisteredServers()` the next time anyone opens /mcp —
 * the environment is the source of truth, not this table — so deleting one
 * removes the row until the next read and no longer. Callers should say so
 * rather than let the row quietly reappear. Disabling, which the reader honours,
 * is what actually stops a declared server from being used.
 */
export async function deleteMcpServer(name: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from mcp_servers where name = ${name}`;
  return rows.count > 0;
}

// The set of server names that are currently switched off — the enforcement hook
// callers use to drop disabled servers before connecting. Missing rows are
// treated as enabled (a server present in code but not yet seeded still runs).
export async function disabledMcpServerNames(): Promise<Set<string>> {
  const sql = getSql();
  const rows = await sql<{ name: string }[]>`
    select name from mcp_servers where enabled = false
  `;
  return new Set(rows.map((r) => r.name));
}

// --- usage -------------------------------------------------------------------
//
// Read from agent_sessions: `mcp_servers` is what a run connected to and
// `tools_used` what it actually called. Tool names are not prefixed with their
// server, so per-tool counts are matched against a server's live tool list by
// the page that has one.

export interface ServerUsage {
  name: string;
  /** Runs in the window that connected to this server. */
  runs: number;
  /** The most recent run that connected to it, ever. */
  lastUsedAt: string | null;
}

export async function serverUsage(days = 7): Promise<ServerUsage[]> {
  const sql = getSql();
  const span = Math.max(1, Math.min(Math.trunc(days), 365));
  return sql<ServerUsage[]>`
    select srv as name,
           (count(*) filter (where coalesce(s.started_at, s.created_at) > now() - make_interval(days => ${span}::int)))::int as runs,
           max(coalesce(s.started_at, s.created_at)) as "lastUsedAt"
      from agent_sessions s, jsonb_array_elements_text(s.mcp_servers) srv
     group by srv
  `;
}

export interface ToolCallCount {
  tool: string;
  calls: number;
  lastAt: string;
}

/** How often each tool was called in the window, busiest first. */
export async function toolCallCounts(days = 30): Promise<ToolCallCount[]> {
  const sql = getSql();
  const span = Math.max(1, Math.min(Math.trunc(days), 365));
  return sql<ToolCallCount[]>`
    select t as tool, count(*)::int as calls, max(coalesce(s.started_at, s.created_at)) as "lastAt"
      from agent_sessions s, jsonb_array_elements_text(s.tools_used) t
     where coalesce(s.started_at, s.created_at) > now() - make_interval(days => ${span}::int)
     group by t
     order by calls desc, t
  `;
}

export interface ServerRun {
  id: string;
  at: string;
  prompt: string;
  status: string;
  toolsUsed: string[];
  agentName: string | null;
  agentSlug: string | null;
}

/** The latest runs that connected to one server, newest first. */
export async function listServerRuns(name: string, limit = 8): Promise<ServerRun[]> {
  const sql = getSql();
  return sql<ServerRun[]>`
    select s.id, coalesce(s.started_at, s.created_at) as at, s.prompt, s.status,
           s.tools_used as "toolsUsed", a.name as "agentName", a.slug as "agentSlug"
      from agent_sessions s
      left join agents a on a.id = s.agent_id
     where s.mcp_servers ? ${name}
     order by coalesce(s.started_at, s.created_at) desc
     limit ${limit}
  `;
}
