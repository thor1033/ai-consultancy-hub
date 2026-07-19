"use server";

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
