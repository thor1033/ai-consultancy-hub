"use server";

import { revalidatePath } from "next/cache";
import { getPattern, instantiatePattern, previewPattern, type PatternValues } from "@ai-hub/db";
import { knownServers } from "@/lib/runSession";
import { sessionCan } from "@/lib/sessionPrincipal";

const NOT_ALLOWED = "Only an admin can create agents.";

export interface PatternPreviewView {
  errors: string[];
  agents: { slug: string; name: string; description: string; keepsMemory: boolean; asks: string[]; servers: string[]; skills: string[]; unknownServers: string[] }[];
  handoffs: { from: string; to: string; skill: string | null }[];
}

/** What a pattern would create for these values. Nothing is written. */
export async function previewPatternAction(slug: string, values: PatternValues): Promise<PatternPreviewView | { error: string }> {
  if (!(await sessionCan("agent:run"))) return { error: NOT_ALLOWED };
  const pattern = getPattern(slug);
  if (!pattern) return { error: "No such pattern." };
  const pv = previewPattern(pattern, clean(values));
  const known = new Set(knownServers());
  const names = new Map(pv.agents.map((a) => [a.slug, a.name]));
  return {
    errors: pv.errors,
    agents: pv.agents.map((a) => {
      const servers = (a.mcpServers ?? []).map((e) => String((e as { name?: unknown }).name ?? ""));
      const asks = ((a.mcpServers ?? []).find((e) => (e as { name?: unknown }).name === "agents") as { agents?: string[] } | undefined)?.agents ?? [];
      return {
        slug: a.slug,
        name: a.name,
        description: a.description ?? "",
        keepsMemory: a.keepsMemory !== false,
        asks: asks.map((s) => names.get(s) ?? s),
        servers: servers.filter((n) => n !== "agents"),
        skills: pv.skills.filter((s) => s.agentSlug === a.slug).map((s) => s.name),
        // Named by the person, checked against the deployment: a server the
        // hub does not know is skipped at run time, so say so before creating.
        unknownServers: servers.filter((n) => n !== "agents" && !known.has(n)),
      };
    }),
    handoffs: pv.handoffs.map((h) => ({ from: names.get(h.fromSlug) ?? h.fromSlug, to: names.get(h.toSlug) ?? h.toSlug, skill: h.skillSlug ? pv.skills.find((s) => s.slug === h.skillSlug)?.name ?? h.skillSlug : null })),
  };
}

export async function createFromPatternAction(slug: string, values: PatternValues): Promise<{ ok: true; agents: { slug: string; name: string }[] } | { error: string }> {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  const pattern = getPattern(slug);
  if (!pattern) return { error: "No such pattern." };
  try {
    const made = await instantiatePattern(pattern, clean(values));
    revalidatePath("/agents");
    return { ok: true, agents: made.agents.map((a) => ({ slug: a.slug, name: a.name })) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not create the agents." };
  }
}

/** Strings only, bounded: a server action is a public endpoint. */
function clean(values: PatternValues): PatternValues {
  const out: PatternValues = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (typeof k === "string" && k.length <= 40 && typeof v === "string") out[k] = v.slice(0, 8000);
  }
  return out;
}
