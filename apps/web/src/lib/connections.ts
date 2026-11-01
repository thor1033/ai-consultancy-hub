import { ASK_SERVER, listHubConnections } from "@ai-hub/db";
import { BUILTIN_SERVER_NAMES, isEnvRemoteServer, setHubRemoteServers, type HubRemoteServer } from "@ai-hub/mcp";
import { openSecret } from "@/lib/secretBox";

/*
 * Connections added on the Connections page (docs/connections.md): remote MCP
 * servers declared in the database, their address and token sealed
 * (lib/secretBox.ts). This module opens them and hands them to the registry in
 * @ai-hub/mcp, which every reader — a run, the hub's MCP server, the pages —
 * already consults.
 *
 * The registry is read synchronously, so this is loaded ahead of the readers,
 * at the places that start work: a run, a page that lists servers, the hub's
 * MCP server, saving an agent. Cached for a few seconds, which is as stale as
 * another machine of the same deployment can be after an admin changes one;
 * the machine that made the change reloads at once.
 *
 * Fails closed per connection: one whose address or token no longer opens is
 * kept out of the registry and reported with the reason, so a run that names
 * it says why rather than calling it undeclared. A database that cannot be
 * read keeps the last good list.
 */

const MAX_AGE_MS = 5_000;

const STATE_KEY = Symbol.for("ai-hub.web.hubConnections");
type State = { at: number; inflight: Promise<void> | null };
const state = (): State => {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[STATE_KEY] ??= { at: 0, inflight: null });
};

export const urlPurpose = (name: string) => `mcp:${name}:url`;
export const tokenPurpose = (name: string) => `mcp:${name}:token`;

async function load(): Promise<void> {
  const rows = await listHubConnections();
  const servers: Record<string, HubRemoteServer> = {};
  const problems: Record<string, string> = {};
  for (const r of rows) {
    try {
      servers[r.name] = {
        url: openSecret(r.urlSealed, urlPurpose(r.name)),
        token: r.tokenSealed ? openSecret(r.tokenSealed, tokenPurpose(r.name)) : null,
        label: r.label || r.name,
        description: r.description,
      };
    } catch (e) {
      problems[r.name] = `its saved address or token cannot be read (${e instanceof Error ? e.message : String(e)}); enter them again on its Connections page`;
    }
  }
  setHubRemoteServers(servers, problems);
}

/** Make sure the registry holds the page-added connections, at most a few seconds old. */
export async function loadHubConnections(opts: { force?: boolean } = {}): Promise<void> {
  const s = state();
  if (!opts.force && Date.now() - s.at < MAX_AGE_MS) return;
  if (s.inflight) return s.inflight;
  s.inflight = load()
    .then(() => {
      s.at = Date.now();
    })
    .catch((e) => {
      // Keep what was loaded last; try again on the next call.
      console.warn("[connections] could not load connections added on the page:", e);
    })
    .finally(() => {
      s.inflight = null;
    });
  return s.inflight;
}

/** Names a connection may not take: the hub's own servers, the ask entry, memory, and the deployment's declared ones. */
export function reservedConnectionName(name: string): string | null {
  if (name === "memory" || name === ASK_SERVER) return `"${name}" is the hub's own and cannot be a connection's name.`;
  if (BUILTIN_SERVER_NAMES.includes(name)) return `"${name}" is a server bundled with the hub.`;
  if (isEnvRemoteServer(name)) return `"${name}" is already declared by this deployment's settings.`;
  return null;
}

/**
 * The address a connection may dial. HTTPS, except plain HTTP to this machine
 * (a server running beside the hub in development). No user:password in it —
 * that belongs in the token field, which is sealed on its own.
 */
export function checkConnectionUrl(raw: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "That is not a web address. It should start with https://" };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { error: "The address must start with https:// (plain http:// only to this machine, for testing)." };
  }
  if (u.username || u.password) return { error: "Put the password or key in the token field, not in the address." };
  return { url: u.toString() };
}

/** A connection's name from its label: what agents and tool lists refer to it by. */
export function connectionName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export const CONNECTION_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
