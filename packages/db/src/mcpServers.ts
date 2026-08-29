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
