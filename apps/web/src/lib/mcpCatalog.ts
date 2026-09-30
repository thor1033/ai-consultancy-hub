import { connectMcpServers, remoteServerInfo, builtinServerInfo, type McpServerConfig } from "@ai-hub/mcp";
import { listMcpServers, upsertMcpServer } from "@ai-hub/db";
import { resolveServer } from "@/lib/runSession";

// Read-only introspection of the MCP servers for the explorer UI. Connect to a
// server, list its tools, tear it down — so the UI shows real tool metadata,
// not a hand-maintained copy. Works for local (stdio) and remote (HTTP) alike.

export function resolveServerConfig(name: string): McpServerConfig | null {
  return resolveServer(name);
}

/**
 * The control-plane registry, with every server this deployment actually has
 * registered first.
 *
 * schema.sql seeds nothing, so a server is in the table because it was upserted
 * here on read or added by hand. Two kinds are upserted:
 *
 *   REMOTE    whatever HUB_REMOTE_MCP_SERVERS declares. Without this a
 *             connected client system would be invisible in the hub until
 *             someone wrote SQL.
 *   BUILT-IN  the bundled stdio servers (@ai-hub/mcp, BUILTIN_SERVER_NAMES).
 *             These were missing, and the gap was not cosmetic: a run filters
 *             every server through disabledMcpServerNames(), so `microsoft365`
 *             was subject to the kill switch while having no row for anyone to
 *             flip. It simply did not appear on /mcp.
 *
 * Upserting does not overwrite `enabled` (see upsertMcpServer), so a server an
 * admin has switched off stays off across restarts.
 *
 * A row can still outlive its server — the demo servers deleted in the August
 * strip left theirs behind. Those show a tool count of "—" because nothing
 * resolves the name any more; deleting them is a manual, deliberate act.
 */
/** Names declared in HUB_REMOTE_MCP_SERVERS — the ones the registry re-creates on read. */
export function declaredRemoteNames(): string[] {
  return remoteServerInfo().map((r) => r.name);
}

/** Every server the registry re-creates on read, remote and bundled alike. */
export function registeredByCode(): { name: string; label: string; description: string }[] {
  return [
    ...builtinServerInfo(),
    ...remoteServerInfo().map((r) => ({ name: r.name, label: r.label, description: r.description })),
  ];
}

export async function listRegisteredServers() {
  await Promise.all(
    registeredByCode().map((s) =>
      upsertMcpServer(s.name, s.label, s.description).catch((e) => {
        console.warn(`[mcp] could not register server "${s.name}":`, e);
      }),
    ),
  );
  return listMcpServers();
}

export interface McpToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  params: McpToolParam[];
}

interface JsonSchema {
  properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
  required?: string[];
}

function schemaParams(schema: unknown): McpToolParam[] {
  const s = (schema ?? {}) as JsonSchema;
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: def?.type ?? (def?.enum ? "enum" : "any"),
    required: required.has(name),
    description: def?.description,
  }));
}

// Connects to a single server, returns its tools, and always closes the child.
export async function describeMcpServer(name: string): Promise<McpToolInfo[]> {
  const cfg = resolveServerConfig(name);
  if (!cfg) throw new Error(`Unknown MCP server: ${name}`);
  const mcp = await connectMcpServers([cfg]);
  try {
    return mcp.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      params: schemaParams(t.input_schema),
    }));
  } finally {
    await mcp.close();
  }
}

// Lean tool count for the overview cards — connect, count, close. Returns null
// if the server can't be reached (so the card can show "—" instead of failing).
export async function countMcpTools(name: string): Promise<number | null> {
  const cfg = resolveServerConfig(name);
  if (!cfg) return null;
  try {
    const mcp = await connectMcpServers([cfg]);
    try {
      return mcp.tools.length;
    } finally {
      await mcp.close();
    }
  } catch {
    return null;
  }
}
