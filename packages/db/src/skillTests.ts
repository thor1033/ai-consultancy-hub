import { createHash } from "node:crypto";
import { getSql } from "./client";
import { cleanChecks, type CheckResult, type SkillCheck } from "./checks";
import type { TrialVariant, TrialRun, TrialResult, TrialSummary, TrialSet } from "./trialScore";

export { trialPassed, scoreTrials, summarizeTrials } from "./trialScore";
export type { TrialVariant, TrialRun, TrialResult, TrialSummary, TrialSet, VariantSummary } from "./trialScore";

/*
 * Test cases on a skill, and trial sets that run them (docs/skill-tests.md,
 * docs/effective-agents-review.md E1).
 *
 * A CASE is what a skill was asked (its arguments, or the exact prompt of a
 * run that went wrong) and what a good answer passes: the case's own checks,
 * on top of the skill's. Cases are the skill's, not a person's.
 *
 * A TRIAL SET is one comparison: every case, k times, under each VARIANT of
 * the setup — the skill's agent as it is, or with another model, effort or
 * brief, or another agent altogether given the same prompt. Each trial is a
 * real run as the person who started the set, recorded on agent_sessions
 * with trial_id, so its transcript is on its run page like any other. The
 * set keeps a hash of the setup it ran against, so a later set after a brief
 * change reads "was 9 of 10, now 7 of 10".
 *
 * Scoring is outcome over path: a trial passes when every check passed. A
 * check that could not be judged is not a pass. Per case and variant: the
 * pass rate over k, and whether all k passed — the evals post's pass^k, the
 * figure that says a setup is reliable rather than lucky.
 */

export interface SkillCase {
  id: string;
  skillId: string;
  name: string;
  /** The skill's arguments, filled into its template. */
  args: Record<string, unknown>;
  /** Or the exact prompt, when the case was saved from a run. Wins over args. */
  prompt: string | null;
  /** On top of the skill's own checks. */
  checks: SkillCheck[];
  /** What a good answer looked like, for a person reading a failure. */
  reference: string | null;
  fromRunId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCaseInput {
  skillId: string;
  name: string;
  args?: Record<string, unknown>;
  prompt?: string | null;
  checks?: SkillCheck[];
  reference?: string | null;
  fromRunId?: string | null;
  createdBy?: string | null;
}

const CASE_COLUMNS = `
  id, skill_id as "skillId", name, args, prompt, checks, reference,
  from_run_id as "fromRunId", created_by as "createdBy",
  created_at as "createdAt", updated_at as "updatedAt"`;

export async function listCases(skillId: string): Promise<SkillCase[]> {
  const sql = getSql();
  return sql.unsafe<SkillCase[]>(`select ${CASE_COLUMNS} from skill_cases where skill_id = $1 order by created_at`, [skillId]);
}

export async function getCase(id: string): Promise<SkillCase | null> {
  const sql = getSql();
  const [row] = await sql.unsafe<SkillCase[]>(`select ${CASE_COLUMNS} from skill_cases where id = $1`, [id]);
  return row ?? null;
}

export async function createCase(input: SkillCaseInput): Promise<SkillCase> {
  const sql = getSql();
  const [row] = await sql<SkillCase[]>`
    insert into skill_cases (skill_id, name, args, prompt, checks, reference, from_run_id, created_by)
    values (${input.skillId}, ${input.name.trim()}, ${sql.json((input.args ?? {}) as never)}, ${input.prompt?.trim() || null},
            ${sql.json(cleanChecks(input.checks ?? []) as never)}, ${input.reference?.trim() || null}, ${input.fromRunId ?? null}, ${input.createdBy ?? null})
    returning ${sql.unsafe(CASE_COLUMNS)}
  `;
  return row;
}

export async function updateCase(id: string, patch: Partial<Omit<SkillCaseInput, "skillId" | "fromRunId" | "createdBy">>): Promise<SkillCase | null> {
  const sql = getSql();
  const [row] = await sql<SkillCase[]>`
    update skill_cases set
      name       = coalesce(${patch.name?.trim() ?? null}, name),
      args       = coalesce(${patch.args === undefined ? null : sql.json(patch.args as never)}, args),
      prompt     = ${patch.prompt === undefined ? sql`prompt` : patch.prompt?.trim() || null},
      checks     = coalesce(${patch.checks === undefined ? null : sql.json(cleanChecks(patch.checks) as never)}, checks),
      reference  = ${patch.reference === undefined ? sql`reference` : patch.reference?.trim() || null},
      updated_at = now()
    where id = ${id}
    returning ${sql.unsafe(CASE_COLUMNS)}
  `;
  return row ?? null;
}

export async function deleteCase(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from skill_cases where id = ${id}`;
  return rows.count > 0;
}

/**
 * What a trial set ran against, in one hash: the agent's brief, model and
 * effort, the skill's template and checks. Two sets with the same hash are
 * comparable; a different one says the setup changed in between.
 */
export function setupHash(parts: { instructions?: string | null; model?: string | null; effort?: string | null; promptTemplate: string; checks: SkillCheck[] }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.instructions ?? "", parts.model ?? "", parts.effort ?? "", parts.promptTemplate, cleanChecks(parts.checks)]))
    .digest("hex")
    .slice(0, 12);
}

const SET_COLUMNS = `
  id, skill_id as "skillId", label, principal_id as "principalId", variants, k,
  setup_hash as "setupHash", status, error, results, summary,
  started_at as "startedAt", finished_at as "finishedAt"`;

export async function createTrialSet(input: { skillId: string; label: string; principalId: string | null; variants: TrialVariant[]; k: number; setupHash: string }): Promise<TrialSet> {
  const sql = getSql();
  const [row] = await sql<TrialSet[]>`
    insert into skill_trials (skill_id, label, principal_id, variants, k, setup_hash)
    values (${input.skillId}, ${input.label.trim()}, ${input.principalId}, ${sql.json(input.variants as never)}, ${input.k}, ${input.setupHash})
    returning ${sql.unsafe(SET_COLUMNS)}
  `;
  return row;
}

export async function finishTrialSet(id: string, results: TrialResult[], summary: TrialSummary): Promise<void> {
  const sql = getSql();
  await sql`update skill_trials set status = 'done', results = ${sql.json(results as never)}, summary = ${sql.json(summary as never)}, finished_at = now() where id = ${id}`;
}

/** Progress while running: the results so far, so the page can show them. */
export async function progressTrialSet(id: string, results: TrialResult[]): Promise<void> {
  const sql = getSql();
  await sql`update skill_trials set results = ${sql.json(results as never)} where id = ${id}`;
}

export async function failTrialSet(id: string, error: string, results?: TrialResult[]): Promise<void> {
  const sql = getSql();
  await sql`update skill_trials set status = 'failed', error = ${error.slice(0, 2000)}, results = coalesce(${results ? sql.json(results as never) : null}, results), finished_at = now() where id = ${id}`;
}

export async function getTrialSet(id: string): Promise<TrialSet | null> {
  const sql = getSql();
  const [row] = await sql.unsafe<TrialSet[]>(`select ${SET_COLUMNS} from skill_trials where id = $1`, [id]);
  return row ?? null;
}

export async function listTrialSets(skillId: string, limit = 20): Promise<TrialSet[]> {
  const sql = getSql();
  return sql.unsafe<TrialSet[]>(`select ${SET_COLUMNS} from skill_trials where skill_id = $1 order by started_at desc limit $2`, [skillId, Math.max(1, Math.min(limit, 100))]);
}

/** What one trial's run came to, read back from its row. */
export async function trialRunFacts(runId: string): Promise<Omit<TrialRun, "passed"> | null> {
  const sql = getSql();
  const [row] = await sql<{ status: string; checks: CheckResult[] | null; latencyMs: number | null; costUsd: number | null; output: string | null; error: string | null }[]>`
    select status, checks, latency_ms as "latencyMs", cost_usd::float8 as "costUsd", output, error from agent_sessions where id = ${runId}`;
  if (!row) return null;
  const words = row.output ? (row.output.trim() ? row.output.trim().split(/\s+/).length : 0) : null;
  return { runId, status: row.status, checks: row.checks, latencyMs: row.latencyMs, costUsd: row.costUsd, words, error: row.error };
}
