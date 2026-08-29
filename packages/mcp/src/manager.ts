import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A tailored MCP server the hub connects to over stdio (a child process).
export interface McpStdioConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// A remote MCP server the hub connects to over Streamable HTTP — a system the
// client already runs (the PM-tool is the first), exposing its own capabilities.
// `headers` carries the credential; see remote.ts for where it comes from.
export interface McpHttpConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export function isHttpConfig(cfg: McpServerConfig): cfg is McpHttpConfig {
  return typeof (cfg as McpHttpConfig).url === "string";
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
  configs: McpServerConfig[],
): Promise<ConnectedMcp> {
  const clients: Client[] = [];
  const toolToClient = new Map<string, Client>();
  const tools: Anthropic.Tool[] = [];

  for (const cfg of configs) {
    const transport = isHttpConfig(cfg)
      ? new StreamableHTTPClientTransport(new URL(cfg.url), {
          // The credential travels on every request — remote servers are called
          // statelessly (no session resumption), so each call re-authenticates.
          requestInit: { headers: cfg.headers },
        })
      : new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: inheritedEnv(cfg.env),
        });
    const client = new Client({ name: `ai-hub-${cfg.name}`, version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (err) {
      // Name the server: a remote one fails for network/auth reasons that the
      // bare transport error doesn't attribute to anything.
      const message = err instanceof Error ? err.message : String(err);
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      throw new Error(`MCP server "${cfg.name}" failed to connect: ${message}`);
    }
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
