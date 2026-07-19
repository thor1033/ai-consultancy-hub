import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpStdioConfig } from "./manager";

// Built-in demo MCP servers for the investment-firm use case. Referenced from a
// skill's stored config by bare name (e.g. {name:"market-data"}) and resolved to
// a runnable stdio config here.
const BUILTIN = new Set(["market-data", "customer-data", "pptx"]);

export function builtinServerConfig(name: string): McpStdioConfig | null {
  if (!BUILTIN.has(name)) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, "..", "servers", name, "server.mjs");
  return { name, command: process.execPath, args: [serverPath] };
}
