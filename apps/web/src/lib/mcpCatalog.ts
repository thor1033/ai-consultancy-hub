import {
  connectMcpServers,
  sampleMcpConfig,
  builtinServerConfig,
  type McpStdioConfig,
} from "@ai-hub/mcp";
import { listSkillsAdmin } from "@ai-hub/db";

// Read-only introspection of the MCP servers for the explorer UI. The runnable
// stdio config lives in code; here we connect to a server, list its tools, and
// tear it down — so the UI shows real tool metadata, not a hand-maintained copy.

export function resolveServerConfig(name: string): McpStdioConfig | null {
  if (name === "sample") return sampleMcpConfig();
  return builtinServerConfig(name);
}

export interface McpToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  params: McpToolParam[];
}

interface JsonSchema {
  properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
  required?: string[];
}

function schemaParams(schema: unknown): McpToolParam[] {
  const s = (schema ?? {}) as JsonSchema;
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: def?.type ?? (def?.enum ? "enum" : "any"),
    required: required.has(name),
    description: def?.description,
  }));
}

// Connects to a single server, returns its tools, and always closes the child.
export async function describeMcpServer(name: string): Promise<McpToolInfo[]> {
  const cfg = resolveServerConfig(name);
  if (!cfg) throw new Error(`Unknown MCP server: ${name}`);
  const mcp = await connectMcpServers([cfg]);
  try {
    return mcp.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      params: schemaParams(t.input_schema),
    }));
  } finally {
    await mcp.close();
  }
}

// Lean tool count for the overview cards — connect, count, close. Returns null
// if the server can't be reached (so the card can show "—" instead of failing).
export async function countMcpTools(name: string): Promise<number | null> {
  const cfg = resolveServerConfig(name);
  if (!cfg) return null;
  try {
    const mcp = await connectMcpServers([cfg]);
    try {
      return mcp.tools.length;
    } finally {
      await mcp.close();
    }
  } catch {
    return null;
  }
}

// Which skills reference a given server in their latest version (for "used by").
export async function skillsUsingServer(name: string): Promise<string[]> {
  const skills = await listSkillsAdmin();
  return skills
    .filter((s) => s.mcpServers.some((e) => e.name === name))
    .map((s) => s.name);
}
