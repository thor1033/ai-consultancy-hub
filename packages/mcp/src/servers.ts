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
// What is NOT here: `memory`, which is deliberately not resolvable by name (see
// below), and whatever HUB_REMOTE_MCP_SERVERS declares over HTTP. Adding a new
// bundled server means dropping it in ../servers/<name>/server.mjs and naming it
// here.
export const BUILTIN_SERVER_NAMES: readonly string[] = ["microsoft365"];

const BUILTIN = new Set<string>(BUILTIN_SERVER_NAMES);

function serverEntry(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "servers", name, "server.mjs");
}

export function builtinServerConfig(name: string): McpStdioConfig | null {
  if (!BUILTIN.has(name)) return null;
  return { name, command: process.execPath, args: [serverEntry(name)] };
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
