import type { McpHttpConfig } from "./manager";

// Remote MCP servers: systems the *client* already runs, exposing their own
// capabilities to the hub over Streamable HTTP. The first one is the PM-tool
// (Atlas) — see docs/pm-tool-integration.md.
//
// Unlike the built-in servers (whose runnable config lives in code), a remote
// server is deployment-specific, so it's configured by env:
//
//   HUB_REMOTE_MCP_SERVERS='{
//     "pm-tool": {
//       "url": "http://localhost:3000/api/mcp",
//       "label": "PM-tool",
//       "description": "Read-only project delivery data (projects, tasks, risks).",
//       "tokenEnv": "PM_TOOL_MCP_TOKEN"
//     }
//   }'
//
// Fails closed, exactly like HUB_API_TOKENS: malformed config ⇒ no remote servers.

export interface RemoteServerInfo {
  name: string;
  label: string;
  description: string;
  url: string;
  /** False when the server is declared but its credential is missing. */
  configured: boolean;
}

interface RemoteEntry {
  url?: string;
  label?: string;
  description?: string;
  /** Inline bearer token. Prefer `tokenEnv` so the secret isn't inside a JSON blob. */
  token?: string;
  /** Name of another env var holding the bearer token (secrets-manager friendly). */
  tokenEnv?: string;
  /** Extra headers merged after the Authorization header. */
  headers?: Record<string, string>;
}

// Parsed per call rather than cached: the map is tiny, and a cached parse makes
// env changes in dev look like the config was ignored.
function loadEntries(): Record<string, RemoteEntry> {
  const raw = process.env.HUB_REMOTE_MCP_SERVERS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, RemoteEntry>;
    const out: Record<string, RemoteEntry> = {};
    for (const [name, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.url === "string") out[name] = entry;
    }
    return out;
  } catch {
    console.warn("[mcp] HUB_REMOTE_MCP_SERVERS is not valid JSON — no remote servers configured.");
    return {};
  }
}

function bearerToken(entry: RemoteEntry): string | undefined {
  if (entry.tokenEnv) return process.env[entry.tokenEnv] || undefined;
  return entry.token || undefined;
}

export function remoteServerNames(): string[] {
  return Object.keys(loadEntries());
}

export function isRemoteServer(name: string): boolean {
  return name in loadEntries();
}

/**
 * The runnable config for a remote server, or null if it isn't declared.
 *
 * The credential seam: today a static bearer token (mirroring HUB_API_TOKENS on
 * the hub's own API). Phase 2 mints a short-lived per-run JWT carrying the
 * principal + org + scope here instead — callers don't change.
 */
export function remoteServerConfig(name: string): McpHttpConfig | null {
  const entry = loadEntries()[name];
  if (!entry?.url) return null;

  const token = bearerToken(entry);
  const headers: Record<string, string> = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(entry.headers ?? {}),
  };
  return { name, url: entry.url, headers };
}

/** Declared remote servers, for the admin/registry view. */
export function remoteServerInfo(): RemoteServerInfo[] {
  return Object.entries(loadEntries()).map(([name, entry]) => ({
    name,
    label: entry.label ?? name,
    description: entry.description ?? "",
    url: entry.url!,
    configured: Boolean(bearerToken(entry)) || Boolean(entry.headers),
  }));
}
