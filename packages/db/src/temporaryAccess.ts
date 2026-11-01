import { getSql } from "./client";
import type { PrincipalRow } from "./credentials";

// Temporary access — the break-glass procedure (docs/client-deployment.md).
// Storage only: who may grant it, and the vendor rule, are in apps/web and
// @ai-hub/authz.

const COLS = `
  id, email, workos_user_id as "workosUserId", display_name as "displayName",
  roles, agent_id as "agentId", enabled, preferences,
  access_expires_at as "accessExpiresAt", access_reason as "accessReason",
  access_granted_by as "accessGrantedBy", access_granted_at as "accessGrantedAt",
  created_at as "createdAt", updated_at as "updatedAt"
`;

/**
 * Give someone access until `until`. A new person gets a row (id = email); a
 * person whose access is already temporary has it renewed. A person with
 * standing access is refused: turning their access temporary would end it
 * without anyone deciding that.
 */
export async function grantTemporaryAccess(input: {
  email: string;
  displayName?: string;
  roles: string[];
  until: Date;
  reason: string;
  grantedBy: string;
}): Promise<{ row: PrincipalRow } | { error: string }> {
  const email = input.email.trim().toLowerCase();
  const sql = getSql();
  const [existing] = await sql<PrincipalRow[]>`select ${sql.unsafe(COLS)} from principals where email = ${email} limit 1`;
  if (existing && !existing.accessExpiresAt) {
    return { error: `${email} already has standing access. Temporary access is for someone who has none.` };
  }
  const id = existing?.id ?? email;
  const [row] = await sql<PrincipalRow[]>`
    insert into principals (id, email, display_name, roles, enabled,
                            access_expires_at, access_reason, access_granted_by, access_granted_at)
    values (${id}, ${email}, ${input.displayName ?? ""}, ${sql.json(input.roles)}, true,
            ${input.until}, ${input.reason}, ${input.grantedBy}, now())
    on conflict (id) do update set
      display_name      = coalesce(nullif(excluded.display_name, ''), principals.display_name),
      roles             = excluded.roles,
      enabled           = true,
      access_expires_at = excluded.access_expires_at,
      access_reason     = excluded.access_reason,
      access_granted_by = excluded.access_granted_by,
      access_granted_at = excluded.access_granted_at,
      updated_at        = now()
    returning ${sql.unsafe(COLS)}`;
  return { row };
}

/** End someone's temporary access now. False when there was none running. */
export async function endTemporaryAccess(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update principals set access_expires_at = now(), updated_at = now()
     where id = ${id} and access_expires_at > now()`;
  return rows.count > 0;
}

export interface TemporaryAccessRow {
  id: string;
  email: string | null;
  displayName: string;
  roles: string[];
  reason: string | null;
  grantedBy: string | null;
  grantedAt: string | null;
  expiresAt: string;
  live: boolean;
  /** What they did with it, since the grant: runs started, confidential reads, audit entries. */
  runs: number;
  reads: number;
  events: number;
}

/**
 * Every grant running now, and those that ended in the last `days` — with
 * what each person did since it was granted, so the client reads it next to
 * the grant rather than searching the audit trail for it.
 */
export async function listTemporaryAccess(days = 30): Promise<TemporaryAccessRow[]> {
  const sql = getSql();
  return sql<TemporaryAccessRow[]>`
    select p.id, p.email, p.display_name as "displayName", p.roles,
           p.access_reason as reason, p.access_granted_by as "grantedBy",
           p.access_granted_at as "grantedAt", p.access_expires_at as "expiresAt",
           (p.access_expires_at > now() and p.enabled) as live,
           (select count(*)::int from agent_sessions s
             where s.principal_id = p.id and s.created_at >= coalesce(p.access_granted_at, p.created_at)) as runs,
           (select count(*)::int from knowledge_reads r
             where r.principal_id = p.id and r.at >= coalesce(p.access_granted_at, p.created_at)) as reads,
           (select count(*)::int from auth_events e
             where (e.principal_id = p.id or e.actor = p.id or e.actor = p.email)
               and e.at >= coalesce(p.access_granted_at, p.created_at)) as events
      from principals p
     where p.access_expires_at is not null
       and p.access_expires_at > now() - make_interval(days => ${Math.max(1, Math.trunc(days))}::int)
     order by p.access_expires_at desc`;
}
