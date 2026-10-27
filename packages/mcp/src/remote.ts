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
  /** This entry is meant to read only — see remoteServerReadOnly(). */
  readOnly: boolean;
  /** A signed-in person's token may be forwarded here — see RemoteEntry.forwardIdentity. */
  forwardIdentity: boolean;
}

/**
 * How to dial a remote server for one call.
 *
 * `bearer` is the signed-in person's access token. It replaces the entry's own
 * token ONLY for an entry that opts in with `forwardIdentity`; everywhere else
 * it is ignored and the entry's token is used, so a server nobody vouched for
 * never receives a token that is valid at the hub itself.
 */
export interface RemoteDialOptions {
  bearer?: string;
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
  /**
   * The entry exists to read, never to change anything. With the entry's own
   * token that is already enforced upstream (a read-scoped token is offered
   * no write tools); with a person's token forwarded instead, the upstream
   * offers whatever the person may do, and this is what tells the hub to
   * drop the write tools itself. Defaults to true for a name ending in
   * `-read`, so the existing pm-tool / pm-tool-read pair needs no change.
   */
  readOnly?: boolean;
  /**
   * The hub may hand this server a signed-in person's own access token, so
   * the server sees the person rather than the hub. OFF unless set, and the
   * reason is what that token is: it is valid at the hub's own /api/mcp, and
   * at any system that trusts the hub's audience. A server that receives it
   * could act as the person at both. So forwarding is a statement of trust in
   * the server, made per entry by whoever configures the deployment — the
   * PM-tool, which we run — and never implied by a server merely being listed.
   */
  forwardIdentity?: boolean;
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

/**
 * Why there are no remote servers, when the reason is the config itself.
 *
 * Failing closed on malformed JSON is right; failing silently is not. A run
 * whose agent names `pm-tool` while this returns a message should say so in
 * the output a person reads, instead of answering with no tools as if that
 * were the agent's configuration. Null when the variable is unset or parses.
 */
export function remoteConfigError(): string | null {
  const raw = process.env.HUB_REMOTE_MCP_SERVERS;
  if (!raw) return null;
  try {
    JSON.parse(raw);
    return null;
  } catch (err) {
    return `HUB_REMOTE_MCP_SERVERS is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
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
export function remoteServerConfig(name: string, options: RemoteDialOptions = {}): McpHttpConfig | null {
  const entry = loadEntries()[name];
  if (!entry?.url) return null;

  const token = options.bearer && entry.forwardIdentity === true ? options.bearer : bearerToken(entry);
  const headers: Record<string, string> = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(entry.headers ?? {}),
  };
  return { name, url: entry.url, headers };
}

/** Whether an entry is meant to read only; see RemoteEntry.readOnly. */
export function remoteServerReadOnly(name: string): boolean {
  const entry = loadEntries()[name];
  if (!entry) return false;
  return entry.readOnly ?? /-read$/.test(name);
}

/** Whether a person's token may be forwarded to this entry; see RemoteEntry.forwardIdentity. */
export function remoteServerForwardsIdentity(name: string): boolean {
  return loadEntries()[name]?.forwardIdentity === true;
}

/** Declared remote servers, for the admin/registry view. */
export function remoteServerInfo(): RemoteServerInfo[] {
  return Object.entries(loadEntries()).map(([name, entry]) => ({
    name,
    label: entry.label ?? name,
    description: entry.description ?? "",
    url: entry.url!,
    configured: Boolean(bearerToken(entry)) || Boolean(entry.headers),
    readOnly: remoteServerReadOnly(name),
    forwardIdentity: entry.forwardIdentity === true,
  }));
}
