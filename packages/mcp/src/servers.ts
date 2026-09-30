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

export interface BuiltinServerInfo {
  name: string;
  label: string;
  description: string;
}

/**
 * What the control plane needs to show a built-in server.
 *
 * `mcp_servers` is the admin-owned overlay — which servers exist and whether
 * each is currently enabled — and `disabledMcpServerNames()` is applied to
 * EVERY server a run resolves, built-in ones included. So a built-in with no row
 * was subject to the kill switch while being invisible in the console that
 * operates it: `/mcp` upserted the remote servers it found in the environment
 * and nothing else, so `microsoft365` never appeared and could never be turned
 * off from the UI.
 *
 * Kept next to BUILTIN_SERVER_NAMES rather than in the web app so that adding a
 * bundled server is still one edit in one file. A name here with no entry is a
 * bug the verifier catches.
 *
 * Not included: `sample`, which is a dev artifact resolved by a special case in
 * runSession rather than a member of this list, and `memory`, which is scoped to
 * one agent and deliberately not resolvable by name at all (see below).
 */
export function builtinServerInfo(): BuiltinServerInfo[] {
  return [
    {
      name: "microsoft365",
      label: "Microsoft 365",
      description:
        "One mailbox and its calendar. Reads what has arrived and what is coming up, and writes a reply into Drafts — it cannot send. Needs the M365_* credentials.",
    },
  ];
}

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
