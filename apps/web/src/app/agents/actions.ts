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
  setMemoryActive,
  isPlacement,
  runsOnHub,
  type AgentInput,
  type McpEntry,
  knowledgeScope,
  retrievalScope,
  createSchedule,
  listSchedules,
  getSchedule,
  setScheduleEnabled,
  deleteSchedule,
  getSkill,
  type Schedule,
  type ScheduleKind,
} from "@ai-hub/db";
import { retrieveChunks, chunksToContext } from "@ai-hub/rag";
import { runSession, isKnownServer } from "@/lib/runSession";
import { MAX_ITERATIONS_CEILING, type ModelId } from "@ai-hub/agent";
import { sessionKnowledgeAccess, sessionCan } from "@/lib/sessionPrincipal";
import { listSkills, createSkill, updateSkill, deleteSkill, type SkillParameter } from "@ai-hub/db";
import { fillTemplate, undeclaredPlaceholders } from "@/lib/skillPrompt";
import { runAgentForPrincipal, runSkillForPrincipal } from "@/lib/agentRuns";
import { MAILBOX_SERVERS } from "./models";
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
  // /agents/new is the builder, so an agent with that slug could never be opened.
  if (slug === "new") return { error: `"new" is reserved — give the agent a more specific name.` };

  // A server this agent already has is kept even if this deployment does not
  // declare it right now — otherwise saving any other field would silently cut
  // the agent off from it. New ones must be known; runSession skips undeclared
  // names at run time either way.
  const existing = id ? await getAgent(id) : null;
  const already = new Set(
    (existing?.mcpServers ?? []).map((e) => String((e as { name?: unknown }).name ?? "")),
  );
  // Rebuilt field by field rather than stored as sent. An entry is read back
  // at run time and a setting in it lands in a server's environment, so only
  // the settings a server is known to take get through, each checked.
  const servers: McpEntry[] = [];
  for (const e of input.mcpServers ?? []) {
    const name = (e as { name?: unknown }).name;
    if (typeof name !== "string" || !(isKnownServer(name) || already.has(name))) continue;
    const entry: McpEntry = { name };
    const mailbox = (e as { mailbox?: unknown }).mailbox;
    if (typeof mailbox === "string" && mailbox.trim()) {
      if (!MAILBOX_SERVERS.has(name)) return { error: `"${name}" does not take a mailbox.` };
      const clean = mailbox.trim().toLowerCase();
      if (clean.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        return { error: `"${mailbox.trim()}" is not a mailbox address.` };
      }
      entry.mailbox = clean;
    }
    servers.push(entry);
  }

  // A server action is a public endpoint, so the number is validated here and
  // not only by the <input type="number"> that usually produces it. Anything
  // unusable becomes null — the runtime default — rather than an error the
  // person cannot act on or a NaN that reaches Postgres.
  const raw = input.maxIterations;
  const maxIterations =
    raw === null || raw === undefined || !Number.isFinite(Number(raw))
      ? null
      : Math.min(Math.max(Math.trunc(Number(raw)), 1), MAX_ITERATIONS_CEILING);

  // Where an agent runs decides where its instructions are copied to and who
  // reaches its tools from outside the hub, so changing it is admin-only even
  // if agent:manage is one day granted more widely. `existing` is the lookup
  // the server list above already paid for.
  // Collection names are matched exactly against documents, so they are
  // checked for shape here; whether one exists is not an error (a drawer can
  // be named before anything is filed in it), and whether the asker may read
  // it is decided at retrieval time, never here.
  const knowledgeCollections: string[] = [];
  for (const raw of input.knowledgeCollections ?? []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name) continue;
    if (name.length > 120) return { error: `"${name.slice(0, 40)}…" is too long for a collection name.` };
    if (!knowledgeCollections.includes(name)) knowledgeCollections.push(name);
  }
  if (knowledgeCollections.length > 50) return { error: "An agent can work from at most 50 collections." };
  const knowledgeAll = input.knowledgeAll === true;

  const placement = input.placement ?? existing?.placement ?? "hub";
  if (!isPlacement(placement)) return { error: "Unknown placement." };
  if (placement !== (existing?.placement ?? "hub") && !(await sessionCan("admin:manage"))) {
    return { error: "Only an admin can change where an agent runs." };
  }

  try {
    if (id) {
      const updated = await updateAgent(id, {
        ...input,
        name,
        mcpServers: servers,
        knowledgeCollections,
        knowledgeAll,
        maxIterations,
        placement,
      });
      if (!updated) return { error: "That agent no longer exists." };
      revalidatePath("/agents");
      revalidatePath(`/agents/${updated.slug}`);
      return { ok: true, slug: updated.slug };
    }
    const created = await createAgent({
      ...input,
      name,
      slug,
      mcpServers: servers,
      knowledgeCollections,
      knowledgeAll,
      maxIterations,
      placement,
    });
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

export async function setMemoryActiveAction(
  agentId: string,
  key: string,
  active: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await sessionCan("agent:manage"))) return { ok: false, error: NOT_ALLOWED };
  const ok = await setMemoryActive(agentId, key, active);
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
  if (!runsOnHub(agent.placement)) {
    return { error: `${agent.name} runs locally, in Claude Code. Switch it to "Hub" or "Both" to talk to it here.` };
  }

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
  // Retrieved as the PERSON ASKING, not as the agent. An agent's knowledge
  // scope is curation — which drawers it works out of — and never a
  // permission of its own. If it were, asking an agent scoped to a restricted
  // collection would be the way for anyone to read that collection, with the
  // agent as the deputy. The two are ANDed in retrieveChunks: a collection the
  // asker may not read yields nothing, rather than an agent that quietly
  // answers from material its operator cannot open.
  let context: string | undefined;
  let sources = 0;
  const scope = retrievalScope(knowledgeScope(agent));
  if (scope) {
    try {
      const chunks = await retrieveChunks(last.content, await sessionKnowledgeAccess(), 5, scope);
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
      serverEntries: agent.mcpServers,
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

// --- Schedules: the agent's clock ------------------------------------------
//
// Any agent, any skill or prompt, any person with agent:run. A schedule is
// OWNED by whoever creates it and runs with their reach (docs/schedules.md), so
// creating one is not an admin act; taking someone else's away is, unless it is
// your own.

export interface ScheduleDraft {
  agentId: string;
  name: string;
  /** Exactly one of these: a skill (with its arguments) or a prompt. */
  skillId?: string | null;
  skillArgs?: Record<string, unknown>;
  prompt?: string;
  kind: ScheduleKind;
  intervalMinutes?: number | null;
  atMinute?: number | null;
  weekdays?: number[];
  timezone?: string;
}

async function scheduleList(agentId: string): Promise<{ schedules: Schedule[] }> {
  return { schedules: await listSchedules(agentId) };
}

export async function createScheduleAction(input: ScheduleDraft): Promise<{ schedules: Schedule[] } | { error: string }> {
  const principal = await sessionCan("agent:run");
  if (!principal) return { error: "You are not permitted to run agents." };
  const agent = await getAgent(input.agentId);
  if (!agent) return { error: "That agent no longer exists." };
  if (!runsOnHub(agent.placement)) {
    return { error: `"${agent.name}" runs in Claude Code only, so the hub has no clock for it. Set it to "Hub" or "Both" first.` };
  }

  let prompt = (input.prompt ?? "").trim();
  let agentSkillId: string | null = null;
  let skillArgs: Record<string, unknown> = {};
  if (input.skillId) {
    const skill = await getSkill(input.skillId);
    if (!skill || skill.agentId !== agent.id) return { error: "That skill does not belong to this agent." };
    if (!skill.enabled) return { error: `"${skill.name}" is switched off.` };
    // Filled once here so a schedule that could never run is refused at the
    // door, not discovered at 07:00 as a failed run nobody was watching.
    const args = input.skillArgs && typeof input.skillArgs === "object" ? input.skillArgs : {};
    const filled = fillTemplate(skill.promptTemplate, skill.parameters ?? [], args);
    if ("error" in filled) return { error: `${skill.name}: ${filled.error}` };
    agentSkillId = skill.id;
    skillArgs = Object.fromEntries(
      (skill.parameters ?? [])
        .map((p) => [p.name, args[p.name]] as const)
        .filter(([, v]) => v !== undefined && v !== null && v !== ""),
    );
    const shown = Object.entries(skillArgs).map(([k, v]) => `${k} = ${String(v)}`).join(", ");
    prompt = `Run the skill "${skill.name}"${shown ? ` with ${shown}` : ""}.`;
  }

  const created = await createSchedule({
    agentId: agent.id,
    name: input.name,
    prompt,
    agentSkillId,
    skillArgs,
    kind: input.kind,
    intervalMinutes: input.intervalMinutes ?? null,
    atMinute: input.atMinute ?? null,
    weekdays: input.weekdays ?? [],
    timezone: input.timezone?.trim() || process.env.HUB_TIMEZONE?.trim() || "UTC",
    ownerPrincipalId: principal.id,
  });
  if ("error" in created) return { error: created.error };
  revalidatePath(`/agents/${agent.slug}`);
  return scheduleList(agent.id);
}

/** The owner, or an admin. Anyone else may look. */
async function ownedSchedule(id: string): Promise<Schedule | { error: string }> {
  const principal = await sessionCan("agent:run");
  if (!principal) return { error: "You are not permitted to run agents." };
  const schedule = await getSchedule(id);
  if (!schedule) return { error: "That schedule no longer exists." };
  if (schedule.ownerPrincipalId !== principal.id && !(await sessionCan("admin:manage"))) {
    return { error: "Only the person who set this schedule up, or an admin, can change it." };
  }
  return schedule;
}

export async function setScheduleEnabledAction(id: string, enabled: boolean): Promise<{ schedules: Schedule[] } | { error: string }> {
  const schedule = await ownedSchedule(id);
  if ("error" in schedule) return schedule;
  await setScheduleEnabled(id, enabled);
  return scheduleList(schedule.agentId);
}

export async function deleteScheduleAction(id: string): Promise<{ schedules: Schedule[] } | { error: string }> {
  const schedule = await ownedSchedule(id);
  if ("error" in schedule) return schedule;
  await deleteSchedule(id);
  return scheduleList(schedule.agentId);
}

/**
 * Run a schedule's work now, as the viewer rather than the owner: a person
 * pressing a button is a person asking, so the run has their reach and lands
 * in Recent runs like any other. Returns once the run has an id.
 */
export async function runScheduleNowAction(id: string): Promise<{ ok: true; runId: string; running: boolean } | { error: string }> {
  const principal = await sessionCan("agent:run");
  if (!principal) return { error: "You are not permitted to run agents." };
  const schedule = await getSchedule(id);
  if (!schedule) return { error: "That schedule no longer exists." };
  const outcome = schedule.agentSkillId
    ? await runSkillForPrincipal({ skillRef: schedule.agentSkillId, args: schedule.skillArgs ?? {}, principal, deadlineMs: 3000 })
    : await runAgentForPrincipal({ agentRef: schedule.agentId, prompt: schedule.prompt, principal, deadlineMs: 3000 });
  if (outcome.kind === "error") return { error: outcome.message };
  return { ok: true, runId: outcome.runId, running: outcome.kind === "running" };
}
