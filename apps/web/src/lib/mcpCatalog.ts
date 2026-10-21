import { connectMcpServers, remoteServerInfo, type McpServerConfig } from "@ai-hub/mcp";
import { listMcpServers, upsertMcpServer } from "@ai-hub/db";
import { resolveServer } from "@/lib/runSession";

// Read-only introspection of the MCP servers for the explorer UI. Connect to a
// server, list its tools, tear it down — so the UI shows real tool metadata,
// not a hand-maintained copy. Works for local (stdio) and remote (HTTP) alike.

export function resolveServerConfig(name: string): McpServerConfig | null {
  return resolveServer(name);
}

/**
 * The control-plane registry, with any declared remote servers registered first.
 * schema.sql seeds nothing: every server here is either declared in
 * HUB_REMOTE_MCP_SERVERS and upserted on read — otherwise a connected client
 * system would be invisible in the hub until someone wrote SQL — or was added
 * to the table by hand.
 */
/** Names declared in HUB_REMOTE_MCP_SERVERS — the ones the registry re-creates on read. */
export function declaredRemoteNames(): string[] {
  return remoteServerInfo().map((r) => r.name);
}

export async function listRegisteredServers() {
  const remotes = remoteServerInfo();
  await Promise.all(
    remotes.map((r) =>
      upsertMcpServer(r.name, r.label, r.description).catch((e) => {
        console.warn(`[mcp] could not register remote server "${r.name}":`, e);
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

/**
 * How long introspection waits for a server to answer.
 *
 * connectMcpServers has no deadline of its own, which is right for an agent run
 * (a slow server is still a server) and wrong for a page: a stdio child that
 * never finishes starting, or a remote that does not answer, held /mcp open
 * indefinitely — the click appeared to do nothing, so people clicked again,
 * which restarted the wait. Six seconds is longer than any healthy server
 * takes to say hello and shorter than anyone waits for a page.
 */
const INTROSPECT_DEADLINE_MS = 6000;

async function connectWithDeadline(cfg: McpServerConfig) {
  const connecting = connectMcpServers([cfg]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`"${cfg.name}" did not answer within ${INTROSPECT_DEADLINE_MS / 1000}s.`)),
      INTROSPECT_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([connecting, deadline]);
  } catch (err) {
    // A connect that completes after we gave up must still be torn down, or
    // every timed-out visit leaks a child process.
    connecting.then((mcp) => mcp.close()).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Connects to a single server, returns its tools, and always closes the child.
export async function describeMcpServer(name: string): Promise<McpToolInfo[]> {
  const cfg = resolveServerConfig(name);
  if (!cfg) throw new Error(`Unknown MCP server: ${name}`);
  const mcp = await connectWithDeadline(cfg);
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
    const mcp = await connectWithDeadline(cfg);
    try {
      return mcp.tools.length;
    } finally {
      await mcp.close();
    }
  } catch {
    return null;
  }
}
