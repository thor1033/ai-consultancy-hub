"use server";

import {
  setSkillKnowledgeCollection,
  getSkill,
  createSchedule,
  listSchedulesForSkill,
  setScheduleEnabled,
  deleteSchedule,
  type ScheduleKind,
  type SkillSchedule,
} from "@ai-hub/db";
import { runSkill } from "@/lib/runSkill";

// Server action invoked from the dashboard. Runs on the trusted server; binding
// it to a logged-in principal (so the PolicyEngine gates UI runs too) lands with
// WorkOS SSO in Phase 2.
export async function runSkillAction(slug: string, input: string, retrieve: boolean) {
  if (!input.trim()) return { error: "Enter an input first." };
  try {
    const out = await runSkill(slug, input, { retrieve });
    if ("notFound" in out) return { error: "Skill not found." };
    return out;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Run failed." };
  }
}

// Curation: scope this skill's RAG retrieval to a collection ("" ⇒ whole index).
export async function setSkillCollectionAction(slug: string, collection: string) {
  try {
    const ok = await setSkillKnowledgeCollection(slug, collection || null);
    if (!ok) return { error: "Skill not found." };
    return { collection: collection || null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed." };
  }
}

// --- Scheduled automations -------------------------------------------------

export interface ScheduleForm {
  input: string;
  retrieve: boolean;
  kind: ScheduleKind;
  timeOfDay?: string; // 'HH:MM'
  weekday?: number; // 0-6 (weekly)
  dayOfMonth?: number; // 1-31 (monthly)
  runAtLocal?: string; // datetime-local value (once)
}

export async function createScheduleAction(
  slug: string,
  form: ScheduleForm,
): Promise<{ schedules: SkillSchedule[] } | { error: string }> {
  if (!form.input.trim()) return { error: "Enter the input the schedule should run with." };

  let runAt: string | null = null;
  if (form.kind === "once") {
    if (!form.runAtLocal) return { error: "Pick a date and time." };
    const d = new Date(form.runAtLocal);
    if (Number.isNaN(d.getTime())) return { error: "Invalid date/time." };
    if (d.getTime() <= Date.now()) return { error: "Pick a time in the future." };
    runAt = d.toISOString();
  } else if (!form.timeOfDay) {
    return { error: "Pick a time of day." };
  }

  try {
    const skill = await getSkill(slug);
    if (!skill) return { error: "Skill not found." };
    await createSchedule({
      skillId: skill.id,
      input: form.input.trim(),
      retrieve: form.retrieve,
      kind: form.kind,
      timeOfDay: form.kind === "once" ? null : form.timeOfDay,
      weekday: form.kind === "weekly" ? form.weekday ?? 1 : null,
      dayOfMonth: form.kind === "monthly" ? form.dayOfMonth ?? 1 : null,
      runAt,
    });
    return { schedules: await listSchedulesForSkill(slug) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not create the schedule." };
  }
}

export async function toggleScheduleAction(
  slug: string,
  id: string,
  enabled: boolean,
): Promise<{ schedules: SkillSchedule[] } | { error: string }> {
  try {
    await setScheduleEnabled(id, enabled);
    return { schedules: await listSchedulesForSkill(slug) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function deleteScheduleAction(
  slug: string,
  id: string,
): Promise<{ schedules: SkillSchedule[] } | { error: string }> {
  try {
    await deleteSchedule(id);
    return { schedules: await listSchedulesForSkill(slug) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Delete failed." };
  }
}
