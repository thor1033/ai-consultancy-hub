"use server";

import { listSkills } from "@ai-hub/db";
import type { SkillNavItem } from "./nav";

// Lightweight skills list for the sidebar's live Skills section.
export async function listSkillsNavAction(): Promise<SkillNavItem[]> {
  try {
    const skills = await listSkills();
    return skills.map((s) => ({ slug: s.slug, name: s.name }));
  } catch {
    return [];
  }
}
