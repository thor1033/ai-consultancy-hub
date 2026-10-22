"use server";

import { revalidatePath } from "next/cache";
import {
  createSchedule,
  getSkill,
  listSchedules,
  setScheduleEnabled,
  type Schedule,
  type SkillWithAgent,
} from "@ai-hub/db";
import { runSkillForPrincipal } from "@/lib/agentRuns";
import { sessionCan } from "@/lib/sessionPrincipal";
import { standingArgs } from "./standing";

/*
 * The Briefs page's two verbs: run a brief now, and put one on a morning clock.
 *
 * Both act as the person pressing the button. A run started here is theirs,
 * like a run from the console; a schedule created here is OWNED by them, so
 * it executes with their reach and stops when they are disabled
 * (docs/schedules.md). Nobody can schedule a brief on someone else's behalf.
 */

const NOT_ALLOWED = "You are not permitted to run agents.";

async function briefSkill(skillRef: string): Promise<SkillWithAgent | { error: string }> {
  const skill = await getSkill(skillRef);
  if (!skill || skill.kind !== "brief") return { error: "That brief no longer exists." };
  if (!skill.enabled || !skill.agentEnabled) return { error: `"${skill.name}" is switched off.` };
  return skill;
}

/** Run a brief now, as the viewer. Returns as soon as the run has an id. */
export async function runBriefNowAction(
  skillRef: string,
): Promise<{ ok: true; runId: string; status: "running" | "done" } | { error: string }> {
  const principal = await sessionCan("agent:run");
  if (!principal) return { error: NOT_ALLOWED };
  const skill = await briefSkill(skillRef);
  if ("error" in skill) return skill;
  const args = standingArgs(skill);
  if (!args) return { error: `"${skill.name}" needs arguments, so ask for it from the agent's page or Claude Code.` };

  const outcome = await runSkillForPrincipal({ skillRef: skill.id, args, principal, deadlineMs: 3000 });
  if (outcome.kind === "error") return { error: outcome.message };
  revalidatePath("/briefs");
  return { ok: true, runId: outcome.runId, status: outcome.kind === "running" ? "running" : "done" };
}

/**
 * The viewer's own morning schedule for a brief: create it, or switch it on or
 * off. One per person per brief; the time and days are theirs to pick.
 */
export async function setMorningBriefAction(input: {
  skillRef: string;
  on: boolean;
  atMinute?: number;
  weekends?: boolean;
}): Promise<{ ok: true; schedule: Schedule | null } | { error: string }> {
  const principal = await sessionCan("agent:run");
  if (!principal) return { error: NOT_ALLOWED };
  const skill = await briefSkill(input.skillRef);
  if ("error" in skill) return skill;

  const mine = (await listSchedules(skill.agentId)).find(
    (s) => s.agentSkillId === skill.id && s.ownerPrincipalId === principal.id,
  );

  if (!input.on) {
    if (mine) await setScheduleEnabled(mine.id, false);
    revalidatePath("/briefs");
    return { ok: true, schedule: mine ? { ...mine, enabled: false } : null };
  }

  const args = standingArgs(skill);
  if (!args) return { error: `"${skill.name}" needs arguments, so it cannot run unattended.` };

  // Re-enabling keeps the old row (and its run history); only the first time
  // creates one. Changing the time means switching off and on again, which is
  // a small price for not having an edit path to get wrong.
  if (mine) {
    await setScheduleEnabled(mine.id, true);
    revalidatePath("/briefs");
    return { ok: true, schedule: { ...mine, enabled: true } };
  }

  const atMinute = Number.isInteger(input.atMinute) ? (input.atMinute as number) : 7 * 60;
  const created = await createSchedule({
    agentId: skill.agentId,
    name: `${skill.name} — morning brief`,
    prompt: `Run the "${skill.name}" brief for today.`,
    agentSkillId: skill.id,
    skillArgs: args,
    kind: "daily",
    atMinute,
    weekdays: input.weekends ? [] : [1, 2, 3, 4, 5],
    // The deployment's zone, the same one every run's "Today is" line uses.
    timezone: process.env.HUB_TIMEZONE?.trim() || "UTC",
    ownerPrincipalId: principal.id,
  });
  if ("error" in created) return { error: created.error };
  revalidatePath("/briefs");
  return { ok: true, schedule: created };
}
