import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectMcpServers, isHttpConfig, type McpServerConfig, type McpToolInfo } from "@ai-hub/mcp";
import { text } from "@/lib/mcp/memoryTools";

/*
 * Another system's MCP tools, re-served by the hub.
 *
 * Used by both hub endpoints — /api/mcp for a signed-in person, and
 * /api/mcp/agents/<slug> for a synced sub-agent — so the two forward a call
 * the same way. The hub is a conduit here, not an authority: it dials the
 * upstream with whatever credential the caller resolved to (the person's own
 * token, or the hub's machine token when there is no person), and the upstream
 * decides what that credential may do.
 *
 * The one judgement the hub does make is `dropWrites`. An entry declared
 * read-only (pm-tool-read) is read-only because its token is; forward a
 * person's token instead and the upstream will offer the person's writes. So
 * the hub keeps only tools the upstream marks `readOnlyHint: true` — and a tool
 * with no annotation at all is dropped too, because "not proven read-only" is
 * the safe reading. An upstream that annotates nothing therefore yields no
 * tools through a read-only entry until it does; that is deliberate.
 */

// Claude Code lists tools on every connect and these endpoints are rebuilt
// per request, so without a cache every call would dial the upstream twice.
// Keyed by the credential as well as the server, because the upstream's tool
// list depends on who is asking. Short: a person's token expires in minutes.
const LIST_TTL_MS = 60_000;
const listCache = new Map<string, { at: number; tools: McpToolInfo[] }>();

function cacheKey(config: McpServerConfig): string {
  const auth = isHttpConfig(config) ? (config.headers?.authorization ?? "") : "";
  // Hashed so the cache never holds a usable credential.
  return `${config.name}|${createHash("sha256").update(auth).digest("hex").slice(0, 16)}`;
}

/** The upstream's tool list, as it describes it, briefly cached. */
export async function upstreamTools(config: McpServerConfig): Promise<McpToolInfo[]> {
  const key = cacheKey(config);
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.tools;
  const mcp = await connectMcpServers([config]);
  try {
    listCache.set(key, { at: Date.now(), tools: mcp.details });
    return mcp.details;
  } finally {
    await mcp.close();
  }
}

/**
 * An upstream tool's JSON Schema as the zod schema McpServer wants.
 *
 * The client sees it re-serialised, so it has to round-trip; a schema zod cannot
 * read becomes a loose object, which still lists the tool and still forwards the
 * arguments — the upstream validates them either way.
 */
export function schemaFrom(json: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.looseObject({});
  }
}

export const isReadOnlyTool = (t: McpToolInfo) => t.annotations?.readOnlyHint === true;

export interface ProxyOptions {
  /** How to dial the upstream, credential included. */
  config: McpServerConfig;
  /** Keep only tools the upstream marks read-only (see the file comment). */
  dropWrites: boolean;
  /** Names already registered on the server; a clash keeps the existing tool. */
  taken: Set<string>;
  /** Wraps each handler — the endpoints use it to log calls and to hold writes. */
  wrap?: (name: string, fn: (args: unknown) => Promise<unknown>, tool: McpToolInfo) => (args: unknown) => Promise<unknown>;
  /** The upstream could not be reached; it is skipped rather than failing the endpoint. */
  onUnavailable?: (err: unknown) => void;
}

/**
 * Register the upstream's tools on `server`, each forwarding to a fresh
 * connection dialled with `config`. Returns the names registered.
 */
export async function registerProxiedTools(server: McpServer, opts: ProxyOptions): Promise<string[]> {
  let tools: McpToolInfo[];
  try {
    tools = await upstreamTools(opts.config);
  } catch (err) {
    opts.onUnavailable?.(err);
    return [];
  }

  const wrap = opts.wrap ?? ((_name, fn) => fn);
  const registered: string[] = [];
  for (const tool of tools) {
    // The hub's own tools keep their namespace: an upstream cannot shadow
    // hub_memory_write by naming a tool after it.
    if (opts.taken.has(tool.name) || tool.name.startsWith("hub_")) continue;
    if (opts.dropWrites && !isReadOnlyTool(tool)) continue;
    opts.taken.add(tool.name);
    registered.push(tool.name);

    const config = opts.config;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: schemaFrom(tool.inputSchema) as never,
        ...(tool.annotations ? { annotations: tool.annotations as never } : {}),
      },
      wrap(tool.name, async (args: unknown) => {
        const mcp = await connectMcpServers([config]);
        try {
          const out = await mcp.execute(tool.name, args ?? {});
          return { ...text(out), isError: out.startsWith("Tool error:") };
        } finally {
          await mcp.close();
        }
      }, tool) as never,
    );
  }
  return registered;
}
