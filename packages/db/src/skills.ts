import { getSql } from "./client";

/*
 * Skills: a named, parameterised thing one agent knows how to do.
 *
 * Org-chart terms — an Agent is an employee, a Skill is their expertise. The
 * difference it makes is in the client's tool list: instead of one chat box
 * labelled "delivery lead", the analyst sees `hub_skill_weekly_client_deck`
 * with `client` and `week` as real arguments. That is the difference between a
 * transcript somebody saved and something a colleague can invoke.
 *
 * See schema.sql for why this is not the `skills` table deleted in August.
 */

export type ParameterType = "string" | "number" | "boolean";

export interface SkillParameter {
  /** Identifier, and the `{{name}}` placeholder in the template. */
  name: string;
  description: string;
  required?: boolean;
  type?: ParameterType;
  /** When present, the value must be one of these. */
  options?: string[];
}

export interface Skill {
  id: string;
  agentId: string;
  slug: string;
  name: string;
  description: string;
  promptTemplate: string;
  parameters: SkillParameter[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A skill with the bits of its agent a caller needs to run it. */
export interface SkillWithAgent extends Skill {
  agentSlug: string;
  agentName: string;
  agentEnabled: boolean;
  agentPlacement: "hub" | "local" | "both";
}

const SKILL_COLUMNS = `
  id,
  agent_id        as "agentId",
  slug, name, description,
  prompt_template as "promptTemplate",
  parameters, enabled,
  created_at      as "createdAt",
  updated_at      as "updatedAt"
`;

export async function listSkills(agentId?: string): Promise<Skill[]> {
  const sql = getSql();
  return sql<Skill[]>`
    select ${sql.unsafe(SKILL_COLUMNS)} from agent_skills
    where ${agentId ? sql`agent_id = ${agentId}` : sql`true`}
    order by name
  `;
}

/**
 * Every enabled skill whose agent is also enabled, with its agent.
 *
 * Both halves matter: disabling an employee has to withdraw their expertise
 * too, or a skill keeps working through an agent someone deliberately switched
 * off. One query because this runs on every MCP connection, where it decides
 * which tools exist.
 */
export async function listRunnableSkills(): Promise<SkillWithAgent[]> {
  const sql = getSql();
  return sql<SkillWithAgent[]>`
    select s.id,
           s.agent_id        as "agentId",
           s.slug, s.name, s.description,
           s.prompt_template as "promptTemplate",
           s.parameters, s.enabled,
           s.created_at      as "createdAt",
           s.updated_at      as "updatedAt",
           a.slug            as "agentSlug",
           a.name            as "agentName",
           a.enabled         as "agentEnabled",
           a.placement       as "agentPlacement"
      from agent_skills s
      join agents a on a.id = s.agent_id
     where s.enabled and a.enabled
     order by s.name
  `;
}

export async function getSkill(slugOrId: string): Promise<SkillWithAgent | null> {
  const sql = getSql();
  // Matched on slug or id, the same way getAgent does, so config can hold the
  // readable one. The uuid cast is guarded because a slug is not a uuid and
  // Postgres would raise rather than simply not match.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
  const [row] = await sql<SkillWithAgent[]>`
    select s.id,
           s.agent_id        as "agentId",
           s.slug, s.name, s.description,
           s.prompt_template as "promptTemplate",
           s.parameters, s.enabled,
           s.created_at      as "createdAt",
           s.updated_at      as "updatedAt",
           a.slug            as "agentSlug",
           a.name            as "agentName",
           a.enabled         as "agentEnabled",
           a.placement       as "agentPlacement"
      from agent_skills s
      join agents a on a.id = s.agent_id
     where s.slug = ${slugOrId}
        or (${isUuid} and s.id = ${isUuid ? slugOrId : null}::uuid)
     limit 1
  `;
  return row ?? null;
}

export interface SkillInput {
  agentId: string;
  slug: string;
  name: string;
  description?: string;
  promptTemplate?: string;
  parameters?: SkillParameter[];
  enabled?: boolean;
}

export async function createSkill(input: SkillInput): Promise<Skill> {
  const sql = getSql();
  const rows = await sql<Skill[]>`
    insert into agent_skills
      (agent_id, slug, name, description, prompt_template, parameters, enabled)
    values
      (${input.agentId}, ${input.slug}, ${input.name}, ${input.description ?? ""},
       ${input.promptTemplate ?? ""},
       ${sql.json((input.parameters ?? []) as never)},
       ${input.enabled ?? true})
    returning ${sql.unsafe(SKILL_COLUMNS)}
  `;
  return rows[0];
}

export async function updateSkill(
  id: string,
  input: Partial<SkillInput>,
): Promise<Skill | null> {
  const sql = getSql();
  // Read-modify-write, for the same reason updateAgent does it: an omitted
  // field must stay untouched while a deliberately emptied one must clear.
  const [current] = await sql<Skill[]>`
    select ${sql.unsafe(SKILL_COLUMNS)} from agent_skills where id = ${id}
  `;
  if (!current) return null;
  const next = { ...current, ...input };

  const rows = await sql<Skill[]>`
    update agent_skills set
      slug            = ${next.slug},
      name            = ${next.name},
      description     = ${next.description ?? ""},
      prompt_template = ${next.promptTemplate ?? ""},
      parameters      = ${sql.json((next.parameters ?? []) as never)},
      enabled         = ${next.enabled ?? true},
      updated_at      = now()
    where id = ${id}
    returning ${sql.unsafe(SKILL_COLUMNS)}
  `;
  return rows[0] ?? null;
}

export async function deleteSkill(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from agent_skills where id = ${id}`;
  return rows.count > 0;
}
