"use server";

import { getSession, createSkill, markSessionSkillified } from "@ai-hub/db";
import { runSession } from "@/lib/runSession";
import { distillSkill, serverMarkers, type SkillDraft } from "@/lib/skillify";

// Server actions for the Skillification workbench. Like the skill run action,
// these run server-trusted; binding them to a logged-in principal (so the
// PolicyEngine gates UI actions too) lands with WorkOS SSO in Phase 2.

export async function runSessionAction(prompt: string, servers: string[]) {
  if (!prompt.trim()) return { error: "Enter a task first." };
  try {
    const { sessionId, servers: used, result } = await runSession({ prompt, servers });
    return {
      sessionId,
      servers: used,
      text: result.text,
      model: result.model,
      iterations: result.iterations,
      toolsUsed: result.toolsUsed,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      totalTokens: result.usage.totalTokens,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Session failed." };
  }
}

// Step 1 of Skillify: distill the session into a draft for the reviewer to edit.
export async function distillSessionAction(sessionId: string) {
  try {
    const session = await getSession(sessionId);
    if (!session) return { error: "Session not found." };
    if (session.skillId) {
      return { error: "This session was already skillified.", skillSlug: session.skillSlug };
    }
    const draft = await distillSkill(session);
    return { draft, servers: session.mcpServers };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Distillation failed." };
  }
}

// Step 2 of Skillify: persist the (possibly edited) draft as a versioned Skill.
export async function createSkillFromDraftAction(sessionId: string, draft: SkillDraft) {
  if (!draft.slug.trim() || !draft.name.trim() || !draft.instructions.trim()) {
    return { error: "Name, slug, and instructions are all required." };
  }
  try {
    const session = await getSession(sessionId);
    if (!session) return { error: "Session not found." };
    if (session.skillId) {
      return { error: "This session was already skillified.", skillSlug: session.skillSlug };
    }
    const skill = await createSkill({
      slug: draft.slug.trim(),
      name: draft.name.trim(),
      description: draft.description,
      instructions: draft.instructions,
      model: session.model ?? undefined,
      mcpServers: serverMarkers(session.mcpServers),
      baselineMinutes: draft.baselineMinutes ?? undefined,
    });
    await markSessionSkillified(session.id, skill.id);
    return { slug: skill.slug, name: skill.name };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return { error: "A skill with that slug already exists. Choose a different slug." };
    }
    return { error: e instanceof Error ? e.message : "Create failed." };
  }
}
