import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpStdioConfig } from "./manager";

// Servers resolvable from a bare name, as a stdio child process.
//
// `microsoft365` is the secretary agent's read-only mailbox and calendar. It is
// listed here rather than in HUB_REMOTE_MCP_SERVERS because it is ours: the code
// lives in ../servers/microsoft365, and what it may do is a property of that file
// rather than of a URL someone configured. Its credentials still come from the
// environment (M365_*), and it exits 1 when they are missing, so an unconfigured
// deployment gets a connection error naming the missing variable instead of a
// server that silently answers nothing.
//
// `teams` is the same shape for Microsoft Teams: meeting transcripts and the
// team's SharePoint files, read-only, on the same M365_* app registration. Each
// half is fenced by Microsoft (an access policy for one organiser's meetings,
// Sites.Selected for one site) and switched on by its own variable.
//
// What is NOT here: `memory`, which is deliberately not resolvable by name (see
// below), and whatever HUB_REMOTE_MCP_SERVERS declares over HTTP. Adding a new
// bundled server means dropping it in ../servers/<name>/server.mjs and naming it
// here.
export const BUILTIN_SERVER_NAMES: readonly string[] = ["microsoft365", "teams"];

/** Bundled servers that read one mailbox, and so take a per-agent `mailbox`. */
export const MAILBOX_SERVER_NAMES: readonly string[] = ["microsoft365"];

const BUILTIN = new Set<string>(BUILTIN_SERVER_NAMES);

/**
 * What an agent's own entry for a bundled server may vary.
 *
 * `mailbox` is the only one so far. The credentials (tenant, client, secret)
 * stay in the deployment's environment — one app registration, fenced by one
 * Exchange access policy — and the agent's entry says WHICH mailbox inside that
 * fence it reads: `{"name":"microsoft365","mailbox":"secretary@…"}`. Omitted,
 * the deployment's M365_MAILBOX is the default, so a single-mailbox deployment
 * configures nothing new.
 */
export interface BuiltinServerOptions {
  mailbox?: string;
}

/** The options an agent's stored entry carries, ignoring anything else in it. */
export function builtinOptionsFrom(entry: unknown): BuiltinServerOptions {
  if (!entry || typeof entry !== "object") return {};
  const mailbox = (entry as { mailbox?: unknown }).mailbox;
  return typeof mailbox === "string" && mailbox.trim() ? { mailbox: mailbox.trim() } : {};
}

function serverEntry(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "servers", name, "server.mjs");
}

export function builtinServerConfig(
  name: string,
  options: BuiltinServerOptions = {},
): McpStdioConfig | null {
  if (!BUILTIN.has(name)) return null;
  const config: McpStdioConfig = { name, command: process.execPath, args: [serverEntry(name)] };
  // The child inherits the process environment and this overlays it, so the
  // agent's mailbox wins over M365_MAILBOX for this run and nothing else moves.
  if (name === "microsoft365" && options.mailbox) config.env = { M365_MAILBOX: options.mailbox };
  return config;
}

/**
 * The memory server for one agent.
 *
 * Kept out of BUILTIN_SERVER_NAMES because it cannot be resolved by name alone:
 * memory is scoped to an agent, and the scope travels in the environment rather
 * than as a tool argument so a model can never reach another agent's memory by
 * asking. A session with no agent therefore has no memory server, and that is
 * the correct behaviour rather than a gap.
 */
export function memoryServerConfig(agentId: string): McpStdioConfig {
  return {
    name: "memory",
    command: process.execPath,
    args: [serverEntry("memory")],
    env: { HUB_AGENT_ID: agentId },
  };
}
