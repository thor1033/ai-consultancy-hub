import { runAgent, type ModelId, type RunAgentResult } from "@ai-hub/agent";
import type { McpEntry } from "@ai-hub/db";
import {
  connectMcpServers,
  builtinServerConfig,
  builtinOptionsFrom,
  memoryServerConfig,
  remoteServerConfig,
  remoteServerNames,
  BUILTIN_SERVER_NAMES,
  type ConnectedMcp,
  type McpServerConfig,
} from "@ai-hub/mcp";
import { recordSession, finishRun, disabledMcpServerNames } from "@ai-hub/db";
import { syncSource, TEAMS_NOTES_COLLECTION } from "@ai-hub/rag";

// The code-owned servers the hub starts itself.
const LOCAL_SERVERS = BUILTIN_SERVER_NAMES;

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

/** The server an agent's stored entry names — a bare string, or `{ name, … }`. */
export const entryName = (entry: McpEntry | string): string =>
  typeof entry === "string" ? entry : String((entry as { name?: unknown }).name ?? "");

/**
 * `agentId` opens the memory server for that agent. It is not resolvable by
 * name alone — memory is scoped to one agent, and that scope must come from the
 * caller, never from something the model can say.
 */
export function resolveServer(
  name: string,
  agentId?: string,
  remoteBearer?: string,
  /** The agent's own entry for this server, for per-agent settings such as a mailbox. */
  entry?: McpEntry,
): McpServerConfig | null {
  if (name === "memory") return agentId ? memoryServerConfig(agentId) : null;
  return builtinServerConfig(name, builtinOptionsFrom(entry)) ?? remoteServerConfig(name, { bearer: remoteBearer });
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
  /** Rounds of tool use this run may take. Undefined ⇒ the runtime default. */
  maxIterations?: number;
  servers?: string[];
  /** Who asked, recorded on the session so a run has an owner. */
  principalId?: string;
  /**
   * The asker's own access token, when they arrived by OAuth. Remote servers
   * are dialled with it instead of the hub's token, so what the agent does in
   * the PM-tool is done as this person. Absent for schedules and credentials.
   */
  remoteBearer?: string;
  /**
   * The agent's stored server entries, as declared. `servers` says which to
   * connect; this is where a per-agent setting lives (a mailbox, today), so it
   * reaches the server's environment without becoming a tool argument.
   */
  serverEntries?: McpEntry[];
  /**
   * An already-started run row to complete, instead of inserting a finished
   * one. The asynchronous path creates the row first so the caller has an id to
   * poll while the work is still going.
   */
  runId?: string;
}

export interface RunSessionOutput {
  sessionId: string;
  servers: string[];
  result: RunAgentResult;
}

async function fileMeetingNotes(): Promise<string> {
  try {
    const r = await syncSource("teams-notes", { collection: TEAMS_NOTES_COLLECTION });
    return `\n\n_Filed in the knowledge base: ${r.documents} meeting note(s) in the "${TEAMS_NOTES_COLLECTION}" collection._`;
  } catch (err) {
    return (
      `\n\n**The notes were saved to Teams but not filed in the knowledge base:** ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
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
    const entryFor = (name: string) => input.serverEntries?.find((e) => entryName(e) === name);
    const configs = servers
      .map((name) => resolveServer(name, input.agentId, input.remoteBearer, entryFor(name)))
      .filter((c): c is McpServerConfig => c !== null);
    if (configs.length > 0) mcp = await connectMcpServers(configs);

    const result = await runAgent({
      prompt: input.prompt,
      history: input.history,
      context: input.context,
      system: input.system,
      model: input.model,
      effort: input.effort,
      maxIterations: input.maxIterations,
      tools: mcp?.tools,
      toolExecutor: mcp?.execute,
      metadata: input.agentId
        ? { source: "agent", agentId: input.agentId, servers }
        : { source: "workbench", servers },
    });

    // A note saved to Teams is filed in the knowledge base in the same run, so
    // "write up the meeting" leaves it searchable with no second step. The
    // outcome goes into the answer itself: a filing that failed quietly would
    // leave a person believing agents can find a meeting they cannot.
    if (result.toolsUsed.includes("teams_notes_save")) result.text += await fileMeetingNotes();

    let sessionId: string;
    if (input.runId) {
      await finishRun(input.runId, {
        transcript: result.transcript,
        toolsUsed: result.toolsUsed,
        output: result.text,
        model: result.model,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        tokens: result.usage,
        traceId: result.traceId,
      });
      sessionId = input.runId;
    } else {
      sessionId = await recordSession({
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
        agentId: input.agentId ?? null,
        principalId: input.principalId ?? null,
      });
    }

    return { sessionId, servers, result };
  } finally {
    await mcp?.close();
  }
}
