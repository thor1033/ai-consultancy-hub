import { runAgent, type ModelId, type RunAgentResult } from "@ai-hub/agent";
import type { McpEntry } from "@ai-hub/db";
import {
  connectMcpServers,
  builtinServerConfig,
  builtinOptionsFrom,
  memoryServerConfig,
  remoteServerConfig,
  remoteServerNames,
  remoteConfigError,
  BUILTIN_SERVER_NAMES,
  type ConnectedMcp,
  type McpServerConfig,
} from "@ai-hub/mcp";
import { recordSession, finishRun, disabledMcpServerNames } from "@ai-hub/db";
import { syncSource, TEAMS_NOTES_COLLECTION } from "@ai-hub/rag";
import { gate } from "@/lib/approvals";

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

export interface UnavailableServer {
  name: string;
  reason: string;
}

/**
 * The servers an agent is configured with that this deployment will not
 * connect, and why. Two causes, both deliberate on their own terms: a name
 * nobody declared (or a HUB_REMOTE_MCP_SERVERS that failed to parse, which
 * undeclares every remote server at once), and the /mcp kill switch.
 *
 * Deliberate is not the same as silent. Dropping a server without a word
 * left agents answering "I have no such tool" while a person read the hub's
 * log to learn why; the model is told, and the output says so (see below).
 */
export function unavailableServers(names: readonly string[], disabled: Set<string>): UnavailableServer[] {
  const malformed = remoteConfigError();
  const out: UnavailableServer[] = [];
  for (const name of names) {
    if (!name || name === "memory") continue;
    if (!isKnownServer(name)) {
      out.push({
        name,
        reason: malformed
          ? `${malformed}, so this deployment has no remote servers at all`
          : "not declared on this deployment (not a bundled server, and not in HUB_REMOTE_MCP_SERVERS)",
      });
    } else if (disabled.has(name)) {
      out.push({ name, reason: "switched off on /mcp" });
    }
  }
  return out;
}

/** What the model is told about them, in its system prompt. Null when all is well. */
export function unavailabilityNote(missing: UnavailableServer[]): string | null {
  if (missing.length === 0) return null;
  return [
    "Tool servers in your configuration that are NOT available on this deployment, so their tools are absent from your tool list:",
    ...missing.map((m) => `- ${m.name}: ${m.reason}`),
    "When a task needs one of them, say so plainly and name the server. Do not work around it with other tools, and do not present an answer built without it as complete.",
  ].join("\n");
}

/** The line a person reads at the end of such a run's output. */
export function unavailabilityFootnote(missing: UnavailableServer[]): string {
  return `\n\n_Not available on this deployment, so absent from this run: ${missing.map((m) => `${m.name} (${m.reason})`).join("; ")}._`;
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
  // Known and not globally disabled by the control plane. What that drops is
  // told to the model and written into the output, never swallowed.
  const disabled = await disabledMcpServerNames();
  const servers = (input.servers ?? [])
    .filter(isKnownServer)
    .filter((name) => !disabled.has(name));
  const missing = unavailableServers(input.servers ?? [], disabled);
  const note = unavailabilityNote(missing);
  if (note) console.warn(`[run] ${input.agentId ?? "workbench"}: unavailable servers — ${missing.map((m) => m.name).join(", ")}`);
  const system = note ? [input.system, note].filter(Boolean).join("\n\n") : input.system;

  // An agent always gets its own memory, without having to select it: an agent
  // that could be configured to forget everything is just a chat window.
  if (input.agentId && !servers.includes("memory")) servers.push("memory");

  let mcp: ConnectedMcp | undefined;
  const held = new Set<string>();
  try {
    const entryFor = (name: string) => input.serverEntries?.find((e) => entryName(e) === name);
    const configs = servers
      .map((name) => resolveServer(name, input.agentId, input.remoteBearer, entryFor(name)))
      .filter((c): c is McpServerConfig => c !== null);
    if (configs.length > 0) mcp = await connectMcpServers(configs);
    const gated = mcp
      ? gate(mcp, {
          agentId: input.agentId,
          runId: input.runId,
          principalId: input.principalId,
          entries: input.serverEntries,
          held,
        })
      : undefined;

    const result = await runAgent({
      prompt: input.prompt,
      history: input.history,
      context: input.context,
      system,
      model: input.model,
      effort: input.effort,
      maxIterations: input.maxIterations,
      // Writes are held for a person (lib/approvals.ts); reads pass through.
      // The tool list and the executor come from the same gate, so a tool
      // that will be held is the one that asks the model for its reason.
      tools: gated?.tools,
      toolExecutor: gated?.execute,
      metadata: input.agentId
        ? { source: "agent", agentId: input.agentId, servers }
        : { source: "workbench", servers },
    });

    // A note saved to Teams is filed in the knowledge base in the same run, so
    // "write up the meeting" leaves it searchable with no second step. The
    // outcome goes into the answer itself: a filing that failed quietly would
    // leave a person believing agents can find a meeting they cannot. Not when
    // the save was held for approval: nothing was written, so there is nothing
    // to file; the next sync of the notes source picks it up once approved.
    if (result.toolsUsed.includes("teams_notes_save") && !held.has("teams_notes_save")) {
      result.text += await fileMeetingNotes();
    }
    if (missing.length) result.text += unavailabilityFootnote(missing);

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
