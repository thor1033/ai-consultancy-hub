import { getSql } from "./client";

/*
 * Hand-offs between agents, as rows (docs/agent-patterns.md).
 *
 * A hand-off says: when a run of this agent — any run, or a run of one of its
 * skills — finishes, start that agent with this prompt, as the same person.
 * The hub does the handing (apps/web/src/lib/handoffs.ts) after the finished
 * run is recorded, so the next agent can read it. The first hand-off was
 * written in code: the Secretary's meeting skills to the Context Steward. As
 * rows, a pattern can wire a pipeline, the steward's own seed declares its
 * two, and a person can switch any of them off on the agent's page.
 *
 * What a hand-off is not: a way for an agent to reach another agent's tools,
 * memory or knowledge. The next run is its own run, as the person whose run
 * finished, with its own agent's reach, its writes held like any other.
 */

export interface Handoff {
  id: string;
  fromAgentId: string;
  fromAgentSlug: string;
  fromAgentName: string;
  /** Null ⇒ any run of the agent. */
  skillId: string | null;
  skillSlug: string | null;
  skillName: string | null;
  toAgentId: string;
  toAgentSlug: string;
  toAgentName: string;
  toAgentEnabled: boolean;
  prompt: string;
  note: string;
  enabled: boolean;
  createdAt: string;
}

export interface HandoffInput {
  fromAgentId: string;
  skillId?: string | null;
  toAgentId: string;
  prompt: string;
  note?: string;
  enabled?: boolean;
}

/** The placeholders a hand-off prompt may use. */
export interface HandoffVars {
  sessionId: string;
  output: string;
  prompt: string;
  agentName: string;
  skillName: string;
}

export const HANDOFF_PLACEHOLDERS: readonly (keyof HandoffVars)[] = ["sessionId", "output", "prompt", "agentName", "skillName"];

/**
 * Fill a hand-off prompt. Unknown placeholders are left as written, so a
 * typo shows up in the next agent's prompt rather than vanishing.
 */
export function renderHandoffPrompt(template: string, vars: HandoffVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
    (HANDOFF_PLACEHOLDERS as readonly string[]).includes(key) ? vars[key as keyof HandoffVars] : whole,
  );
}

const COLUMNS = `
  h.id, h.from_agent_id as "fromAgentId", f.slug as "fromAgentSlug", f.name as "fromAgentName",
  h.skill_id as "skillId", k.slug as "skillSlug", k.name as "skillName",
  h.to_agent_id as "toAgentId", t.slug as "toAgentSlug", t.name as "toAgentName", t.enabled as "toAgentEnabled",
  h.prompt, h.note, h.enabled, h.created_at as "createdAt"
`;
const JOINS = `
  from agent_handoffs h
  join agents f on f.id = h.from_agent_id
  join agents t on t.id = h.to_agent_id
  left join agent_skills k on k.id = h.skill_id
`;

export async function createHandoff(input: HandoffInput): Promise<Handoff> {
  if (input.fromAgentId === input.toAgentId) throw new Error("An agent cannot hand off to itself.");
  if (!input.prompt.trim()) throw new Error("A hand-off needs a prompt for the next agent.");
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into agent_handoffs (from_agent_id, skill_id, to_agent_id, prompt, note, enabled)
    values (${input.fromAgentId}, ${input.skillId ?? null}, ${input.toAgentId}, ${input.prompt.trim()},
            ${(input.note ?? "").trim()}, ${input.enabled ?? true})
    returning id`;
  return (await getHandoff(row.id))!;
}

export async function getHandoff(id: string): Promise<Handoff | null> {
  const sql = getSql();
  const rows = await sql<Handoff[]>`select ${sql.unsafe(COLUMNS)} ${sql.unsafe(JOINS)} where h.id = ${id}`;
  return rows[0] ?? null;
}

/** Every hand-off an agent is part of, as the one that finishes or the one started, oldest first. */
export async function listHandoffs(agentId: string): Promise<Handoff[]> {
  const sql = getSql();
  return sql<Handoff[]>`
    select ${sql.unsafe(COLUMNS)} ${sql.unsafe(JOINS)}
     where h.from_agent_id = ${agentId} or h.to_agent_id = ${agentId}
     order by h.created_at`;
}

/**
 * The hand-offs that fire when a run of this agent finishes: the ones keyed to
 * the skill it ran, plus the ones keyed to any run. Only enabled ones; whether
 * the next agent is itself enabled is the runtime's to say in the answer.
 */
export async function handoffsFor(fromAgentId: string, skillId: string | null): Promise<Handoff[]> {
  const sql = getSql();
  return sql<Handoff[]>`
    select ${sql.unsafe(COLUMNS)} ${sql.unsafe(JOINS)}
     where h.from_agent_id = ${fromAgentId} and h.enabled
       and (h.skill_id is null or h.skill_id = ${skillId})
     order by h.created_at`;
}

export async function setHandoffEnabled(id: string, enabled: boolean): Promise<Handoff | null> {
  const sql = getSql();
  await sql`update agent_handoffs set enabled = ${enabled} where id = ${id}`;
  return getHandoff(id);
}

export async function updateHandoffPrompt(id: string, prompt: string, note?: string): Promise<Handoff | null> {
  if (!prompt.trim()) throw new Error("A hand-off needs a prompt for the next agent.");
  const sql = getSql();
  await sql`update agent_handoffs set prompt = ${prompt.trim()}, note = coalesce(${note?.trim() ?? null}, note) where id = ${id}`;
  return getHandoff(id);
}

export async function deleteHandoff(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from agent_handoffs where id = ${id}`;
  return rows.count > 0;
}
