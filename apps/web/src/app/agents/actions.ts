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
import { MAX_ITERATIONS_CEILING, type ModelId } from "@ai-hub/agent";
import { sessionKnowledgeAccess, sessionCan } from "@/lib/sessionPrincipal";
import { listSkills, createSkill, updateSkill, deleteSkill, type SkillParameter } from "@ai-hub/db";
import { undeclaredPlaceholders } from "@/lib/skillPrompt";
import { isUniqueViolation } from "@/lib/apiError";

// Server actions for the agents console. Each one checks the signed-in user's
// role: talking to an agent needs agent:run, changing one needs agent:manage.

const NOT_ALLOWED = "You do not have permission to do that.";

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
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  const name = input.name?.trim();
  if (!name) return { error: "An agent needs a name." };

  const slug = toSlug(input.slug?.trim() || name);
  if (!slug) return { error: "That name does not make a usable slug — use some letters." };

  const servers = (input.mcpServers ?? []).filter(
    (e) => typeof (e as { name?: unknown }).name === "string" && isKnownServer(String((e as { name: string }).name)),
  );

  // A server action is a public endpoint, so the number is validated here and
  // not only by the <input type="number"> that usually produces it. Anything
  // unusable becomes null — the runtime default — rather than an error the
  // person cannot act on or a NaN that reaches Postgres.
  const raw = input.maxIterations;
  const maxIterations =
    raw === null || raw === undefined || !Number.isFinite(Number(raw))
      ? null
      : Math.min(Math.max(Math.trunc(Number(raw)), 1), MAX_ITERATIONS_CEILING);

  try {
    if (id) {
      const updated = await updateAgent(id, { ...input, name, mcpServers: servers, maxIterations });
      if (!updated) return { error: "That agent no longer exists." };
      revalidatePath("/agents");
      revalidatePath(`/agents/${updated.slug}`);
      return { ok: true, slug: updated.slug };
    }
    const created = await createAgent({ ...input, name, slug, mcpServers: servers, maxIterations });
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

export async function deleteAgentAction(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await sessionCan("agent:manage"))) return { ok: false, error: NOT_ALLOWED };
  const ok = await deleteAgent(id);
  revalidatePath("/agents");
  return { ok };
}

export async function forgetMemoryAction(
  agentId: string,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await sessionCan("agent:manage"))) return { ok: false, error: NOT_ALLOWED };
  const ok = await forgetMemory(agentId, key);
  revalidatePath("/agents");
  return { ok };
}

export async function listAgentsAction() {
  if (!(await sessionCan("agent:run"))) return [];
  return listAgents();
}

export async function loadMemoriesAction(agentId: string) {
  if (!(await sessionCan("agent:run"))) return [];
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
  const principal = await sessionCan("agent:run");
  if (!principal) return { error: NOT_ALLOWED };
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
  //
  // Retrieved as the PERSON ASKING, not as the agent. An agent's
  // knowledgeCollection is curation — which drawer it works out of — and never a
  // permission of its own. If it were, asking an agent scoped to a restricted
  // collection would be the way for anyone to read that collection, with the
  // agent as the deputy. The two are ANDed in retrieveChunks: a collection the
  // asker may not read yields nothing, rather than an agent that quietly
  // answers from material its operator cannot open.
  let context: string | undefined;
  let sources = 0;
  if (agent.knowledgeCollection) {
    try {
      const chunks = await retrieveChunks(last.content, await sessionKnowledgeAccess(), 5, {
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
      principalId: principal.id,
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

// --- Skills: an agent's expertise -------------------------------------------
//
// A skill is a named, parameterised task this agent can carry out, and it
// becomes a tool in every connected client's list. Guarded on the signed-in
// user, because defining one changes what everybody's editor can invoke.

export async function listSkillsAction(agentId: string) {
  if (!(await sessionCan("agent:run"))) return { error: NOT_ALLOWED };
  try {
    return { skills: await listSkills(agentId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not load skills." };
  }
}

export async function saveSkillAction(input: {
  id?: string;
  agentId: string;
  slug: string;
  name: string;
  description: string;
  promptTemplate: string;
  parameters: SkillParameter[];
}) {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };

  const slug = input.slug.trim().toLowerCase();
  // The slug becomes an MCP tool name, so it has to survive that translation
  // legibly rather than being mangled into something nobody recognises.
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return { error: "Slug must be 2–63 characters: lowercase letters, digits and hyphens." };
  }
  if (!input.name.trim()) return { error: "Give the skill a name." };
  if (!input.promptTemplate.trim()) {
    return { error: "Write the prompt this skill runs." };
  }

  const parameters = input.parameters
    .map((p) => ({ ...p, name: p.name.trim() }))
    .filter((p) => p.name);
  const bad = parameters.find((p) => !/^[a-zA-Z0-9_]+$/.test(p.name));
  if (bad) {
    return { error: `Parameter "${bad.name}" must use letters, digits and underscores only.` };
  }

  // Caught here rather than at call time: a placeholder with no parameter can
  // never be filled, so the skill would ship a prompt with a literal
  // "{{client}}" in it and nobody would find out until a client read the output.
  const undeclared = undeclaredPlaceholders(input.promptTemplate, parameters);
  if (undeclared.length) {
    return {
      error: `The prompt uses {{${undeclared[0]}}}, but no parameter is called "${undeclared[0]}".`,
    };
  }

  try {
    const saved = input.id
      ? await updateSkill(input.id, {
          slug,
          name: input.name.trim(),
          description: input.description.trim(),
          promptTemplate: input.promptTemplate,
          parameters,
        })
      : await createSkill({
          agentId: input.agentId,
          slug,
          name: input.name.trim(),
          description: input.description.trim(),
          promptTemplate: input.promptTemplate,
          parameters,
        });
    if (!saved) return { error: "That skill no longer exists." };
    return { skills: await listSkills(input.agentId) };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { error: `Another skill already uses the slug "${slug}".` };
    }
    return { error: e instanceof Error ? e.message : "Could not save that skill." };
  }
}

export async function setSkillEnabledAction(id: string, agentId: string, enabled: boolean) {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  try {
    await updateSkill(id, { enabled });
    return { skills: await listSkills(agentId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function deleteSkillAction(id: string, agentId: string) {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  try {
    await deleteSkill(id);
    return { skills: await listSkills(agentId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Delete failed." };
  }
}
