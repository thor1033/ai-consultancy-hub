import { getSql } from "./client";

// Identity, credentials and the audit trail (see schema.sql).
//
// Pure storage. The token format, the minting and the hashing live one layer up
// in @ai-hub/authz, which is the only thing that should know what a hub token
// looks like; this module never sees a plaintext secret — callers hand it a
// prefix and a hash.

export interface PrincipalRow {
  id: string;
  email: string | null;
  workosUserId: string | null;
  displayName: string;
  roles: string[];
  agentId: string | null;
  enabled: boolean;
  /** How the hub looks to this person (docs/views.md). Never a permission. */
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialRow {
  id: string;
  name: string;
  principalId: string;
  tokenPrefix: string;
  roles: string[];
  agentId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface AuthEventRow {
  id: string;
  at: string;
  event: string;
  source: string | null;
  principalId: string | null;
  credentialId: string | null;
  actor: string | null;
  detail: Record<string, unknown>;
}

const PRINCIPAL_COLS = `
  id, email,
  workos_user_id as "workosUserId",
  display_name   as "displayName",
  roles, agent_id as "agentId", enabled, preferences,
  created_at     as "createdAt",
  updated_at     as "updatedAt"
`;

// The secret columns are never selected. There is no code path that reads
// token_hash back out of the database — verification hashes the presented token
// and compares in SQL.
const CREDENTIAL_COLS = `
  id, name,
  principal_id as "principalId",
  token_prefix as "tokenPrefix",
  roles,
  agent_id     as "agentId",
  created_by   as "createdBy",
  created_at   as "createdAt",
  expires_at   as "expiresAt",
  last_used_at as "lastUsedAt",
  revoked_at   as "revokedAt",
  revoked_by   as "revokedBy"
`;

// The same list qualified for the join in verifyCredential, where `principals`
// brings its own id/roles/created_at into scope.
const CREDENTIAL_COLS_C = `
  c.id, c.name,
  c.principal_id as "principalId",
  c.token_prefix as "tokenPrefix",
  c.roles,
  c.agent_id     as "agentId",
  c.created_by   as "createdBy",
  c.created_at   as "createdAt",
  c.expires_at   as "expiresAt",
  c.last_used_at as "lastUsedAt",
  c.revoked_at   as "revokedAt",
  c.revoked_by   as "revokedBy"
`;

// --- principals ------------------------------------------------------------

export async function listPrincipals(): Promise<PrincipalRow[]> {
  const sql = getSql();
  return sql<PrincipalRow[]>`
    select ${sql.unsafe(PRINCIPAL_COLS)} from principals order by id
  `;
}

/**
 * The people a proposal can be sent to: enabled, signed in with an email (so a
 * person, not a service credential), and not bound to an agent. Whether their
 * role may decide is policy, checked by the caller.
 */
export async function listPeople(): Promise<PrincipalRow[]> {
  const sql = getSql();
  return sql<PrincipalRow[]>`
    select ${sql.unsafe(PRINCIPAL_COLS)} from principals
     where enabled and email is not null and agent_id is null
     order by coalesce(nullif(display_name, ''), email)
  `;
}

export async function getPrincipal(id: string): Promise<PrincipalRow | null> {
  const sql = getSql();
  const rows = await sql<PrincipalRow[]>`
    select ${sql.unsafe(PRINCIPAL_COLS)} from principals where id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * Find the person behind an OAuth access token.
 *
 * Matched on the WorkOS user id first, falling back to email. The fallback is
 * what makes a principal issuable *before* its owner has ever signed in: an
 * admin creates the row with an email, and the first token that arrives binds
 * the WorkOS user id to it permanently (see `bindWorkosUser`). Without that,
 * granting access would mean asking the person to sign in first so we could
 * copy their id out of a log.
 */
export async function findPrincipalByIdentity(identity: {
  workosUserId?: string | null;
  email?: string | null;
}): Promise<PrincipalRow | null> {
  const sql = getSql();
  const email = identity.email?.trim().toLowerCase() || null;
  const workosUserId = identity.workosUserId?.trim() || null;
  if (!email && !workosUserId) return null;

  const rows = await sql<PrincipalRow[]>`
    select ${sql.unsafe(PRINCIPAL_COLS)} from principals
    where (${workosUserId}::text is not null and workos_user_id = ${workosUserId})
       or (${email}::text is not null and email = ${email})
    -- A row already bound to this WorkOS user wins over one matched by email
    -- alone, so a rebound address can never outrank the established binding.
    order by (workos_user_id is not distinct from ${workosUserId}) desc
    limit 1
  `;
  return rows[0] ?? null;
}

/** Bind a WorkOS user id to a principal that was matched by email. No-op if taken. */
export async function bindWorkosUser(id: string, workosUserId: string): Promise<void> {
  const sql = getSql();
  await sql`
    update principals
       set workos_user_id = ${workosUserId}, updated_at = now()
     where id = ${id}
       and workos_user_id is null
       and not exists (
         select 1 from principals where workos_user_id = ${workosUserId}
       )
  `;
}

export interface PrincipalInput {
  id: string;
  email?: string | null;
  displayName?: string;
  roles?: string[];
  agentId?: string | null;
  enabled?: boolean;
}

export async function upsertPrincipal(input: PrincipalInput): Promise<PrincipalRow> {
  const sql = getSql();
  const email = input.email?.trim().toLowerCase() || null;
  const rows = await sql<PrincipalRow[]>`
    insert into principals (id, email, display_name, roles, agent_id, enabled)
    values (
      ${input.id},
      ${email},
      ${input.displayName ?? ""},
      ${sql.json(input.roles ?? [])},
      ${input.agentId ?? null},
      ${input.enabled ?? true}
    )
    on conflict (id) do update set
      email        = excluded.email,
      display_name = excluded.display_name,
      roles        = excluded.roles,
      agent_id     = excluded.agent_id,
      enabled      = excluded.enabled,
      updated_at   = now()
    returning ${sql.unsafe(PRINCIPAL_COLS)}
  `;
  return rows[0];
}

export async function setPrincipalEnabled(id: string, enabled: boolean): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update principals set enabled = ${enabled}, updated_at = now() where id = ${id}
  `;
  return rows.count > 0;
}

/**
 * Set one of a person's own preferences, or clear it with null. Merged into
 * the row's preferences, so setting the view leaves anything else there.
 * Returns false when there is no such row (a person admitted by the email
 * allowlist alone has none; their choice lives in the browser's cookie).
 */
export async function setPrincipalPreference(id: string, key: string, value: unknown): Promise<boolean> {
  const sql = getSql();
  const rows =
    value === null || value === undefined
      ? await sql`update principals set preferences = preferences - ${key}, updated_at = now() where id = ${id}`
      : await sql`update principals set preferences = preferences || ${sql.json({ [key]: value } as never)}, updated_at = now() where id = ${id}`;
  return rows.count > 0;
}

// --- credentials -----------------------------------------------------------

export interface IssueCredentialInput {
  name: string;
  principalId: string;
  tokenPrefix: string;
  tokenHash: string;
  roles?: string[];
  agentId?: string | null;
  createdBy?: string;
  expiresAt?: Date | null;
}

export async function issueCredential(
  input: IssueCredentialInput,
): Promise<CredentialRow> {
  const sql = getSql();
  const rows = await sql<CredentialRow[]>`
    insert into api_credentials
      (name, principal_id, token_prefix, token_hash, roles, agent_id, created_by, expires_at)
    values (
      ${input.name},
      ${input.principalId},
      ${input.tokenPrefix},
      ${input.tokenHash},
      ${sql.json(input.roles ?? [])},
      ${input.agentId ?? null},
      ${input.createdBy ?? ""},
      ${input.expiresAt ?? null}
    )
    returning ${sql.unsafe(CREDENTIAL_COLS)}
  `;
  return rows[0];
}

export interface VerifiedCredential {
  credential: CredentialRow;
  principal: PrincipalRow;
}

/**
 * Look up a live credential by prefix and hash, together with its owner.
 *
 * The hash comparison happens in SQL rather than in JS so the hash never leaves
 * the database, and the whole thing is one round trip on the hot path. Expiry,
 * revocation and a disabled owner are all part of the predicate: there is no
 * shape of this query that returns a credential someone has switched off.
 */
export async function verifyCredential(
  tokenPrefix: string,
  tokenHash: string,
): Promise<VerifiedCredential | null> {
  const sql = getSql();
  const rows = await sql<(CredentialRow & { p: PrincipalRow })[]>`
    select ${sql.unsafe(CREDENTIAL_COLS_C)},
           to_jsonb(p) as p
      from api_credentials c
      join principals p on p.id = c.principal_id
     where c.token_prefix = ${tokenPrefix}
       and c.token_hash   = ${tokenHash}
       and c.revoked_at is null
       and (c.expires_at is null or c.expires_at > now())
       and p.enabled
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const raw = row.p as unknown as Record<string, unknown>;
  const { p: _p, ...credential } = row;
  return {
    credential: credential as CredentialRow,
    principal: {
      id: String(raw.id),
      email: (raw.email as string | null) ?? null,
      workosUserId: (raw.workos_user_id as string | null) ?? null,
      displayName: (raw.display_name as string) ?? "",
      roles: Array.isArray(raw.roles) ? (raw.roles as string[]) : [],
      agentId: (raw.agent_id as string | null) ?? null,
      enabled: Boolean(raw.enabled),
      preferences: raw.preferences && typeof raw.preferences === "object" ? (raw.preferences as Record<string, unknown>) : {},
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at),
    },
  };
}

/**
 * Record that a credential was just used.
 *
 * Coarse on purpose: the write is skipped unless the stored timestamp is over a
 * minute old. /api/mcp authenticates on every JSON-RPC call, and "last used" to
 * the minute is what an operator reads — paying for a row update per call to
 * sharpen that to the millisecond would be the wrong trade.
 */
export async function touchCredential(id: string): Promise<void> {
  const sql = getSql();
  await sql`
    update api_credentials
       set last_used_at = now()
     where id = ${id}
       and (last_used_at is null or last_used_at < now() - interval '1 minute')
  `;
}

export async function listCredentials(
  opts: { includeRevoked?: boolean } = {},
): Promise<CredentialRow[]> {
  const sql = getSql();
  return sql<CredentialRow[]>`
    select ${sql.unsafe(CREDENTIAL_COLS)} from api_credentials
    where ${opts.includeRevoked ? sql`true` : sql`revoked_at is null`}
    order by created_at desc
  `;
}

export async function revokeCredential(id: string, by: string): Promise<CredentialRow | null> {
  const sql = getSql();
  const rows = await sql<CredentialRow[]>`
    update api_credentials
       set revoked_at = now(), revoked_by = ${by}
     where id = ${id} and revoked_at is null
    returning ${sql.unsafe(CREDENTIAL_COLS)}
  `;
  return rows[0] ?? null;
}

// --- audit -----------------------------------------------------------------

export interface AuthEventInput {
  event: string;
  source?: string | null;
  principalId?: string | null;
  credentialId?: string | null;
  actor?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Append to the audit trail.
 *
 * Never throws. An audit write failing must not turn into a 500 on a request
 * that was otherwise fine — losing one log line is a smaller problem than an
 * outage, and the failure still shows up in the container logs.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      insert into auth_events (event, source, principal_id, credential_id, actor, detail)
      values (
        ${input.event},
        ${input.source ?? null},
        ${input.principalId ?? null},
        ${input.credentialId ?? null},
        ${input.actor ?? null},
        ${sql.json((input.detail ?? {}) as Parameters<typeof sql.json>[0])}
      )
    `;
  } catch (err) {
    console.error("auth_events insert failed:", err);
  }
}

export async function listAuthEvents(limit = 50): Promise<AuthEventRow[]> {
  const sql = getSql();
  return sql<AuthEventRow[]>`
    select id, at, event, source,
           principal_id  as "principalId",
           credential_id as "credentialId",
           actor, detail
      from auth_events
     order by at desc
     limit ${limit}
  `;
}
