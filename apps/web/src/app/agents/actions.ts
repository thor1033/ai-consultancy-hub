"use server";

import { revalidatePath } from "next/cache";
import {
  listAgents,
  getAgent,
  deleteAgent,
  listMemories,
  forgetMemory,
  setMemoryActive,
  runsOnHub,
  type AgentInput,
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
  startRun,
  failRun,
  listHandoffs,
  createHandoff,
  setHandoffEnabled,
  deleteHandoff,
  getHandoff,
  type Handoff,
  getRunStatus,
} from "@ai-hub/db";
import { retrieveChunks, chunksToContext } from "@ai-hub/rag";
import { runSession, isKnownServer } from "@/lib/runSession";
import { type ModelId } from "@ai-hub/agent";
import { sessionKnowledgeAccess, sessionCan, sessionPrincipal } from "@/lib/sessionPrincipal";
import { saveAgentAs, saveSkillAs, type SkillDraft } from "@/lib/agentDesign";
import { listSkills, updateSkill, deleteSkill } from "@ai-hub/db";
import { fillTemplate } from "@/lib/skillPrompt";
import { runAgentForPrincipal, runSkillForPrincipal, cooperation, handoffsAfter } from "@/lib/agentRuns";

// Server actions for the agents console. Each one checks the signed-in user's
// role: talking to an agent needs agent:run, changing one needs agent:manage.

const NOT_ALLOWED = "You do not have permission to do that.";

const MAX_MESSAGE = 8_000;
const MAX_TURNS = 40;

const effortOf = (v: string | null | undefined) =>
  v === "low" || v === "medium" || v === "high" || v === "max" ? v : undefined;

/** Slugs are the agent's URL and its stable handle, so normalize rather than reject. */
export async function saveAgentAction(
  id: string | null,
  input: AgentInput,
): Promise<{ ok: true; slug: string } | { error: string }> {
  // The rules live in lib/agentDesign.ts, shared with the hub's MCP tools.
  const out = await saveAgentAs(await sessionPrincipal(), id, input);
  if ("error" in out) return out;
  revalidatePath("/agents");
  revalidatePath(`/agents/${out.slug}`);
  return { ok: true, slug: out.slug };
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

  // A row first, as every other run path does: the conversation's turn is a
  // run like any other, so the agents it asks hang off it and the hand-offs
  // that follow it have a session to point at.
  const runId = await startRun({
    prompt: last.content,
    agentId: agent.id,
    principalId: principal.id,
    system: agent.instructions || undefined,
    model: agent.model ?? undefined,
    effort: agent.effort ?? undefined,
    mcpServers: servers,
  });
  try {
    const together = await cooperation(agent, principal, runId, 0);
    const { result, servers: used } = await runSession({
      prompt: last.content,
      history,
      system: agent.instructions || undefined,
      context,
      model: (agent.model as ModelId) ?? undefined,
      effort: effortOf(agent.effort),
      maxIterations: agent.maxIterations ?? undefined,
      servers,
      serverEntries: agent.mcpServers,
      agentId: agent.id,
      principalId: principal.id,
      runId,
      keepsMemory: together.keepsMemory,
      asks: together.asks,
      afterRun: handoffsAfter({
        sessionId: runId,
        agentId: agent.id,
        agentName: agent.name,
        skillId: null,
        skillName: null,
        prompt: last.content,
        principal,
        depth: 0,
      }),
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
    const message = e instanceof Error ? e.message : "The agent turn failed.";
    await failRun(runId, message).catch(() => {});
    return { error: message };
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

export async function saveSkillAction(input: SkillDraft) {
  const out = await saveSkillAs(await sessionPrincipal(), input);
  if ("error" in out) return out;
  return { skills: out.skills };
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

// --- Hand-offs: what starts when this agent finishes ------------------------
//
// Rows, so a pattern can wire a pipeline and a person can switch one off.
// Guarded on agent:manage like skills: a hand-off decides which agent runs
// next, as whom (the same person), which is what the brief decides too.

export async function listHandoffsAction(agentId: string): Promise<{ handoffs: Handoff[] } | { error: string }> {
  if (!(await sessionCan("agent:run"))) return { error: NOT_ALLOWED };
  return { handoffs: await listHandoffs(agentId) };
}

export async function createHandoffAction(input: {
  fromAgentId: string;
  skillId: string | null;
  toAgentId: string;
  prompt: string;
  note: string;
}): Promise<{ handoffs: Handoff[] } | { error: string }> {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  const [from, to] = await Promise.all([getAgent(input.fromAgentId), getAgent(input.toAgentId)]);
  if (!from) return { error: "That agent no longer exists." };
  if (!to) return { error: "Pick an agent to hand to." };
  if (from.id === to.id) return { error: "An agent cannot hand off to itself." };
  if (input.skillId && !(await listSkills(from.id)).some((s) => s.id === input.skillId)) return { error: "That skill is not this agent's." };
  if (!input.prompt?.trim()) return { error: "Say what the next agent should do, with {{output}} or {{sessionId}} where its material goes." };
  if (input.prompt.length > 8000) return { error: "That prompt is too long." };
  try {
    await createHandoff({ fromAgentId: from.id, skillId: input.skillId, toAgentId: to.id, prompt: input.prompt, note: (input.note ?? "").slice(0, 300) });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not create the hand-off." };
  }
  revalidatePath(`/agents/${from.slug}`);
  revalidatePath(`/agents/${to.slug}`);
  return { handoffs: await listHandoffs(from.id) };
}

export async function setHandoffEnabledAction(id: string, agentId: string, enabled: boolean): Promise<{ handoffs: Handoff[] } | { error: string }> {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  const row = await getHandoff(id);
  if (!row) return { error: "That hand-off no longer exists." };
  await setHandoffEnabled(id, enabled);
  revalidatePath(`/agents/${row.fromAgentSlug}`);
  revalidatePath(`/agents/${row.toAgentSlug}`);
  return { handoffs: await listHandoffs(agentId) };
}

export async function deleteHandoffAction(id: string, agentId: string): Promise<{ handoffs: Handoff[] } | { error: string }> {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  const row = await getHandoff(id);
  if (row) {
    await deleteHandoff(id);
    revalidatePath(`/agents/${row.fromAgentSlug}`);
    revalidatePath(`/agents/${row.toAgentSlug}`);
  }
  return { handoffs: await listHandoffs(agentId) };
}

/** The agents another agent may be wired to, for the hand-off and ask pickers. */
export async function listOtherAgentsAction(): Promise<{ id: string; slug: string; name: string; description: string }[]> {
  if (!(await sessionCan("agent:run"))) return [];
  return (await listAgents()).map((a) => ({ id: a.id, slug: a.slug, name: a.name, description: a.description }));
}

// --- Running a skill from its page ----------------------------------------
//
// Until this, a skill could be run from Claude Code, Claude.ai or a schedule,
// and not from the hub's own page — so a person who does not use those
// clients could not use the expertise the firm packaged (docs/views.md). It
// runs as the person, through the same path a client's call takes, so every
// check holds and every write is held.

export type SkillRunResult =
  | { status: "done"; runId: string; output: string }
  | { status: "running"; runId: string }
  | { status: "failed"; runId?: string; error: string };

/** How long the page waits before it polls instead. */
const PAGE_DEADLINE_MS = 40_000;

export async function runSkillAction(skillId: string, args: Record<string, unknown>): Promise<SkillRunResult> {
  const principal = await sessionCan("agent:run");
  if (!principal) return { status: "failed", error: NOT_ALLOWED };
  if (typeof skillId !== "string" || !skillId) return { status: "failed", error: "No skill named." };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof k !== "string" || k.length > 64) continue;
    if (typeof v === "string") clean[k] = v.slice(0, 200_000);
    else if (typeof v === "number" || typeof v === "boolean") clean[k] = String(v);
  }
  const out = await runSkillForPrincipal({ skillRef: skillId, args: clean, principal, deadlineMs: PAGE_DEADLINE_MS });
  if (out.kind === "error") return { status: "failed", error: out.message };
  if (out.kind === "running") return { status: "running", runId: out.runId };
  revalidatePath("/agents");
  return { status: "done", runId: out.runId, output: out.output };
}

/** A run this person started, for the page to poll. Scoped to them: a run id is not a bearer token. */
export async function runStatusAction(runId: string): Promise<SkillRunResult> {
  const principal = await sessionCan("agent:run");
  if (!principal) return { status: "failed", error: NOT_ALLOWED };
  const run = await getRunStatus(runId, principal.id).catch(() => null);
  if (!run) return { status: "failed", runId, error: "That run is not one of yours." };
  if (run.status === "running") return { status: "running", runId };
  if (run.status === "failed") return { status: "failed", runId, error: run.error ?? "The run failed." };
  return { status: "done", runId, output: run.output ?? "" };
}
