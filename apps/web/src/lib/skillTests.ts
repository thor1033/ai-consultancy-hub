import {
  getSkill,
  getAgent,
  listCases,
  createTrialSet,
  finishTrialSet,
  failTrialSet,
  progressTrialSet,
  setupHash,
  trialRunFacts,
  trialPassed,
  scoreTrials,
  checkProblem,
  cleanChecks,
  type SkillCase,
  type TrialVariant,
  type TrialResult,
  type TrialRun,
  type TrialSet,
  type SkillWithAgent,
} from "@ai-hub/db";
import type { Principal } from "@ai-hub/authz";
import { runSkillForPrincipal } from "@/lib/agentRuns";
import { MODELS } from "@/app/agents/models";

/*
 * Running a skill's test cases, k times each, under one or more setups
 * (docs/skill-tests.md). This is what finds the best setup for a job: the
 * same cases, the same checks, a different model or brief or agent, and a
 * table that says which passed every time and what each cost.
 *
 * What is bounded, and why:
 *
 *   spend ......... every trial is a real run of the real model. A set says
 *                   how many runs it will make before it makes one, and
 *                   refuses more than MAX_TRIAL_RUNS (HUB_TRIAL_MAX_RUNS)
 *                   outright: a typo in k must not cost a month's budget.
 *   who ........... the person who starts the set, as for any run. A trial
 *                   retrieves and reaches tools as them, and its page is
 *                   theirs. Starting one needs agent:manage: it spends.
 *   what it leaves  nothing. Every write a trial proposes is held and then
 *                   rejected, memory writes are refused, hand-offs do not
 *                   fire (lib/agentRuns.ts, lib/approvals.ts). The run rows
 *                   stay, marked with the set, and are left out of Your
 *                   answers.
 *   when it stops . a trial that outlives TRIAL_DEADLINE_MS is counted as
 *                   failed and the set goes on; the run itself keeps going
 *                   and finishes on its page.
 */

export const DEFAULT_K = 3;
export const MAX_K = 10;
export const MAX_VARIANTS = 6;
export const TRIAL_DEADLINE_MS = 20 * 60_000;
export const MAX_TRIAL_RUNS = Math.max(1, Number(process.env.HUB_TRIAL_MAX_RUNS) || 60);

export const EFFORTS = ["low", "medium", "high", "max"] as const;

export interface TrialPlan {
  skill: SkillWithAgent;
  cases: SkillCase[];
  variants: TrialVariant[];
  k: number;
  runs: number;
  /** The sentence a person reads before confirming. */
  sentence: string;
}

/** Why a variant is not usable, or null. */
export async function variantProblem(v: TrialVariant): Promise<string | null> {
  if (!v.label?.trim()) return "Every variant needs a label.";
  if (v.model && !MODELS.some((m) => m.id === v.model)) return `Unknown model "${v.model}" in "${v.label}".`;
  if (v.effort && !EFFORTS.includes(v.effort as (typeof EFFORTS)[number])) return `Unknown effort "${v.effort}" in "${v.label}".`;
  if (v.instructions !== undefined && !v.instructions.trim()) return `"${v.label}" has an empty brief; leave it out to use the agent's.`;
  if (v.agent) {
    const a = await getAgent(v.agent);
    if (!a) return `There is no agent "${v.agent}" for "${v.label}".`;
    if (!a.enabled) return `"${a.name}" is switched off, so "${v.label}" cannot run.`;
  }
  return null;
}

/** Trim the variants to what is set: an empty field means "as it is". */
export function cleanVariants(raw: unknown): TrialVariant[] {
  if (!Array.isArray(raw)) return [];
  const out: TrialVariant[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
    const variant: TrialVariant = { label: str("label").slice(0, 60) };
    if (str("model")) variant.model = str("model");
    if (str("effort")) variant.effort = str("effort");
    if (typeof r.instructions === "string" && r.instructions.trim()) variant.instructions = r.instructions;
    if (str("agent")) variant.agent = str("agent");
    out.push(variant);
  }
  return out;
}

/** The set as it would run, or why it will not. Runs nothing. */
export async function planTrials(input: { skillRef: string; caseIds?: string[]; k?: number; variants?: TrialVariant[] }): Promise<TrialPlan | { error: string }> {
  const skill = await getSkill(input.skillRef);
  if (!skill) return { error: `No skill named "${input.skillRef}".` };
  let cases = await listCases(skill.id);
  if (input.caseIds?.length) {
    const wanted = new Set(input.caseIds);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  if (!cases.length) return { error: `"${skill.name}" has no test cases yet. Save one from an answer, or add one under Tests.` };
  const k = Math.max(1, Math.min(MAX_K, Math.trunc(input.k ?? DEFAULT_K)));
  const variants = input.variants?.length ? input.variants : [{ label: "As it is" }];
  if (variants.length > MAX_VARIANTS) return { error: `At most ${MAX_VARIANTS} setups in one comparison.` };
  const labels = new Set<string>();
  for (const v of variants) {
    const problem = await variantProblem(v);
    if (problem) return { error: problem };
    if (labels.has(v.label)) return { error: `Two setups are both called "${v.label}".` };
    labels.add(v.label);
  }
  for (const c of cases) {
    const bad = cleanChecks(c.checks).map(checkProblem).find(Boolean);
    if (bad) return { error: `Case "${c.name}": ${bad}` };
  }
  const runs = cases.length * k * variants.length;
  if (runs > MAX_TRIAL_RUNS) {
    return { error: `That is ${runs} runs of the real model (${cases.length} case${cases.length === 1 ? "" : "s"} × ${k} × ${variants.length} setup${variants.length === 1 ? "" : "s"}); the most one set may make is ${MAX_TRIAL_RUNS}. Fewer cases, a smaller k, or fewer setups.` };
  }
  const sentence =
    `${runs} run${runs === 1 ? "" : "s"} of the real model: ${cases.length} case${cases.length === 1 ? "" : "s"} × ${k} time${k === 1 ? "" : "s"}` +
    (variants.length > 1 ? ` × ${variants.length} setups (${variants.map((v) => v.label).join(", ")})` : "") +
    `, as you, with every write held and nothing remembered.`;
  return { skill, cases, variants, k, runs, sentence };
}

/**
 * Start a set and return it at once; the trials run on in this process, as
 * a long run does, and the row fills in as they finish. The page polls it.
 */
export async function startTrials(plan: TrialPlan, principal: Principal, label = ""): Promise<TrialSet> {
  const agent = await getAgent(plan.skill.agentId);
  const set = await createTrialSet({
    skillId: plan.skill.id,
    label: label || (plan.variants.length > 1 ? plan.variants.map((v) => v.label).join(" vs ") : "As it is"),
    principalId: principal.id,
    variants: plan.variants,
    k: plan.k,
    setupHash: setupHash({ instructions: agent?.instructions, model: agent?.model, effort: agent?.effort, promptTemplate: plan.skill.promptTemplate, checks: plan.skill.checks }),
  });
  const work = runTrials(set, plan, principal).catch(async (err) => {
    await failTrialSet(set.id, err instanceof Error ? err.message : String(err)).catch(() => {});
  });
  // Never an unhandled rejection: the container must not go down with a test.
  work.catch(() => {});
  return set;
}

async function runTrials(set: TrialSet, plan: TrialPlan, principal: Principal): Promise<void> {
  const results: TrialResult[] = [];
  for (const variant of plan.variants) {
    for (const c of plan.cases) {
      const result: TrialResult = { variant: variant.label, caseId: c.id, caseName: c.name, runs: [] };
      results.push(result);
      for (let i = 0; i < plan.k; i++) {
        result.runs.push(await oneTrial(set.id, plan.skill, c, variant, principal));
        await progressTrialSet(set.id, results).catch(() => {});
      }
    }
  }
  await finishTrialSet(set.id, results, scoreTrials(results, plan.variants, plan.k));
}

/** One run of one case under one setup, as the person, with what it came to. */
async function oneTrial(trialId: string, skill: SkillWithAgent, c: SkillCase, variant: TrialVariant, principal: Principal): Promise<TrialRun> {
  const out = await runSkillForPrincipal({
    skillRef: skill.id,
    args: c.args ?? {},
    prompt: c.prompt,
    principal,
    deadlineMs: TRIAL_DEADLINE_MS,
    agentRef: variant.agent ?? null,
    trial: { id: trialId, model: variant.model, effort: variant.effort, instructions: variant.instructions, checks: c.checks },
  });
  if (out.kind === "error") {
    return { runId: "", status: "failed", passed: false, checks: null, latencyMs: null, costUsd: null, words: null, error: out.message };
  }
  if (out.kind === "running") {
    return { runId: out.runId, status: "failed", passed: false, checks: null, latencyMs: null, costUsd: null, words: null, error: `Still running after ${Math.round(TRIAL_DEADLINE_MS / 60_000)} minutes; counted as failed. Its answer is on its run page.` };
  }
  const facts = await trialRunFacts(out.runId);
  if (!facts) return { runId: out.runId, status: "failed", passed: false, checks: out.checks, latencyMs: null, costUsd: null, words: null, error: "The run's row could not be read." };
  return { ...facts, passed: trialPassed(facts) };
}

/** Whether the skill's setup has changed since a set ran: the hash of today's setup, to compare with the set's. */
export async function currentSetupHash(skill: Pick<SkillWithAgent, "agentId" | "promptTemplate" | "checks">): Promise<string> {
  const agent = await getAgent(skill.agentId);
  return setupHash({ instructions: agent?.instructions, model: agent?.model, effort: agent?.effort, promptTemplate: skill.promptTemplate, checks: skill.checks });
}
