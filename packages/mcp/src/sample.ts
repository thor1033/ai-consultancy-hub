import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpStdioConfig } from "./manager";

// Config for the bundled sample MCP server (a dev/demo artifact that proves the
// tool-call loop). Real tailored MCP servers are configured per client and run
// as their own deployments. Path is overridable for non-dev bundling.
export function sampleMcpConfig(): McpStdioConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath =
    process.env.HUB_SAMPLE_MCP_PATH ??
    join(here, "..", "sample-server", "server.mjs");
  return { name: "sample", command: process.execPath, args: [serverPath] };
}
