import { getSql } from "./client";

/*
 * Approvals — the gate.
 *
 * Every capability the hub has given an agent so far has been a reading one,
 * and that is not an accident of scope: an agent run is an autonomous tool
 * loop, so a tool that changes something outside the hub gets called with
 * nobody watching. The pattern used instead was to withhold the tool — the
 * secretary's PM-tool credential is read-scoped, so `pm_create_task` is absent
 * from its tool list rather than forbidden in prose, and servers/microsoft365
 * has no tool that sends.
 *
 * That is why nothing here can do damage today, and it is also why the
 * secretary cannot do a secretary's job. This is the other half: an action the
 * agent has fully specified, parked, until a named person decides on it.
 *
 * Three properties carry the weight:
 *
 *   The decision is a CLAIM.  Two people pressing Approve on the same Teams
 *   card is the normal case, not the edge one. `decideApproval` is a conditional
 *   UPDATE, exactly one caller wins, and the loser is told who got there first
 *   rather than silently sending twice.
 *
 *   The action is LITERAL.    `action` holds the resolved arguments, the same
 *   discipline as `call.args` in a change set: what the approver reads is what
 *   gets carried out, and nothing is re-derived afterwards.
 *
 *   A decision EXPIRES.       A reply approved four days late is a wrong reply.
 *   Enforced in the UPDATE rather than by a sweeper, so an unrun sweeper cannot
 *   make a stale action decidable.
 *
 * What a person decided and what then happened are separate columns on purpose:
 * an approved send that failed is not a rejection, and flattening the two would
 * lose the fact that someone said yes.
 */

/** The human decision. Not the delivery — see `carriedOutAt`. */
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  /** What kind of action this is. Today only `mail.send`. */
  kind: string;
  agentId: string | null;
  sessionId: string | null;
  /** The principal whose reach the proposing run had. */
  requestedBy: string;
  /** The one line a human decides on. */
  summary: string;
  /** The literal, resolved action to carry out if approved. */
  action: Record<string, unknown>;
  /** Where it came from and where the answer belongs, e.g. a Teams thread. */
  origin: Record<string, unknown> | null;
  state: ApprovalState;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
  /** When the approved action was actually performed. */
  carriedOutAt: string | null;
  result: Record<string, unknown> | null;
  /**
   * Why carrying it out failed, if it did.
   *
   * Deliberately not called `error`: `createApproval` returns `{ error }` when
   * it refuses its input, and a row carrying the same field name would make
   * `"error" in outcome` quietly true for every successful row.
   */
  failure: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalInput {
  kind: string;
  agentId?: string | null;
  sessionId?: string | null;
  requestedBy: string;
  summary: string;
  action: Record<string, unknown>;
  origin?: Record<string, unknown> | null;
  /** How long the decision stays open. Default `DEFAULT_APPROVAL_TTL_MINUTES`. */
  ttlMinutes?: number;
}

/**
 * How long a proposed action stays decidable.
 *
 * A working day, not a week. The failure this prevents is a real one: a draft
 * reply written on Monday, approved on Thursday by someone scrolling back
 * through a channel, answering a question that was settled on Tuesday.
 */
export const DEFAULT_APPROVAL_TTL_MINUTES = 24 * 60;

/** Why a decision did not land. The Teams card says something different for each. */
export type DecisionRefusal =
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "already-decided"; approval: Approval }
  | { ok: false; reason: "expired"; approval: Approval }
  | { ok: false; reason: "not-permitted" };

export type DecisionOutcome = { ok: true; approval: Approval } | DecisionRefusal;

const columnList = (p = "") => `
  ${p}id, ${p}kind, ${p}agent_id as "agentId", ${p}session_id as "sessionId",
  ${p}requested_by as "requestedBy", ${p}summary, ${p}action, ${p}origin,
  ${p}state, ${p}decided_by as "decidedBy", ${p}decided_at as "decidedAt",
  ${p}decision_note as "decisionNote", ${p}expires_at as "expiresAt",
  ${p}carried_out_at as "carriedOutAt", ${p}result, ${p}failure,
  ${p}created_at as "createdAt", ${p}updated_at as "updatedAt"
`;

const COLUMNS = columnList();

/** Refuses a request no one could act on, rather than storing a dead row. */
function validate(input: ApprovalInput): string | null {
  if (!input.kind?.trim()) return "An approval needs a kind.";
  if (!input.summary?.trim()) {
    return "An approval needs a summary — it is the line the person decides on.";
  }
  if (!input.requestedBy?.trim()) return "An approval needs the principal that requested it.";
  if (!input.action || typeof input.action !== "object" || Array.isArray(input.action)) {
    return "An approval needs an action object holding the literal arguments to carry out.";
  }
  if (Object.keys(input.action).length === 0) {
    return "The action is empty — there would be nothing to carry out.";
  }
  const ttl = input.ttlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES;
  if (!Number.isInteger(ttl) || ttl < 1) return "A time to live is a whole number of minutes, at least 1.";
  return null;
}

export async function createApproval(input: ApprovalInput): Promise<Approval | { error: string }> {
  const problem = validate(input);
  if (problem) return { error: problem };
  const sql = getSql();
  const ttl = input.ttlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES;
  const rows = await sql<Approval[]>`
    insert into approvals
      (kind, agent_id, session_id, requested_by, summary, action, origin, expires_at)
    values (${input.kind.trim()}, ${input.agentId ?? null}, ${input.sessionId ?? null},
            ${input.requestedBy}, ${input.summary.trim()},
            ${sql.json(input.action as Parameters<typeof sql.json>[0])},
            ${input.origin ? sql.json(input.origin as Parameters<typeof sql.json>[0]) : null},
            now() + ${`${ttl} minutes`}::interval)
    returning ${sql.unsafe(COLUMNS)}
  `;
  return rows[0];
}

export async function getApproval(id: string): Promise<Approval | null> {
  const sql = getSql();
  const rows = await sql<Approval[]>`
    select ${sql.unsafe(COLUMNS)} from approvals where id = ${id} limit 1
  `;
  return rows[0] ?? null;
}

export async function listApprovals(
  filter: { agentId?: string; state?: ApprovalState; limit?: number } = {},
): Promise<Approval[]> {
  const sql = getSql();
  return sql<Approval[]>`
    select ${sql.unsafe(COLUMNS)} from approvals
     where ${filter.agentId ? sql`agent_id = ${filter.agentId}` : sql`true`}
       and ${filter.state ? sql`state = ${filter.state}` : sql`true`}
     order by created_at desc
     limit ${Math.min(filter.limit ?? 50, 200)}
  `;
}

/**
 * Decide one approval.
 *
 * Every condition is in the one UPDATE, which is what makes this safe under
 * concurrency: two Approve presses arriving in the same second both run this,
 * and the second finds no `pending` row to update. The loser then reads the row
 * back to say who decided it and when, rather than reporting a generic failure
 * or — much worse — carrying the action out a second time.
 *
 * The decider must be an ENABLED principal. That check belongs here and not in
 * the caller: the caller will eventually be a Teams endpoint, where the set of
 * people who can press a button is "everyone in the channel" and not "everyone
 * the hub knows". Disabling a principal has to stop them approving for the same
 * reason it stops their schedules firing.
 */
export async function decideApproval(args: {
  id: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  note?: string;
}): Promise<DecisionOutcome> {
  const sql = getSql();
  const rows = await sql<Approval[]>`
    update approvals
       set state = ${args.decision},
           decided_by = ${args.decidedBy},
           decided_at = now(),
           decision_note = ${args.note ?? null},
           updated_at = now()
     where id = ${args.id}
       and state = 'pending'
       and expires_at > now()
       and exists (select 1 from principals p where p.id = ${args.decidedBy} and p.enabled)
    returning ${sql.unsafe(COLUMNS)}
  `;
  if (rows[0]) return { ok: true, approval: rows[0] };

  // Nothing updated. Read the row back to say which of the four reasons it was —
  // the Teams card needs to tell "someone beat you to it" apart from "this is
  // too old to send now".
  const existing = await getApproval(args.id);
  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.state !== "pending") return { ok: false, reason: "already-decided", approval: existing };
  if (new Date(existing.expiresAt) <= new Date()) return { ok: false, reason: "expired", approval: existing };
  return { ok: false, reason: "not-permitted" };
}

/**
 * Record what happened when an approved action was carried out.
 *
 * Deliberately does not touch `state`: the person still approved it. A send
 * that failed is an approved row with a `failure`, and the difference matters
 * when someone asks later why a mail never arrived.
 *
 * `result` should hold what the outside world actually did — for a send, the
 * recipients and subject as they stood at send time, which is how a draft
 * edited in Outlook after approval becomes visible rather than invisible.
 */
export async function recordApprovalOutcome(
  id: string,
  outcome: { result?: Record<string, unknown>; failure?: string },
): Promise<Approval | null> {
  const sql = getSql();
  const rows = await sql<Approval[]>`
    update approvals
       set carried_out_at = now(),
           result = ${outcome.result ? sql.json(outcome.result as Parameters<typeof sql.json>[0]) : null},
           failure = ${outcome.failure ?? null},
           updated_at = now()
     where id = ${id}
       and state = 'approved'
       and carried_out_at is null
    returning ${sql.unsafe(COLUMNS)}
  `;
  return rows[0] ?? null;
}

/**
 * Mark undecided rows past their expiry.
 *
 * Housekeeping, not enforcement — `decide` already refuses an expired row on
 * its own. This exists so a list of pending approvals does not fill with things
 * nobody can act on. Safe to call from any container; it is idempotent.
 */
export async function expireStaleApprovals(): Promise<number> {
  const sql = getSql();
  const rows = await sql`
    update approvals
       set state = 'expired', updated_at = now()
     where state = 'pending' and expires_at <= now()
  `;
  return rows.count;
}

/**
 * Record where an approval is being decided.
 *
 * Two steps rather than one because the card cannot exist before the row: the
 * card carries the approval's id, and the thread only learns the card's own
 * activity id once it has been posted. Stamping it afterwards is what lets the
 * decision replace that card in place instead of leaving live buttons on a row
 * that has already been settled.
 */
export async function attachApprovalOrigin(
  id: string,
  origin: Record<string, unknown>,
): Promise<Approval | null> {
  const sql = getSql();
  const rows = await sql<Approval[]>`
    update approvals
       set origin = ${sql.json(origin as Parameters<typeof sql.json>[0])}, updated_at = now()
     where id = ${id}
    returning ${sql.unsafe(COLUMNS)}
  `;
  return rows[0] ?? null;
}
