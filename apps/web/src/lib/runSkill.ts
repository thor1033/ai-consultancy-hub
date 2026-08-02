import {
  getRunnableSkill,
  recordRun,
  disabledMcpServerNames,
  type McpEntry,
} from "@ai-hub/db";
import { runAgent, type ModelId } from "@ai-hub/agent";
import {
  connectMcpServers,
  sampleMcpConfig,
  builtinServerConfig,
  type ConnectedMcp,
  type McpStdioConfig,
} from "@ai-hub/mcp";
import { retrieveChunks, chunksToContext } from "@ai-hub/rag";

// Turn stored MCP entries into runnable stdio configs. A bare {name:"..."} marker
// resolves to a built-in server (sample, or the investment-firm demo servers);
// a full {name, command, args} entry is passed through unchanged.
function resolveMcp(entries: McpEntry[]): McpStdioConfig[] {
  return entries.map((e) => {
    if (!e.command && typeof e.name === "string") {
      if (e.name === "sample") return sampleMcpConfig();
      const builtin = builtinServerConfig(e.name);
      if (builtin) return builtin;
    }
    return e as unknown as McpStdioConfig;
  });
}

export interface RunSkillOptions {
  /** Retrieve RAG context for the input before running. */
  retrieve?: boolean;
  retrieveK?: number;
}

/**
 * Loads a skill's latest version, optionally retrieves RAG context, connects its
 * MCP servers, runs it through the agent, and records the run (with its ROI
 * substrate: cost, latency, tokens).
 */
export async function runSkill(
  slug: string,
  input: string,
  opts: RunSkillOptions = {},
) {
  const skill = await getRunnableSkill(slug);
  if (!skill) return { notFound: true as const };

  let context: string | undefined;
  let retrievedCount = 0;
  if (opts.retrieve) {
    const chunks = await retrieveChunks(input, opts.retrieveK ?? 5);
    retrievedCount = chunks.length;
    if (chunks.length > 0) context = chunksToContext(chunks);
  }

  // Control plane: a globally-disabled MCP server is dropped from the run, so the
  // skill runs with whatever tools remain rather than failing.
  const disabled = await disabledMcpServerNames();
  const activeServers = (skill.mcpServers ?? []).filter(
    (e) => typeof e.name !== "string" || !disabled.has(e.name),
  );

  let mcp: ConnectedMcp | undefined;
  try {
    const configs = resolveMcp(activeServers);
    if (configs.length > 0) mcp = await connectMcpServers(configs);

    const result = await runAgent({
      prompt: input,
      system: skill.instructions,
      context,
      model: (skill.model as ModelId | null) ?? undefined,
      effort: (skill.effort as "low" | "medium" | "high" | "max" | null) ?? undefined,
      tools: mcp?.tools,
      toolExecutor: mcp?.execute,
      metadata: { skillSlug: slug, skillVersion: skill.version, retrievedCount },
    });

    const runId = await recordRun({
      skillId: skill.skillId,
      version: skill.version,
      input,
      output: result.text,
      status: "succeeded",
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      tokens: result.usage,
      traceId: result.traceId,
    });

    return {
      runId,
      skill: { slug, version: skill.version },
      result,
      retrievedCount,
      roi: {
        baselineMinutes: skill.baselineMinutes,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      },
    };
  } finally {
    await mcp?.close();
  }
}
