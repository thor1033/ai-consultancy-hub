import {
  getRunnableSkill,
  recordRun,
  disabledMcpServerNames,
  type McpEntry,
} from "@ai-hub/db";
import { runAgent, type ModelId } from "@ai-hub/agent";
import { connectMcpServers, type ConnectedMcp, type McpServerConfig } from "@ai-hub/mcp";
import { retrieveChunks, chunksToContext } from "@ai-hub/rag";
import { resolveServer } from "@/lib/runSession";

// Turn stored MCP entries into runnable configs. A bare {name:"..."} marker
// resolves to a built-in (stdio) server or a declared remote (HTTP) one; a full
// {name, command, args} or {name, url} entry is passed through unchanged.
function resolveMcp(entries: McpEntry[]): McpServerConfig[] {
  return entries.map((e) => {
    if (!e.command && !e.url && typeof e.name === "string") {
      const resolved = resolveServer(e.name);
      if (resolved) return resolved;
    }
    return e as unknown as McpServerConfig;
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

  // RAG provenance: keep the retrieved chunks (title + score, no full text) so the
  // run records and shows exactly what context the agent was given.
  let context: string | undefined;
  let retrieved: { title: string | null; documentId: string; chunkIndex: number; score: number }[] = [];
  if (opts.retrieve) {
    const chunks = await retrieveChunks(input, opts.retrieveK ?? 5, {
      collection: skill.knowledgeCollection ?? undefined,
    });
    retrieved = chunks.map((c) => ({
      title: c.title,
      documentId: c.documentId,
      chunkIndex: c.chunkIndex,
      score: c.score,
    }));
    if (chunks.length > 0) context = chunksToContext(chunks);
  }
  const retrievedCount = retrieved.length;

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
      retrieved,
    });

    return {
      runId,
      skill: { slug, version: skill.version },
      result,
      retrievedCount,
      retrieved,
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
