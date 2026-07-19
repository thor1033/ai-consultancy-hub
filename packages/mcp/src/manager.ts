import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A tailored MCP server the hub connects to over stdio (a child process).
// Remote (Streamable HTTP) servers can be added later behind the same interface.
export interface McpStdioConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// The result of connecting: Anthropic-shaped tool defs + an executor that
// proxies a tool call back to the owning MCP server, plus a close() to tear
// down the child processes.
export interface ConnectedMcp {
  tools: Anthropic.Tool[];
  execute(name: string, input: unknown): Promise<string>;
  close(): Promise<void>;
}

function inheritedEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...(extra ?? {}) };
}

/**
 * Connects to one or more MCP servers, discovers their tools, and returns them
 * as Anthropic tools plus an executor. Tool names are assumed unique across
 * servers for the MVP; duplicates keep the first and warn.
 */
export async function connectMcpServers(
  configs: McpStdioConfig[],
): Promise<ConnectedMcp> {
  const clients: Client[] = [];
  const toolToClient = new Map<string, Client>();
  const tools: Anthropic.Tool[] = [];

  for (const cfg of configs) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: inheritedEnv(cfg.env),
    });
    const client = new Client({ name: `ai-hub-${cfg.name}`, version: "0.1.0" });
    await client.connect(transport);
    clients.push(client);

    const listed = await client.listTools();
    for (const t of listed.tools) {
      if (toolToClient.has(t.name)) {
        console.warn(`[mcp] duplicate tool name "${t.name}" — keeping the first`);
        continue;
      }
      toolToClient.set(t.name, client);
      tools.push({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      });
    }
  }

  return {
    tools,
    async execute(name, input) {
      const client = toolToClient.get(name);
      if (!client) return `Unknown tool: ${name}`;

      const result = await client.callTool({
        name,
        arguments: (input ?? {}) as Record<string, unknown>,
      });

      const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      return result.isError ? `Tool error: ${text}` : text;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}
