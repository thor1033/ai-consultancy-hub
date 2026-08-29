import { runAgent, type ModelId, type RunAgentResult } from "@ai-hub/agent";
import {
  connectMcpServers,
  sampleMcpConfig,
  builtinServerConfig,
  memoryServerConfig,
  remoteServerConfig,
  remoteServerNames,
  BUILTIN_SERVER_NAMES,
  type ConnectedMcp,
  type McpServerConfig,
} from "@ai-hub/mcp";
import { recordSession, disabledMcpServerNames } from "@ai-hub/db";

// The code-owned servers: the sample server plus the investment-firm demo servers.
const LOCAL_SERVERS = ["sample", ...BUILTIN_SERVER_NAMES] as const;

/**
 * The selectable MCP servers for a workbench session — the code-owned ones plus
 * any remote servers this deployment declares (HUB_REMOTE_MCP_SERVERS). Remote
 * servers are env-driven, so this is a function, not a constant.
 */
export function knownServers(): string[] {
  return [...LOCAL_SERVERS, ...remoteServerNames()];
}

export function isKnownServer(name: string): boolean {
  return knownServers().includes(name);
}

/**
 * `agentId` opens the memory server for that agent. It is not resolvable by
 * name alone — memory is scoped to one agent, and that scope must come from the
 * caller, never from something the model can say.
 */
export function resolveServer(name: string, agentId?: string): McpServerConfig | null {
  if (name === "sample") return sampleMcpConfig();
  if (name === "memory") return agentId ? memoryServerConfig(agentId) : null;
  return builtinServerConfig(name) ?? remoteServerConfig(name);
}

export interface RunSessionInput {
  prompt: string;
  /** Prior chat turns preceding `prompt` (chat mode). */
  history?: { role: "user" | "assistant"; content: string }[];
  /** Retrieved context (e.g. RAG) injected as a system block. */
  context?: string;
  /**
   * Run as this standing agent. Attaches its memory server, and is recorded on
   * the session so a run can be traced back to the agent that made it.
   */
  agentId?: string;
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

  // An agent always gets its own memory, without having to select it: an agent
  // that could be configured to forget everything is just a chat window.
  if (input.agentId && !servers.includes("memory")) servers.push("memory");

  let mcp: ConnectedMcp | undefined;
  try {
    const configs = servers
      .map((name) => resolveServer(name, input.agentId))
      .filter((c): c is McpServerConfig => c !== null);
    if (configs.length > 0) mcp = await connectMcpServers(configs);

    const result = await runAgent({
      prompt: input.prompt,
      history: input.history,
      context: input.context,
      system: input.system,
      model: input.model,
      effort: input.effort,
      tools: mcp?.tools,
      toolExecutor: mcp?.execute,
      metadata: input.agentId
        ? { source: "agent", agentId: input.agentId, servers }
        : { source: "workbench", servers },
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
