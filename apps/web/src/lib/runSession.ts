import { runAgent, type ModelId, type RunAgentResult } from "@ai-hub/agent";
import {
  connectMcpServers,
  sampleMcpConfig,
  builtinServerConfig,
  BUILTIN_SERVER_NAMES,
  type ConnectedMcp,
  type McpStdioConfig,
} from "@ai-hub/mcp";
import { recordSession, disabledMcpServerNames } from "@ai-hub/db";

// The selectable MCP servers for a workbench session: the sample server plus the
// investment-firm demo servers. A real deployment resolves these from a
// per-client server registry (Phase 2).
export const KNOWN_SERVERS = ["sample", ...BUILTIN_SERVER_NAMES] as const;
export type KnownServer = (typeof KNOWN_SERVERS)[number];

const KNOWN = new Set<string>(KNOWN_SERVERS);

export function isKnownServer(name: string): boolean {
  return KNOWN.has(name);
}

function resolveServer(name: string): McpStdioConfig | null {
  if (name === "sample") return sampleMcpConfig();
  return builtinServerConfig(name);
}

export interface RunSessionInput {
  prompt: string;
  system?: string;
  model?: ModelId;
  effort?: "low" | "medium" | "high" | "max";
  servers?: string[];
}

export interface RunSessionOutput {
  sessionId: string;
  servers: string[];
  result: RunAgentResult;
}

// Runs one ad-hoc agent session (the practitioner's workflow) with the chosen MCP
// servers connected, then persists it so it can be distilled into a Skill.
export async function runSession(input: RunSessionInput): Promise<RunSessionOutput> {
  // Known and not globally disabled by the control plane.
  const disabled = await disabledMcpServerNames();
  const servers = (input.servers ?? [])
    .filter(isKnownServer)
    .filter((name) => !disabled.has(name));

  let mcp: ConnectedMcp | undefined;
  try {
    const configs = servers
      .map(resolveServer)
      .filter((c): c is McpStdioConfig => c !== null);
    if (configs.length > 0) mcp = await connectMcpServers(configs);

    const result = await runAgent({
      prompt: input.prompt,
      system: input.system,
      model: input.model,
      effort: input.effort,
      tools: mcp?.tools,
      toolExecutor: mcp?.execute,
      metadata: { source: "workbench", servers },
    });

    const sessionId = await recordSession({
      prompt: input.prompt,
      system: input.system,
      model: result.model,
      effort: input.effort,
      mcpServers: servers,
      transcript: result.transcript,
      toolsUsed: result.toolsUsed,
      output: result.text,
      status: "succeeded",
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      tokens: result.usage,
      traceId: result.traceId,
    });

    return { sessionId, servers, result };
  } finally {
    await mcp?.close();
  }
}
