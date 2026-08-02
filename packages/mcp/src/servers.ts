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
] as const;

const BUILTIN = new Set<string>(BUILTIN_SERVER_NAMES);

export function builtinServerConfig(name: string): McpStdioConfig | null {
  if (!BUILTIN.has(name)) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, "..", "servers", name, "server.mjs");
  return { name, command: process.execPath, args: [serverPath] };
}
