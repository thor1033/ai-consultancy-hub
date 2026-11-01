import { getSql } from "./client";

/*
 * Proposals — a held tool call, waiting for a person (docs/approvals.md).
 *
 * The store is deliberately dumb: it records what was held and what was
 * decided. Which calls are held, and who may decide, is policy and lives in
 * apps/web/src/lib/approvals.ts, next to the code that executes them.
 */

export type ProposalStatus = "pending" | "approved" | "executed" | "failed" | "rejected";

export interface Proposal {
  id: string;
  agentId: string | null;
  runId: string | null;
  principalId: string | null;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  /** The agent's one line for the approver; null when it gave none. */
  reason: string | null;
  /** Sent on to this person to decide; null when it is with whoever the run acted as. */
  assignedTo: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  assignNote: string | null;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  /** Its arguments and result were removed by retention after the decision (docs/retention.md). */
  contentExpiredAt: string | null;
  /** Joined for display. */
  agentName: string | null;
  agentSlug: string | null;
  principalName: string | null;
  assignedToName: string | null;
  assignedByName: string | null;
  runPrompt: string | null;
  /** When the run that made it started — proposals are shown grouped by run. */
  runAt: string | null;
}

export interface ProposalInput {
  agentId?: string | null;
  runId?: string | null;
  principalId?: string | null;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  description?: string;
  reason?: string | null;
}

const COLUMNS = `
  p.id, p.agent_id as "agentId", p.run_id as "runId", p.principal_id as "principalId",
  p.server, p.tool, p.args, p.description, p.reason, p.status,
  p.decided_by as "decidedBy", p.decided_at as "decidedAt", p.note, p.result, p.error,
  p.created_at as "createdAt", p.content_expired_at as "contentExpiredAt",
  p.assigned_to as "assignedTo", p.assigned_by as "assignedBy",
  p.assigned_at as "assignedAt", p.assign_note as "assignNote",
  a.name as "agentName", a.slug as "agentSlug",
  pr.display_name as "principalName",
  pt.display_name as "assignedToName",
  pb.display_name as "assignedByName",
  s.prompt as "runPrompt",
  s.created_at as "runAt"
`;
const JOINS = `
  from proposals p
  left join agents a on a.id = p.agent_id
  left join principals pr on pr.id = p.principal_id
  left join principals pt on pt.id = p.assigned_to
  left join principals pb on pb.id = p.assigned_by
  left join agent_sessions s on s.id = p.run_id
`;

export async function createProposal(input: ProposalInput): Promise<Proposal> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into proposals (agent_id, run_id, principal_id, server, tool, args, description, reason)
    values (${input.agentId ?? null}, ${input.runId ?? null}, ${input.principalId ?? null},
            ${input.server}, ${input.tool},
            ${sql.json((input.args ?? {}) as Parameters<typeof sql.json>[0])},
            ${(input.description ?? "").slice(0, 2000)},
            ${input.reason?.trim().slice(0, 1000) || null})
    returning id
  `;
  return (await getProposal(row.id))!;
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const sql = getSql();
  const rows = await sql<Proposal[]>`select ${sql.unsafe(COLUMNS)} ${sql.unsafe(JOINS)} where p.id = ${id}`;
  return rows[0] ?? null;
}

export interface ProposalFilter {
  status?: ProposalStatus | ProposalStatus[];
  /** Only proposals whose run acted as this principal. */
  principalId?: string;
  /** Only proposals this principal may see without being an admin: the run acted as them, or it was sent to them. */
  visibleTo?: string;
  runId?: string;
  agentId?: string;
  limit?: number;
}

export async function listProposals(filter: ProposalFilter = {}): Promise<Proposal[]> {
  const sql = getSql();
  const statuses = filter.status === undefined ? null : Array.isArray(filter.status) ? filter.status : [filter.status];
  return sql<Proposal[]>`
    select ${sql.unsafe(COLUMNS)} ${sql.unsafe(JOINS)}
     where ${statuses ? sql`p.status = any(${statuses}::text[])` : sql`true`}
       and ${filter.principalId ? sql`p.principal_id = ${filter.principalId}` : sql`true`}
       and ${filter.visibleTo ? sql`(p.principal_id = ${filter.visibleTo} or p.assigned_to = ${filter.visibleTo})` : sql`true`}
       and ${filter.runId ? sql`p.run_id = ${filter.runId}` : sql`true`}
       and ${filter.agentId ? sql`p.agent_id = ${filter.agentId}` : sql`true`}
     order by p.created_at desc
     limit ${filter.limit ?? 50}
  `;
}

export async function pendingProposalCount(principalId?: string): Promise<number> {
  const sql = getSql();
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from proposals
     where status = 'pending'
       and ${principalId ? sql`principal_id = ${principalId}` : sql`true`}
  `;
  return row?.n ?? 0;
}

/**
 * What is waiting on one person: sent to them, plus their own runs' writes
 * that were not sent on to someone else. The count the rail shows.
 */
export async function waitingOnCount(principalId: string): Promise<number> {
  const sql = getSql();
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from proposals
     where status = 'pending'
       and (assigned_to = ${principalId} or (principal_id = ${principalId} and assigned_to is null))
  `;
  return row?.n ?? 0;
}

/**
 * Send a pending proposal to someone else to decide. Conditional on
 * `pending`, like every other transition: a proposal decided a second ago
 * cannot be sent on. Null `to` takes it back to whoever the run acted as.
 */
export async function assignProposal(
  id: string,
  to: string | null,
  by: string,
  note?: string | null,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update proposals
       set assigned_to = ${to}, assigned_by = ${to ? by : null},
           assigned_at = ${to ? sql`now()` : null},
           assign_note = ${to ? (note ?? "").trim().slice(0, 1000) || null : null}
     where id = ${id} and status = 'pending'
  `;
  return rows.count > 0;
}

/**
 * Take a pending proposal for execution. Conditional on `pending`, so two
 * people approving at the same second produce one execution, not two.
 */
export async function claimProposal(id: string, decidedBy: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update proposals set status = 'approved', decided_by = ${decidedBy}, decided_at = now()
     where id = ${id} and status = 'pending'
  `;
  return rows.count > 0;
}

export async function finishProposal(id: string, outcome: { result: string } | { error: string }): Promise<void> {
  const sql = getSql();
  if ("result" in outcome) {
    await sql`update proposals set status = 'executed', result = ${outcome.result.slice(0, 20000)} where id = ${id}`;
  } else {
    await sql`update proposals set status = 'failed', error = ${outcome.error.slice(0, 2000)} where id = ${id}`;
  }
}

export async function rejectProposal(id: string, decidedBy: string, note?: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update proposals set status = 'rejected', decided_by = ${decidedBy}, decided_at = now(),
                         note = ${(note ?? "").slice(0, 2000) || null}
     where id = ${id} and status = 'pending'
  `;
  return rows.count > 0;
}
