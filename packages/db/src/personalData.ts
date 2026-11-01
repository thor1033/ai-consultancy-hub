import { getSql } from "./client";
import { recordAuthEvent } from "./credentials";

/*
 * What the hub keeps about people, for how long, and a person's rights over it
 * (docs/retention.md, docs/data-protection-review.md 2.2 and 2.7).
 *
 * RETENTION keeps the outcome and drops the evidence:
 *
 *   a run's transcript      every message and tool result     HUB_RETAIN_TRANSCRIPTS_DAYS, 7
 *   a run's question,       what was asked and answered,      HUB_RETAIN_ANSWERS_DAYS, 90
 *     answer and error      and how it failed
 *   a decided proposal's    what an agent wanted to write     the same 90, from the decision
 *     arguments and result
 *   the audit trail         sign-in failures, changes         HUB_RETAIN_AUDIT_DAYS, 365
 *
 * What stays is content-free: which agent, which tools, which collections,
 * cost, tokens, timings, status — the numbers the ROI report needs. Running
 * runs and pending proposals are never touched. Every sweep is idempotent and
 * stamps what it cleared, so a page can say "removed after 90 days".
 *
 * RIGHTS: a person's export (everything the hub holds about them as a user),
 * an admin's erasure, and an admin's search for a name across everything the
 * hub stores — for a request about someone who is not a user at all.
 */

export interface RetentionPolicy {
  /** Days a run's full transcript is kept. */
  transcriptsDays: number;
  /** Days a run's question, answer and error — and a decided proposal's details — are kept. */
  answersDays: number;
  /** Days the audit trail is kept. */
  auditDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { transcriptsDays: 7, answersDays: 90, auditDays: 365 };

/**
 * The deployment's policy. A value that is not a whole number of days from 0
 * to 3650 falls back to the default — a typo must not become "keep forever"
 * or "delete everything now". The transcript window never exceeds the
 * answers': a transcript holds the answer.
 */
export function retentionPolicy(env: Record<string, string | undefined> = process.env): RetentionPolicy {
  const days = (raw: string | undefined, fallback: number) => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : fallback;
  };
  const answersDays = days(env.HUB_RETAIN_ANSWERS_DAYS, DEFAULT_RETENTION.answersDays);
  return {
    answersDays,
    transcriptsDays: Math.min(days(env.HUB_RETAIN_TRANSCRIPTS_DAYS, DEFAULT_RETENTION.transcriptsDays), answersDays),
    auditDays: days(env.HUB_RETAIN_AUDIT_DAYS, DEFAULT_RETENTION.auditDays),
  };
}

export interface RetentionSweep {
  transcriptsDropped: number;
  answersExpired: number;
  proposalsExpired: number;
  auditDeleted: number;
  /** Read-log entries (docs/sensitivity.md) older than the audit period. */
  readsDeleted: number;
}

/** One pass of the policy. Idempotent: what was cleared is stamped and skipped next time. */
export async function sweepRetention(policy: RetentionPolicy = retentionPolicy()): Promise<RetentionSweep> {
  const sql = getSql();
  const age = (days: number) => sql`make_interval(days => ${days}::int)`;
  const when = sql`coalesce(finished_at, started_at, created_at)`;

  const answers = await sql`
    update agent_sessions
       set prompt = '', output = null, error = null, transcript = '[]'::jsonb,
           content_expired_at = now(), transcript_dropped_at = coalesce(transcript_dropped_at, now())
     where content_expired_at is null and status <> 'running'
       and ${when} < now() - ${age(policy.answersDays)}`;
  const transcripts = await sql`
    update agent_sessions
       set transcript = '[]'::jsonb, transcript_dropped_at = now()
     where transcript_dropped_at is null and status <> 'running'
       and ${when} < now() - ${age(policy.transcriptsDays)}`;
  const proposals = await sql`
    update proposals
       set args = '{}'::jsonb, result = null, reason = null, note = null, assign_note = null,
           content_expired_at = now()
     where content_expired_at is null and status in ('executed', 'failed', 'rejected')
       and coalesce(decided_at, created_at) < now() - ${age(policy.answersDays)}`;
  // Erasures are the record that a person's request was carried out; they are
  // kept, and they hold no content.
  const audit = await sql`
    delete from auth_events
     where at < now() - ${age(policy.auditDays)} and event <> 'data.erased'`;
  // The read log is part of the audit trail, and goes with it.
  const reads = await sql`delete from knowledge_reads where at < now() - ${age(policy.auditDays)}`;

  return {
    transcriptsDropped: transcripts.count,
    answersExpired: answers.count,
    proposalsExpired: proposals.count,
    auditDeleted: audit.count,
    readsDeleted: reads.count,
  };
}

/** When the last sweep ran (recorded as an audit event), for the page and for pacing the scheduler. */
export async function lastRetentionSweep(): Promise<{ at: string; detail: Record<string, unknown> } | null> {
  const sql = getSql();
  const [row] = await sql<{ at: string; detail: Record<string, unknown> }[]>`
    select at, detail from auth_events where event = 'retention.sweep' order by at desc limit 1`;
  return row ?? null;
}

/** Sweep and record it. `actor` is the admin who asked, or "scheduler". */
export async function sweepRetentionAndRecord(actor: string, policy: RetentionPolicy = retentionPolicy()): Promise<RetentionSweep> {
  const out = await sweepRetention(policy);
  await recordAuthEvent({ event: "retention.sweep", source: "hub", actor, detail: { ...out, policy } });
  return out;
}

// ── a person's data ──────────────────────────────────────────────────────────

export interface PersonExport {
  exportedAt: string;
  retention: RetentionPolicy;
  person: { id: string; email: string | null; displayName: string; roles: string[]; enabled: boolean; createdAt: string; preferences: unknown } | null;
  runs: { id: string; at: string; agent: string | null; skill: string | null; status: string; question: string; answer: string | null; removedAfterRetention: boolean }[];
  proposals: { id: string; at: string; agent: string | null; server: string; tool: string; status: string; reason: string | null; args: unknown; result: string | null }[];
  memories: { agent: string | null; key: string; content: string; keptFor: string; writtenByYou: boolean; updatedAt: string }[];
  schedules: { name: string; agent: string | null; prompt: string; kind: string; enabled: boolean }[];
  decks: { title: string; slides: unknown; updatedAt: string }[];
  collectionsGranted: string[];
  credentials: { name: string; prefix: string; createdAt: string; revokedAt: string | null }[];
  auditTrail: { at: string; event: string; detail: unknown }[];
  /** Their reads of confidential and special collections (docs/sensitivity.md). */
  readLog: { at: string; door: string; collection: string; document: string | null }[];
}

/** Everything the hub holds about a person as a user of it. Content as stored now: what retention removed is gone. */
export async function exportPerson(principalId: string): Promise<PersonExport> {
  const sql = getSql();
  const [person] = await sql<NonNullable<PersonExport["person"]>[]>`
    select id, email, display_name as "displayName", roles, enabled, created_at as "createdAt", preferences
      from principals where id = ${principalId}`;
  const [runs, proposals, memories, schedules, decks, grants, credentials, audit, reads] = await Promise.all([
    sql<PersonExport["runs"]>`
      select s.id, coalesce(s.started_at, s.created_at) as at, a.name as agent, k.name as skill, s.status,
             s.prompt as question, s.output as answer, (s.content_expired_at is not null) as "removedAfterRetention"
        from agent_sessions s
        left join agents a on a.id = s.agent_id
        left join agent_skills k on k.id = s.agent_skill_id
       where s.principal_id = ${principalId}
       order by at desc`,
    sql<PersonExport["proposals"]>`
      select p.id, p.created_at as at, a.name as agent, p.server, p.tool, p.status, p.reason, p.args, p.result
        from proposals p left join agents a on a.id = p.agent_id
       where p.principal_id = ${principalId}
       order by p.created_at desc`,
    sql<PersonExport["memories"]>`
      select a.name as agent, m.key, m.content,
             case m.scope when 'agent' then 'everyone who uses the agent'
                          when 'collection' then 'readers of ' || m.scope_ref
                          else 'only you' end as "keptFor",
             (m.written_by = ${principalId}) as "writtenByYou", m.updated_at as "updatedAt"
        from agent_memories m left join agents a on a.id = m.agent_id
       where (m.scope = 'personal' and m.scope_ref = ${principalId}) or m.written_by = ${principalId}
       order by m.updated_at desc`,
    sql<PersonExport["schedules"]>`
      select s.name, a.name as agent, s.prompt, s.kind, s.enabled
        from agent_schedules s left join agents a on a.id = s.agent_id
       where s.owner_principal_id = ${principalId}`,
    sql<PersonExport["decks"]>`
      select title, slides, updated_at as "updatedAt" from decks where owner_principal_id = ${principalId}`,
    sql<{ collection: string }[]>`select collection from collection_grants where principal_id = ${principalId}`,
    sql<PersonExport["credentials"]>`
      select name, token_prefix as prefix, created_at as "createdAt", revoked_at as "revokedAt"
        from api_credentials where principal_id = ${principalId}`,
    sql<PersonExport["auditTrail"]>`
      select at, event, detail from auth_events where principal_id = ${principalId} order by at desc`,
    sql<PersonExport["readLog"]>`
      select r.at, r.door, r.collection, d.title as document
        from knowledge_reads r left join documents d on d.id = r.document_id
       where r.principal_id = ${principalId} order by r.at desc`,
  ]);
  return {
    exportedAt: new Date().toISOString(),
    retention: retentionPolicy(),
    person: person ?? null,
    runs,
    proposals,
    memories,
    schedules,
    decks,
    collectionsGranted: grants.map((g) => g.collection),
    credentials,
    auditTrail: audit,
    readLog: reads,
  };
}

export interface Erasure {
  runs: number;
  memories: number;
  memoriesUnattributed: number;
  localCalls: number;
  auditEvents: number;
  reads: number;
  principal: boolean;
}

/**
 * Erase a person: their runs (question, answer, transcript), their personal
 * memories, their row — and with it, by the schema's own cascades, their
 * credentials, collection grants, schedules and proposals. Decks they owned
 * stay with the organisation, unowned. Shared memories they caused keep their
 * content (it is the organisation's knowledge now) but lose the link to them.
 *
 * What it does not do: find their name inside other people's questions,
 * answers or documents. That is findSubject's job, for a person to read and
 * decide on. Detection (docs/sensitivity.md) masks CPR, card and account
 * numbers at rest; it does not, and should not, guess at names.
 *
 * One transaction: a half-erased person is worse than either end state. The
 * erasure itself is recorded (event data.erased, no content), and that record
 * is kept by retention: it is the proof the request was carried out.
 */
export async function erasePerson(principalId: string, actor: string): Promise<Erasure> {
  const sql = getSql();
  const out = await sql.begin(async (tx) => {
    const runs = await tx`delete from agent_sessions where principal_id = ${principalId}`;
    const memories = await tx`delete from agent_memories where scope = 'personal' and scope_ref = ${principalId}`;
    const unattributed = await tx`update agent_memories set written_by = null where written_by = ${principalId}`;
    const localCalls = await tx`delete from agent_local_calls where principal_id = ${principalId}`;
    const audit = await tx`delete from auth_events where principal_id = ${principalId}`;
    const reads = await tx`delete from knowledge_reads where principal_id = ${principalId}`;
    const principal = await tx`delete from principals where id = ${principalId}`;
    return {
      runs: runs.count,
      memories: memories.count,
      memoriesUnattributed: unattributed.count,
      localCalls: localCalls.count,
      auditEvents: audit.count,
      reads: reads.count,
      principal: principal.count > 0,
    };
  });
  await recordAuthEvent({ event: "data.erased", source: "hub", actor, detail: { subject: principalId, ...out } });
  return out;
}

export interface SubjectHits {
  term: string;
  runs: { id: string; at: string; agent: string | null; principalId: string | null; where: "question" | "answer" | "transcript" }[];
  memories: { id: string; agent: string | null; key: string; keptFor: string }[];
  documents: { id: string; title: string; collection: string | null }[];
  proposals: { id: string; at: string; tool: string; status: string }[];
  decks: { id: string; title: string }[];
  people: { id: string; email: string | null; displayName: string }[];
}

/**
 * Everything the hub stores that mentions a name or an email — so an admin can
 * answer "what do you hold about this person" for someone who never used the
 * hub (a client's employee named in a meeting, say), and decide what to
 * remove. Case-insensitive substring; at most 50 of each kind. Admin-only at
 * the caller, and recorded there, because the search itself reveals.
 */
export async function findSubject(term: string): Promise<SubjectHits> {
  const t = term.trim();
  if (t.length < 3) return { term: t, runs: [], memories: [], documents: [], proposals: [], decks: [], people: [] };
  const sql = getSql();
  const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [runs, memories, documents, proposals, decks, people] = await Promise.all([
    sql<SubjectHits["runs"]>`
      select s.id, coalesce(s.started_at, s.created_at) as at, a.name as agent, s.principal_id as "principalId",
             case when s.prompt ilike ${like} then 'question' when s.output ilike ${like} then 'answer' else 'transcript' end as "where"
        from agent_sessions s left join agents a on a.id = s.agent_id
       where s.prompt ilike ${like} or s.output ilike ${like} or s.transcript::text ilike ${like}
       order by at desc limit 50`,
    sql<SubjectHits["memories"]>`
      select m.id, a.name as agent, m.key,
             case m.scope when 'agent' then 'shared' when 'collection' then 'readers of ' || m.scope_ref else 'one person' end as "keptFor"
        from agent_memories m left join agents a on a.id = m.agent_id
       where m.key ilike ${like} or m.content ilike ${like}
       limit 50`,
    sql<SubjectHits["documents"]>`
      select distinct d.id, d.title, d.collection
        from documents d left join document_chunks c on c.document_id = d.id
       where d.title ilike ${like} or c.content ilike ${like}
       limit 50`,
    sql<SubjectHits["proposals"]>`
      select id, created_at as at, tool, status from proposals
       where args::text ilike ${like} or coalesce(result, '') ilike ${like} or coalesce(reason, '') ilike ${like}
       order by created_at desc limit 50`,
    sql<SubjectHits["decks"]>`
      select id, title from decks where title ilike ${like} or slides::text ilike ${like} limit 50`,
    sql<SubjectHits["people"]>`
      select id, email, display_name as "displayName" from principals
       where id ilike ${like} or coalesce(email, '') ilike ${like} or display_name ilike ${like} limit 50`,
  ]);
  return { term: t, runs, memories, documents, proposals, decks, people };
}
