import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpStdioConfig } from "./manager";

// Built-in demo MCP servers for the investment-firm use case. Referenced from a
// skill's stored config by bare name (e.g. {name:"market-data"}) and resolved to
// a runnable stdio config here.
export const BUILTIN_SERVER_NAMES = [
  "market-data",
  "customer-data",
  "pptx",
  "pptx-template",
] as const;

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
 * asking. A workbench session with no agent therefore has no memory server, and
 * that is the correct behaviour rather than a gap.
 */
export function memoryServerConfig(agentId: string): McpStdioConfig {
  return {
    name: "memory",
    command: process.execPath,
    args: [serverEntry("memory")],
    env: { HUB_AGENT_ID: agentId },
  };
}
