/*
 * The rules for making and changing a schedule, shared by the agent page
 * (app/agents/actions.ts) and the hub's MCP tools (lib/mcp/teamTools.ts), so a
 * schedule set up from Teqneo Code is held to exactly what the page holds it to.
 *
 * Any person with agent:run may create one (the caller checks that). It is
 * OWNED by whoever creates it and runs with their reach (docs/schedules.md);
 * changing it is the owner's, or an admin's.
 */
import {
  createSchedule,
  getAgent,
  getSchedule,
  getSkill,
  runsOnHub,
  setScheduleEnabled,
  type Schedule,
  type ScheduleKind,
} from "@ai-hub/db";
import { fillTemplate } from "@/lib/skillPrompt";

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

/** Create a schedule owned by `ownerId`. The caller has already checked agent:run. */
export async function createScheduleFor(
  ownerId: string,
  input: ScheduleDraft,
): Promise<{ schedule: Schedule; agentSlug: string } | { error: string }> {
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
    ownerPrincipalId: ownerId,
  });
  if ("error" in created) return { error: created.error };
  return { schedule: created, agentSlug: agent.slug };
}

/** The schedule, if `callerId` may change it: its owner, or an admin. */
export async function scheduleChangeableBy(
  callerId: string,
  isAdmin: boolean,
  id: string,
): Promise<Schedule | { error: string }> {
  const schedule = await getSchedule(id);
  if (!schedule) return { error: "That schedule no longer exists." };
  if (schedule.ownerPrincipalId !== callerId && !isAdmin) {
    return { error: "Only the person who set this schedule up, or an admin, can change it." };
  }
  return schedule;
}

export async function pauseOrResumeSchedule(schedule: Schedule, enabled: boolean): Promise<void> {
  await setScheduleEnabled(schedule.id, enabled);
}
