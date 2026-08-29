"use server";

import { revalidatePath } from "next/cache";
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  listMemories,
  forgetMemory,
  type AgentInput,
} from "@ai-hub/db";
import { retrieveChunks, chunksToContext } from "@ai-hub/rag";
import { runSession, isKnownServer } from "@/lib/runSession";
import type { ModelId } from "@ai-hub/agent";

// Server actions for the agents console. Like the rest of the dashboard these
// run server-trusted; binding them to a logged-in principal (so the PolicyEngine
// gates UI writes too) lands with WorkOS SSO in Phase 2.

const MAX_MESSAGE = 8_000;
const MAX_TURNS = 40;

const effortOf = (v: string | null | undefined) =>
  v === "low" || v === "medium" || v === "high" || v === "max" ? v : undefined;

/** Slugs are the agent's URL and its stable handle, so normalize rather than reject. */
function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function saveAgentAction(
  id: string | null,
  input: AgentInput,
): Promise<{ ok: true; slug: string } | { error: string }> {
  const name = input.name?.trim();
  if (!name) return { error: "An agent needs a name." };

  const slug = toSlug(input.slug?.trim() || name);
  if (!slug) return { error: "That name does not make a usable slug — use some letters." };

  const servers = (input.mcpServers ?? []).filter(
    (e) => typeof (e as { name?: unknown }).name === "string" && isKnownServer(String((e as { name: string }).name)),
  );

  try {
    if (id) {
      const updated = await updateAgent(id, { ...input, name, mcpServers: servers });
      if (!updated) return { error: "That agent no longer exists." };
      revalidatePath("/agents");
      revalidatePath(`/agents/${updated.slug}`);
      return { ok: true, slug: updated.slug };
    }
    const created = await createAgent({ ...input, name, slug, mcpServers: servers });
    revalidatePath("/agents");
    return { ok: true, slug: created.slug };
  } catch (e) {
    // A duplicate slug is the one failure a user can actually fix, so name it.
    const message = e instanceof Error ? e.message : "Could not save the agent.";
    if (/duplicate key|unique/i.test(message)) {
      return { error: `An agent with the slug "${slug}" already exists.` };
    }
    return { error: message };
  }
}

export async function deleteAgentAction(id: string): Promise<{ ok: boolean }> {
  const ok = await deleteAgent(id);
  revalidatePath("/agents");
  return { ok };
}

export async function forgetMemoryAction(
  agentId: string,
  key: string,
): Promise<{ ok: boolean }> {
  const ok = await forgetMemory(agentId, key);
  revalidatePath("/agents");
  return { ok };
}

export async function listAgentsAction() {
  return listAgents();
}

export async function loadMemoriesAction(agentId: string) {
  return listMemories(agentId);
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentTurnMeta {
  model: string;
  costUsd: number;
  latencyMs: number;
  toolsUsed: string[];
  servers: string[];
  sources: number;
}

// Spelled out rather than inferred: this crosses the server-action boundary,
// and an inferred union of object literals narrows badly on the client.
export type AgentTurnResult =
  | { error: string }
  | { role: "assistant"; content: string; meta: AgentTurnMeta };

/**
 * One turn of a conversation with a standing agent.
 *
 * The difference from the workbench chat is the agent itself: its instructions,
 * its tool selection, its knowledge scope, and its memory — which runSession
 * attaches automatically from the agent id, so the model can recall and record
 * across conversations rather than starting cold each time.
 */
export async function sendAgentMessageAction(
  slug: string,
  messages: AgentChatMessage[],
): Promise<AgentTurnResult> {
  const agent = await getAgent(slug);
  if (!agent) return { error: "That agent no longer exists." };
  if (!agent.enabled) return { error: `${agent.name} is disabled.` };

  const clean = (messages ?? []).filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim(),
  );
  const last = clean[clean.length - 1];
  if (!last || last.role !== "user") return { error: "Say something first." };
  if (last.content.length > MAX_MESSAGE) return { error: "That message is too long." };

  const history = clean.slice(0, -1).slice(-MAX_TURNS);
  const servers = (agent.mcpServers ?? [])
    .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown }).name ?? "")))
    .filter((n) => n && isKnownServer(n));

  // Best-effort retrieval: an agent scoped to a collection answers from it, but
  // a missing embedder or empty index must not take the conversation down.
  let context: string | undefined;
  let sources = 0;
  if (agent.knowledgeCollection) {
    try {
      const chunks = await retrieveChunks(last.content, 5, {
        collection: agent.knowledgeCollection,
      });
      if (chunks.length) {
        context = chunksToContext(chunks);
        sources = chunks.length;
      }
    } catch {
      /* retrieval unavailable — answer without it */
    }
  }

  try {
    const { result, servers: used } = await runSession({
      prompt: last.content,
      history,
      system: agent.instructions || undefined,
      context,
      model: (agent.model as ModelId) ?? undefined,
      effort: effortOf(agent.effort),
      servers,
      agentId: agent.id,
    });
    revalidatePath(`/agents/${agent.slug}`); // memory may have changed
    return {
      role: "assistant" as const,
      content: result.text,
      meta: {
        model: result.model,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        toolsUsed: result.toolsUsed,
        servers: used,
        sources,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "The agent turn failed." };
  }
}
