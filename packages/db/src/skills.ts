import { getSql } from "./client";

export type McpEntry = Record<string, unknown>;

export interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  latestVersion: number | null;
  createdAt: string;
}

// The admin control-plane view of a skill: its on/off state plus the explicit
// run grants (empty ⇒ any role with skill:run may run it).
export interface SkillAdminRow extends SkillSummary {
  mcpServers: McpEntry[];
  grantedPrincipals: string[];
}

export interface SkillVersion {
  version: number;
  instructions: string;
  model: string | null;
  effort: string | null;
  mcpServers: McpEntry[];
  baselineMinutes: number | null;
  createdAt: string;
}

export interface SkillDetail extends SkillSummary {
  versions: SkillVersion[];
}

export interface RunnableSkill {
  skillId: string;
  slug: string;
  version: number;
  instructions: string;
  model: string | null;
  effort: string | null;
  mcpServers: McpEntry[];
  baselineMinutes: number | null;
}

export interface CreateSkillInput {
  slug: string;
  name: string;
  description?: string;
  instructions: string;
  model?: string;
  effort?: string;
  mcpServers?: McpEntry[];
  baselineMinutes?: number;
}

export interface NewVersionInput {
  instructions: string;
  model?: string;
  effort?: string;
  mcpServers?: McpEntry[];
  baselineMinutes?: number;
}

// The public catalog: only enabled, non-archived skills — what practitioners run.
export async function listSkills(): Promise<SkillSummary[]> {
  const sql = getSql();
  return sql<SkillSummary[]>`
    select s.id, s.slug, s.name, s.description, s.enabled,
           max(v.version)::int as "latestVersion",
           s.created_at        as "createdAt"
    from skills s
    left join skill_versions v on v.skill_id = s.id
    where s.archived_at is null and s.enabled
    group by s.id
    order by s.created_at desc
  `;
}

// The control-plane catalog: every non-archived skill (enabled or not), with the
// latest version's MCP servers and its explicit run grants, for the admin console.
export async function listSkillsAdmin(): Promise<SkillAdminRow[]> {
  const sql = getSql();
  return sql<SkillAdminRow[]>`
    select s.id, s.slug, s.name, s.description, s.enabled,
           lv.version as "latestVersion",
           coalesce(lv.mcp_servers, '[]'::jsonb) as "mcpServers",
           s.created_at as "createdAt",
           coalesce(
             array_agg(distinct g.principal_id) filter (where g.principal_id is not null),
             '{}'
           ) as "grantedPrincipals"
    from skills s
    left join lateral (
      select version, mcp_servers from skill_versions
      where skill_id = s.id order by version desc limit 1
    ) lv on true
    left join skill_grants g on g.skill_id = s.id
    where s.archived_at is null
    group by s.id, lv.version, lv.mcp_servers
    order by s.created_at desc
  `;
}

export async function setSkillEnabled(slug: string, enabled: boolean): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update skills set enabled = ${enabled}, updated_at = now()
    where slug = ${slug} and archived_at is null
  `;
  return rows.count > 0;
}

export async function getSkill(slug: string): Promise<SkillDetail | null> {
  const sql = getSql();
  const [skill] = await sql<{ id: string; slug: string; name: string; description: string; enabled: boolean; createdAt: string }[]>`
    select id, slug, name, description, enabled, created_at as "createdAt"
    from skills where slug = ${slug} and archived_at is null
  `;
  if (!skill) return null;

  const versions = await sql<SkillVersion[]>`
    select version, instructions, model, effort,
           mcp_servers      as "mcpServers",
           baseline_minutes as "baselineMinutes",
           created_at       as "createdAt"
    from skill_versions where skill_id = ${skill.id}
    order by version desc
  `;

  return { ...skill, latestVersion: versions[0]?.version ?? null, versions };
}

export async function createSkill(input: CreateSkillInput): Promise<SkillDetail> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    const [skill] = await tx<{ id: string }[]>`
      insert into skills (slug, name, description)
      values (${input.slug}, ${input.name}, ${input.description ?? ""})
      returning id
    `;
    await tx`
      insert into skill_versions
        (skill_id, version, instructions, model, effort, mcp_servers, baseline_minutes)
      values
        (${skill.id}, 1, ${input.instructions}, ${input.model ?? null},
         ${input.effort ?? null}, ${tx.json((input.mcpServers ?? []) as never)},
         ${input.baselineMinutes ?? null})
    `;
  });
  // Re-query so the caller gets the full detail shape.
  return (await getSkill(input.slug))!;
}

export async function addSkillVersion(
  slug: string,
  input: NewVersionInput,
): Promise<SkillVersion | null> {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const [skill] = await tx<{ id: string }[]>`
      select id from skills where slug = ${slug} and archived_at is null
    `;
    if (!skill) return null;

    const [{ next }] = await tx<{ next: number }[]>`
      select coalesce(max(version), 0) + 1 as next
      from skill_versions where skill_id = ${skill.id}
    `;

    const [row] = await tx<SkillVersion[]>`
      insert into skill_versions
        (skill_id, version, instructions, model, effort, mcp_servers, baseline_minutes)
      values
        (${skill.id}, ${next}, ${input.instructions}, ${input.model ?? null},
         ${input.effort ?? null}, ${tx.json((input.mcpServers ?? []) as never)},
         ${input.baselineMinutes ?? null})
      returning version, instructions, model, effort,
                mcp_servers      as "mcpServers",
                baseline_minutes as "baselineMinutes",
                created_at       as "createdAt"
    `;
    await tx`update skills set updated_at = now() where id = ${skill.id}`;
    return row;
  });
}

export async function getRunnableSkill(slug: string): Promise<RunnableSkill | null> {
  const sql = getSql();
  const [row] = await sql<RunnableSkill[]>`
    select s.id           as "skillId",
           s.slug,
           v.version,
           v.instructions,
           v.model,
           v.effort,
           v.mcp_servers      as "mcpServers",
           v.baseline_minutes as "baselineMinutes"
    from skills s
    join skill_versions v on v.skill_id = s.id
    where s.slug = ${slug} and s.archived_at is null and s.enabled
    order by v.version desc
    limit 1
  `;
  return row ?? null;
}

export interface RecordRunInput {
  skillId: string;
  version: number;
  input: string;
  output?: string;
  status?: string;
  costUsd?: number;
  latencyMs?: number;
  tokens?: unknown;
  traceId?: string;
  retrieved?: unknown; // RAG provenance: the chunks this run pulled
}

export async function listSkillGrantPrincipals(slug: string): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ principalId: string }[]>`
    select g.principal_id as "principalId"
    from skill_grants g
    join skills s on s.id = g.skill_id
    where s.slug = ${slug}
  `;
  return rows.map((r) => r.principalId);
}

export async function addSkillGrant(slug: string, principalId: string): Promise<boolean> {
  const sql = getSql();
  const [skill] = await sql<{ id: string }[]>`
    select id from skills where slug = ${slug} and archived_at is null
  `;
  if (!skill) return false;
  await sql`
    insert into skill_grants (skill_id, principal_id)
    values (${skill.id}, ${principalId})
    on conflict do nothing
  `;
  return true;
}

export async function recordRun(run: RecordRunInput): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into skill_runs
      (skill_id, version, input, output, status, cost_usd, latency_ms, tokens,
       trace_id, retrieved)
    values
      (${run.skillId}, ${run.version}, ${run.input}, ${run.output ?? null},
       ${run.status ?? "succeeded"}, ${run.costUsd ?? null}, ${run.latencyMs ?? null},
       ${sql.json((run.tokens ?? null) as never)}, ${run.traceId ?? null},
       ${sql.json((run.retrieved ?? []) as never)})
    returning id
  `;
  return row.id;
}
