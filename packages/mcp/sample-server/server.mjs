// A minimal sample MCP server (stdio transport) used to prove the hub's
// tool-call loop end to end. Plain JS so it runs directly under `node`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "hub-sample", version: "0.1.0" });

server.registerTool(
  "add",
  {
    description: "Add two numbers and return the sum.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "current_time",
  {
    description: "Return the current UTC time as an ISO-8601 string.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
