// Standalone verification of the MCP layer — no API key required. Spawns the
// sample server, lists its tools, and calls them directly through an MCP client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "sample-server", "server.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
});
const client = new Client({ name: "verify", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools discovered:", tools.map((t) => t.name).join(", "));

const sum = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
console.log("add(2, 3) =>", sum.content?.[0]?.text);

const now = await client.callTool({ name: "current_time", arguments: {} });
console.log("current_time() =>", now.content?.[0]?.text);

await client.close();

const ok = sum.content?.[0]?.text === "5";
console.log(ok ? "\nMCP layer OK" : "\nMCP layer FAILED");
process.exit(ok ? 0 : 1);
