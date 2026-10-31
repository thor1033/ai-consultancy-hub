/*
 * Applying a seed — the same rules on a laptop and on every release.
 *
 * A seed is an agent that lives in code: its row, its skills and an induction
 * pack of memories (seeds/*.ts). Every deploy applies every seed (the release
 * command, packages/db/release.mjs), so a change to an agent's brief ships the
 * way a change to the code does: by merging it.
 *
 * The hard part is not undoing what people do between releases. Someone sets
 * the Secretary's knowledge scope on its page, switches the approval gate off
 * for the PM, the agent rewrites a memory it was seeded with. A seed that
 * simply wrote its definition on every deploy would quietly revert all of
 * that. So each release records what the code set (seed_applied), and the
 * next one merges three ways, field by field:
 *
 *   current == what the code last set  → nobody touched it: take the new code value
 *   current != what the code last set  → a person (or the agent) changed it: keep theirs
 *
 * With nothing recorded yet — the first release after this file, or a row
 * made by hand — the definition owns the brief and the page owns the rest:
 * instructions, servers, stamina and place on the org chart come from code;
 * model, effort, knowledge scope and placement stay as they are. A server
 * entry keeps any setting the page added to it (the approval gate's
 * `"writes"`), so the first release does not switch a gate back on.
 *
 * Never touched on an existing row: whether it is enabled. A person switched
 * it off; a deploy does not switch it back on. And a seeded agent that was
 * deleted after a release recorded it stays deleted.
 */
import { getSql } from "../client";
import { createAgent, getAgent, listMemories, rememberMemory, updateAgent, type AgentInput, type Agent } from "../agents";
import { createSkill, getSkill, updateSkill, type SkillInput } from "../skills";
import { createHandoff, listHandoffs, updateHandoffPrompt } from "../handoffs";

/**
 * A hand-off INTO the seeded agent: when a run of `fromAgent` (its slug; of
 * `skill`, if named) finishes, start this agent with `prompt`. Declared on the
 * agent that receives, because that is the agent whose job it describes.
 */
export interface SeedHandoff {
  fromAgent: string;
  skill?: string;
  prompt: string;
  note?: string;
}

export interface Seed {
  agent: AgentInput;
  skills: Omit<SkillInput, "agentId">[];
  memories: { key: string; content: string }[];
  handoffs?: SeedHandoff[];
}

export interface ApplyOptions {
  /** Refresh the skills only; leave the agent row and its memories alone. */
  skillsOnly?: boolean;
  log?: (line: string) => void;
}

/** The agent fields a seed sets. `enabled` is deliberately absent. */
const CODE_OWNED = ["name", "description", "instructions", "mcpServers", "maxIterations", "functionName", "owner"] as const;
const PAGE_OWNED = ["model", "effort", "knowledgeCollections", "knowledgeAll", "placement"] as const;
type AgentField = (typeof CODE_OWNED)[number] | (typeof PAGE_OWNED)[number];
/** The skill fields a seed sets. `enabled` is the page's switch. */
const SKILL_FIELDS = ["name", "description", "promptTemplate", "parameters"] as const;

// ── comparing ────────────────────────────────────────────────────────────────

/** Key-order-independent JSON, with undefined and null treated as the same absence. */
function canon(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k] ?? null]))
      : x,
  );
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

/** What a field of a stored row looks like, normalised the way the store normalises it. */
function stored(field: AgentField, value: unknown): unknown {
  if (field === "knowledgeCollections") return [...new Set(((value as string[] | undefined) ?? []).map((n) => n.trim()).filter(Boolean))];
  if (field === "description" || field === "instructions" || field === "functionName" || field === "owner") return ((value as string | undefined) ?? "").trim();
  if (field === "mcpServers") return value ?? [];
  if (field === "knowledgeAll") return value ?? false;
  if (field === "placement") return value ?? "hub";
  return value ?? null;
}

/**
 * The code's server list, with whatever the page added to an entry that is
 * still there kept: the approval gate's `"writes": "allow"`, say. The list
 * itself — which servers — is the code's.
 */
function mergeServers(code: unknown, current: unknown): unknown {
  const now = new Map(((current as Record<string, unknown>[] | undefined) ?? []).map((e) => [String(e.name ?? ""), e]));
  return ((code as Record<string, unknown>[] | undefined) ?? []).map((e) => ({ ...(now.get(String(e.name ?? "")) ?? {}), ...e }));
}

// ── what the code last set ───────────────────────────────────────────────────

type Kind = "agent" | "skill" | "memory" | "handoff";

async function lastApplied(kind: Kind, key: string): Promise<Record<string, unknown> | null> {
  const sql = getSql();
  const rows = await sql<{ value: Record<string, unknown> }[]>`select value from seed_applied where kind = ${kind} and key = ${key}`;
  return rows[0]?.value ?? null;
}

async function record(kind: Kind, key: string, value: Record<string, unknown>): Promise<void> {
  const sql = getSql();
  await sql`
    insert into seed_applied (kind, key, value) values (${kind}, ${key}, ${sql.json(value as never)})
    on conflict (kind, key) do update set value = excluded.value, applied_at = now()
  `;
}

// ── applying ─────────────────────────────────────────────────────────────────

export interface Applied {
  slug: string;
  agent: "created" | "updated" | "unchanged" | "kept deleted" | "skipped";
  /** Fields that kept a person's value over a newer code value. */
  kept: string[];
  skills: { slug: string; outcome: string }[];
  memories: { key: string; outcome: string }[];
  handoffs: { from: string; outcome: string }[];
}

export async function applySeed(seed: Seed, opts: ApplyOptions = {}): Promise<Applied> {
  const log = opts.log ?? (() => {});
  const slug = seed.agent.slug;
  const out: Applied = { slug, agent: "unchanged", kept: [], skills: [], memories: [], handoffs: [] };
  const code = Object.fromEntries([...CODE_OWNED, ...PAGE_OWNED].map((f) => [f, stored(f, seed.agent[f])])) as Record<AgentField, unknown>;

  // ── the agent row
  const base = await lastApplied("agent", slug);
  let agent: Agent | null = await getAgent(slug);
  if (!agent) {
    if (base) {
      out.agent = "kept deleted";
      log(`kept deleted  agent   ${slug}  (deleted after a release seeded it; not recreated)`);
      return out;
    }
    if (opts.skillsOnly) {
      out.agent = "skipped";
      log(`skipped       agent   ${slug}  (--skills-only, and no agent yet)`);
      return out;
    }
    agent = await createAgent(seed.agent);
    out.agent = "created";
    log(`created       agent   ${slug}`);
  } else if (!opts.skillsOnly) {
    const patch: Partial<AgentInput> = {};
    for (const f of [...CODE_OWNED, ...PAGE_OWNED]) {
      const current = stored(f, (agent as unknown as Record<string, unknown>)[f]);
      let next: unknown;
      if (base) {
        const was = stored(f, base[f]);
        if (same(current, was)) next = code[f];
        else {
          next = current;
          if (!same(code[f], was)) out.kept.push(f);
        }
      } else {
        // Nothing recorded: the brief is the code's, the dials are the page's.
        next = (PAGE_OWNED as readonly string[]).includes(f) ? current : f === "mcpServers" ? mergeServers(code[f], current) : code[f];
      }
      if (!same(next, current)) (patch as Record<string, unknown>)[f] = next;
    }
    if (Object.keys(patch).length) {
      agent = (await updateAgent(agent.id, patch))!;
      out.agent = "updated";
    }
    log(
      `${out.agent.padEnd(13)} agent   ${slug}${Object.keys(patch).length ? `  (${Object.keys(patch).join(", ")})` : ""}` +
        (out.kept.length ? `  — kept the page's ${out.kept.join(", ")} over a newer code value` : ""),
    );
  }
  if (!opts.skillsOnly) await record("agent", slug, code);

  // ── the skills
  for (const s of seed.skills) {
    const codeSkill = Object.fromEntries(SKILL_FIELDS.map((f) => [f, s[f] ?? (f === "parameters" ? [] : "")]));
    const found = await getSkill(s.slug);
    if (found && found.agentId !== agent.id) {
      // Slugs are global because they become tool names. Not fatal to the
      // release — every other seed still applies — but said loudly.
      out.skills.push({ slug: s.slug, outcome: `refused: belongs to ${found.agentSlug}` });
      log(`REFUSED       skill   ${s.slug}  (already belongs to ${found.agentSlug}; slugs are global tool names)`);
      continue;
    }
    if (!found) {
      await createSkill({ ...s, agentId: agent.id });
      out.skills.push({ slug: s.slug, outcome: "created" });
      log(`created       skill   ${s.slug}`);
    } else {
      // Skills are written in code, so with nothing recorded the code wins.
      const sbase = await lastApplied("skill", s.slug);
      const patch: Partial<SkillInput> = {};
      const kept: string[] = [];
      for (const f of SKILL_FIELDS) {
        const current = (found as unknown as Record<string, unknown>)[f];
        const next = sbase && !same(current, sbase[f]) ? current : codeSkill[f];
        if (sbase && !same(current, sbase[f]) && !same(codeSkill[f], sbase[f])) kept.push(f);
        if (!same(next, current)) (patch as Record<string, unknown>)[f] = next;
      }
      if (Object.keys(patch).length) await updateSkill(found.id, patch);
      const outcome = Object.keys(patch).length ? "updated" : "unchanged";
      out.skills.push({ slug: s.slug, outcome });
      log(`${outcome.padEnd(13)} skill   ${s.slug}${kept.length ? `  — kept the page's ${kept.join(", ")}` : ""}`);
    }
    await record("skill", s.slug, codeSkill);
  }

  // ── the memories: an induction pack, never a leash
  if (!opts.skillsOnly) {
    const now = new Map((await listMemories(agent.id)).map((m) => [m.key, m]));
    for (const m of seed.memories) {
      const key = `${slug}:${m.key}`;
      const mbase = await lastApplied("memory", key);
      const current = now.get(m.key);
      let outcome: string;
      if (!current) {
        if (mbase) outcome = "kept forgotten";
        else {
          await rememberMemory(agent.id, m.key, m.content);
          outcome = "created";
        }
      } else if (current.content === m.content) outcome = "unchanged";
      else if (mbase && current.content === mbase.content) {
        await rememberMemory(agent.id, m.key, m.content, current.active);
        outcome = "updated";
      } else outcome = "kept the agent's";
      out.memories.push({ key: m.key, outcome });
      log(`${outcome.padEnd(13)} memory  ${slug}:${m.key}`);
      await record("memory", key, { content: m.content });
    }
  }

  // ── the hand-offs into it: the prompt is the code's unless a person changed
  // it; whether it is on is the page's switch, like a skill's.
  if (!opts.skillsOnly) {
    for (const h of seed.handoffs ?? []) {
      const from = await getAgent(h.fromAgent);
      const skill = h.skill ? await getSkill(h.skill) : null;
      const label = `${h.fromAgent}${h.skill ? `/${h.skill}` : ""} → ${slug}`;
      if (!from || (h.skill && (!skill || skill.agentId !== from.id))) {
        // Not fatal: the other agent may be seeded later, or by hand.
        out.handoffs.push({ from: label, outcome: `skipped: ${!from ? `no agent "${h.fromAgent}"` : `no skill "${h.skill}" on it`}` });
        log(`skipped       handoff ${label}  (${!from ? `no agent "${h.fromAgent}"` : `no skill "${h.skill}" on ${h.fromAgent}`} yet)`);
        continue;
      }
      const key = `${slug}<-${h.fromAgent}${h.skill ? `/${h.skill}` : ""}`;
      const codeValue = { prompt: h.prompt, note: h.note ?? "" };
      const existing = (await listHandoffs(agent.id)).find(
        (x) => x.toAgentId === agent.id && x.fromAgentId === from.id && x.skillId === (skill?.id ?? null),
      );
      const hbase = await lastApplied("handoff", key);
      let outcome: string;
      if (!existing) {
        if (hbase) outcome = "kept deleted";
        else {
          await createHandoff({ fromAgentId: from.id, skillId: skill?.id ?? null, toAgentId: agent.id, prompt: h.prompt, note: h.note });
          outcome = "created";
        }
      } else if (same({ prompt: existing.prompt, note: existing.note }, codeValue)) outcome = "unchanged";
      else if (hbase && same({ prompt: existing.prompt, note: existing.note }, { prompt: hbase.prompt, note: hbase.note })) {
        await updateHandoffPrompt(existing.id, h.prompt, h.note ?? "");
        outcome = "updated";
      } else outcome = "kept the page's prompt";
      out.handoffs.push({ from: label, outcome });
      log(`${outcome.padEnd(13)} handoff ${label}`);
      await record("handoff", key, codeValue);
    }
  }
  return out;
}
