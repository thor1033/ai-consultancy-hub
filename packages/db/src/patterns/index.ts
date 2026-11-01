import { createAgent, deleteAgent, getAgent, rememberMemory, type Agent, type AgentInput, type McpEntry } from "../agents";
import { createSkill, getSkill, type SkillParameter } from "../skills";
import { createHandoff, type Handoff } from "../handoffs";
import { LONG_MEMORY_SHORT_HANDS } from "./long-memory-short-hands";
import { COORDINATOR_SPECIALISTS } from "./coordinator-specialists";
import { PIPELINE } from "./pipeline";
import { WRITER_REVIEWER } from "./writer-reviewer";
import { FRONT_DESK } from "./front-desk";

/*
 * Patterns: premade sets of agents that work together (docs/agent-patterns.md).
 *
 * A pattern is a few roles, each a whole agent (brief, memory or none, tools,
 * skills, induction memories), and the wiring between them: which role may
 * ASK which while it runs, and which HANDS to which when it finishes. A
 * person picks a pattern, fills in a few parameters, and gets real agent rows
 * on the org chart, theirs from then on — the pattern is where they came
 * from, not a binding.
 *
 * Why in code: a pattern is a design (who remembers, who starts clean, who may
 * ask whom, how deep), and that is reviewed and verified like code is
 * (packages/db/verify-patterns.mjs). Why rows, not a running "pattern
 * engine": the hub already knows how to run an agent, hold its writes, hand a
 * finished run on and let one agent ask another, so a pattern needs no
 * runtime of its own. It is a template for the things the hub already runs.
 */

/** The pseudo-server an agent's entry names to be allowed to ask other agents. */
export const ASK_SERVER = "agents";

/** The slugs an agent's entries let it ask. No entry, or no list, means none. */
export function askedAgents(entries: readonly McpEntry[] | undefined): string[] {
  const entry = (entries ?? []).find((e) => e && typeof e === "object" && (e as { name?: unknown }).name === ASK_SERVER);
  const list = (entry as { agents?: unknown } | undefined)?.agents;
  return Array.isArray(list) ? [...new Set(list.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()))] : [];
}

export interface PatternParam {
  key: string;
  label: string;
  help: string;
  /** `list`: one item per line, written "Name: what it covers". */
  kind: "text" | "textarea" | "list";
  required?: boolean;
  placeholder?: string;
  default?: string;
}

export type PatternValues = Record<string, string>;

/** One parsed line of a `list` parameter. */
export interface ListItem {
  key: string;
  name: string;
  text: string;
}

export interface PatternSkill {
  /** Slug suffix; the agent's slug is prepended. */
  slug: string;
  name: string;
  description: string;
  promptTemplate: string;
  parameters?: SkillParameter[];
}

export interface PatternRole {
  /** Slug suffix; the instance's slug is prepended. */
  key: string;
  name: string;
  description: string;
  instructions: string;
  keepsMemory: boolean;
  /** Role keys this role may ask while it runs. */
  asks?: string[];
  /** Tool servers, by name, beside memory and asks. Checked against the deployment by the caller. */
  servers?: string[];
  knowledgeAll?: boolean;
  maxIterations?: number;
  effort?: "low" | "medium" | "high";
  skills?: PatternSkill[];
  memories?: { key: string; content: string }[];
}

export interface PatternHandoff {
  from: string;
  /** Skill slug suffix on `from`; absent ⇒ any run of it. */
  skill?: string;
  to: string;
  prompt: string;
  note?: string;
}

export interface Pattern {
  slug: string;
  name: string;
  /** The name people use for it. */
  nickname: string;
  summary: string;
  /** When it is the right shape, one line each. */
  when: string[];
  /** A drawing of who talks to whom. */
  diagram: string;
  /** What a person decides after creating it, one line each. */
  decisions: string[];
  params: PatternParam[];
  roles(values: PatternValues, lists: Record<string, ListItem[]>): PatternRole[];
  handoffs?(values: PatternValues, lists: Record<string, ListItem[]>): PatternHandoff[];
}

/** Parameters every pattern takes, before its own. */
export const COMMON_PARAMS: PatternParam[] = [
  {
    key: "instance",
    label: "Name for this set",
    help: "A short name the agents are filed under, e.g. “Research” or “Proposals”. It prefixes every agent's slug.",
    kind: "text",
    required: true,
    placeholder: "Research",
  },
  { key: "owner", label: "Owner", help: "Who answers for these agents on the org chart.", kind: "text", placeholder: "Thor Simonsen" },
  { key: "functionName", label: "Function", help: "Where they are filed on the org chart.", kind: "text", placeholder: "Delivery" },
];

export const PATTERNS: readonly Pattern[] = [LONG_MEMORY_SHORT_HANDS, COORDINATOR_SPECIALISTS, PIPELINE, WRITER_REVIEWER, FRONT_DESK];

export function getPattern(slug: string): Pattern | null {
  return PATTERNS.find((p) => p.slug === slug) ?? null;
}

/** "Research & Insight" → "research-insight". The same rule the agent form uses. */
export function patternSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function parseList(raw: string): ListItem[] {
  const seen = new Set<string>();
  const out: ListItem[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const trimmed = line.trim().replace(/^[-*•]\s*/, "");
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    const name = (at >= 0 ? trimmed.slice(0, at) : trimmed).trim();
    const text = (at >= 0 ? trimmed.slice(at + 1) : "").trim();
    const key = patternSlug(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name, text });
  }
  return out;
}

/**
 * Fill `{{key}}` from the values, `{{agent:role}}` with a role's slug and
 * `{{name:role}}` with its name. Unknown placeholders stay as written, so a
 * mistake in a pattern shows in the preview rather than vanishing.
 */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w:-]+)\s*\}\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
}

export interface PatternPreview {
  errors: string[];
  instance: { slug: string; name: string };
  agents: AgentInput[];
  skills: { agentSlug: string; slug: string; name: string; description: string; promptTemplate: string; parameters: SkillParameter[] }[];
  memories: { agentSlug: string; key: string; content: string }[];
  handoffs: { fromSlug: string; skillSlug: string | null; toSlug: string; prompt: string; note: string }[];
}

/** What a pattern would create for these values. Pure: nothing is written. */
export function previewPattern(pattern: Pattern, values: PatternValues): PatternPreview {
  const errors: string[] = [];
  const v: PatternValues = {};
  const lists: Record<string, ListItem[]> = {};
  for (const p of [...COMMON_PARAMS, ...pattern.params]) {
    const raw = (values[p.key] ?? p.default ?? "").trim();
    v[p.key] = raw;
    if (p.kind === "list") {
      lists[p.key] = parseList(raw);
      if (p.required && lists[p.key].length === 0) errors.push(`${p.label}: give at least one line, written “Name: what it covers”.`);
    } else if (p.required && !raw) errors.push(`${p.label} is required.`);
  }
  const instanceSlug = patternSlug(v.instance);
  if (v.instance && !instanceSlug) errors.push("The name for this set needs some letters or digits.");
  const instance = { slug: instanceSlug, name: v.instance };
  const preview: PatternPreview = { errors, instance, agents: [], skills: [], memories: [], handoffs: [] };
  if (errors.length) return preview;

  const roles = pattern.roles(v, lists);
  const keys = new Set<string>();
  for (const r of roles) {
    if (keys.has(r.key)) errors.push(`Two roles would be called "${r.key}" — give them different names.`);
    keys.add(r.key);
  }
  const slugOf = (key: string) => `${instanceSlug}-${key}`;
  const vars: Record<string, string> = { ...v };
  // {{name:role}} is the agent's display name as it will appear on the org
  // chart, so a brief that names a colleague names it the way people see it.
  const nameOf = (r: PatternRole) => `${fill(r.name, v)} · ${v.instance}`;
  for (const r of roles) {
    vars[`agent:${r.key}`] = slugOf(r.key);
    vars[`name:${r.key}`] = nameOf(r);
  }
  for (const r of roles) {
    for (const a of r.asks ?? []) if (!keys.has(a)) errors.push(`Role "${r.key}" asks "${a}", which is not a role of this pattern.`);
    if ((r.asks ?? []).includes(r.key)) errors.push(`Role "${r.key}" cannot ask itself.`);
    const servers: McpEntry[] = (r.servers ?? []).map((name) => ({ name }));
    if (r.asks?.length) servers.push({ name: ASK_SERVER, agents: r.asks.map(slugOf) });
    const agentSlug = slugOf(r.key);
    preview.agents.push({
      slug: agentSlug,
      name: nameOf(r),
      description: fill(r.description, vars),
      instructions: fill(r.instructions, vars),
      mcpServers: servers,
      knowledgeAll: r.knowledgeAll ?? false,
      knowledgeCollections: [],
      maxIterations: r.maxIterations ?? null,
      effort: r.effort ?? null,
      keepsMemory: r.keepsMemory,
      enabled: true,
      placement: "hub",
      functionName: v.functionName,
      owner: v.owner,
      pattern: { slug: pattern.slug, instance: instanceSlug, role: r.key },
    });
    for (const s of r.skills ?? []) {
      preview.skills.push({
        agentSlug,
        slug: `${agentSlug}-${s.slug}`,
        name: fill(s.name, vars),
        description: fill(s.description, vars),
        promptTemplate: fill(s.promptTemplate, vars),
        parameters: s.parameters ?? [],
      });
    }
    for (const m of r.memories ?? []) preview.memories.push({ agentSlug, key: m.key, content: fill(m.content, vars) });
  }
  for (const h of pattern.handoffs?.(v, lists) ?? []) {
    if (!keys.has(h.from) || !keys.has(h.to)) errors.push(`A hand-off names a role that is not in this pattern (${h.from} → ${h.to}).`);
    else if (h.from === h.to) errors.push(`Role "${h.from}" cannot hand off to itself.`);
    else {
      const skillSlug = h.skill ? `${slugOf(h.from)}-${h.skill}` : null;
      if (skillSlug && !preview.skills.some((s) => s.slug === skillSlug)) errors.push(`A hand-off from "${h.from}" names a skill it does not have ("${h.skill}").`);
      preview.handoffs.push({ fromSlug: slugOf(h.from), skillSlug, toSlug: slugOf(h.to), prompt: fill(h.prompt, vars), note: fill(h.note ?? "", vars) });
    }
  }
  const leftover = [...preview.agents.map((a) => a.instructions ?? ""), ...preview.skills.map((s) => s.promptTemplate), ...preview.handoffs.map((h) => h.prompt)]
    .join("\n")
    .match(/\{\{\s*(?:agent|name):[\w-]+\s*\}\}|\{\{\s*(?:instance|owner|functionName)\s*\}\}/g);
  if (leftover) errors.push(`The pattern left a placeholder unfilled: ${[...new Set(leftover)].join(", ")}.`);
  return preview;
}

export interface PatternInstance {
  agents: Agent[];
  handoffs: Handoff[];
}

/**
 * Create the rows a preview describes. Every slug must be free first; a
 * failure part-way deletes what was created (skills, memories and hand-offs
 * go with their agents), so a pattern is either all there or not at all.
 */
export async function instantiatePattern(pattern: Pattern, values: PatternValues): Promise<PatternInstance> {
  const preview = previewPattern(pattern, values);
  if (preview.errors.length) throw new Error(preview.errors.join(" "));
  for (const a of preview.agents) {
    if (await getAgent(a.slug)) throw new Error(`An agent with the slug "${a.slug}" already exists. Pick another name for this set.`);
  }
  for (const s of preview.skills) {
    if (await getSkill(s.slug)) throw new Error(`A skill with the slug "${s.slug}" already exists. Pick another name for this set.`);
  }
  const created: Agent[] = [];
  try {
    const bySlug = new Map<string, Agent>();
    for (const a of preview.agents) {
      const agent = await createAgent(a);
      created.push(agent);
      bySlug.set(agent.slug, agent);
    }
    const skillIds = new Map<string, string>();
    for (const s of preview.skills) {
      const skill = await createSkill({ agentId: bySlug.get(s.agentSlug)!.id, slug: s.slug, name: s.name, description: s.description, promptTemplate: s.promptTemplate, parameters: s.parameters });
      skillIds.set(s.slug, skill.id);
    }
    for (const m of preview.memories) await rememberMemory(bySlug.get(m.agentSlug)!.id, m.key, m.content);
    const handoffs: Handoff[] = [];
    for (const h of preview.handoffs) {
      handoffs.push(
        await createHandoff({
          fromAgentId: bySlug.get(h.fromSlug)!.id,
          skillId: h.skillSlug ? (skillIds.get(h.skillSlug) ?? null) : null,
          toAgentId: bySlug.get(h.toSlug)!.id,
          prompt: h.prompt,
          note: h.note,
        }),
      );
    }
    return { agents: created, handoffs };
  } catch (err) {
    for (const a of created) await deleteAgent(a.id).catch(() => {});
    throw err;
  }
}
