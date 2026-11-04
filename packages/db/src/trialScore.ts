// The pure half of a skill's trials (docs/skill-tests.md): the shapes a
// trial set holds and how it is scored. No database, so the page can score
// and summarise in the browser (exported as @ai-hub/db/trials).

import type { CheckResult } from "./checks";

/** One setup under test. Every field optional: an empty variant is "as it is". */
export interface TrialVariant {
  label: string;
  model?: string;
  effort?: string;
  /** A brief to run with instead of the agent's. */
  instructions?: string;
  /** Another agent's slug, given the same prompt: one agent against a team's coordinator. */
  agent?: string;
}

export interface TrialRun {
  runId: string;
  status: string;
  passed: boolean;
  checks: CheckResult[] | null;
  latencyMs: number | null;
  costUsd: number | null;
  words: number | null;
  error: string | null;
}

export interface TrialResult {
  variant: string;
  caseId: string;
  caseName: string;
  runs: TrialRun[];
}

export interface VariantSummary {
  variant: string;
  trials: number;
  passed: number;
  /** Cases where every one of the k trials passed. */
  casesAllPassed: number;
  cases: number;
  costUsd: number;
  /** Mean over trials that finished. */
  latencyMs: number | null;
  failed: number;
}

export interface TrialSummary {
  k: number;
  variants: VariantSummary[];
  /** The variant with most cases passing all k, then most trials passed, then cheapest; null when nothing ran. */
  best: string | null;
  /** Each case's pass count per variant, for the table. */
  byCase: { caseId: string; caseName: string; perVariant: Record<string, number> }[];
}

export interface TrialSet {
  id: string;
  skillId: string;
  label: string;
  principalId: string | null;
  variants: TrialVariant[];
  k: number;
  setupHash: string | null;
  status: "running" | "done" | "failed";
  error: string | null;
  results: TrialResult[] | null;
  summary: TrialSummary | null;
  startedAt: string;
  finishedAt: string | null;
}

/** A trial passes when it finished and every check passed. No checks at all is a pass: the run came back. */
export const trialPassed = (run: Omit<TrialRun, "passed">): boolean => run.status === "succeeded" && (run.checks ?? []).every((c) => c.ok === true);

/** The scores, from the results. Pure, so the page and the verify script can call it. */
export function scoreTrials(results: TrialResult[], variants: TrialVariant[], k: number): TrialSummary {
  const summaries: VariantSummary[] = variants.map((v) => {
    const mine = results.filter((r) => r.variant === v.label);
    const runs = mine.flatMap((r) => r.runs);
    const finished = runs.filter((r) => r.latencyMs !== null);
    return {
      variant: v.label,
      trials: runs.length,
      passed: runs.filter((r) => r.passed).length,
      failed: runs.filter((r) => r.status === "failed").length,
      casesAllPassed: mine.filter((r) => r.runs.length === k && r.runs.every((x) => x.passed)).length,
      cases: mine.length,
      costUsd: runs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      latencyMs: finished.length ? Math.round(finished.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / finished.length) : null,
    };
  });
  const ran = summaries.filter((s) => s.trials > 0);
  const best = ran.length
    ? [...ran].sort((a, b) => b.casesAllPassed - a.casesAllPassed || b.passed - a.passed || a.costUsd - b.costUsd)[0].variant
    : null;
  const caseIds = [...new Map(results.map((r) => [r.caseId, r.caseName])).entries()];
  const byCase = caseIds.map(([caseId, caseName]) => ({
    caseId,
    caseName,
    perVariant: Object.fromEntries(variants.map((v) => [v.label, results.find((r) => r.caseId === caseId && r.variant === v.label)?.runs.filter((x) => x.passed).length ?? 0])),
  }));
  return { k, variants: summaries, best, byCase };
}

/** The verdict in a line: "Best: Sonnet · 4 of 5 cases passed every time · 14 of 15 trials". */
export function summarizeTrials(summary: TrialSummary | null | undefined): string | null {
  if (!summary?.best) return null;
  const v = summary.variants.find((s) => s.variant === summary.best)!;
  const parts = [summary.variants.length > 1 ? `Best: ${v.variant}` : v.variant, `${v.casesAllPassed} of ${v.cases} case${v.cases === 1 ? "" : "s"} passed every time`, `${v.passed} of ${v.trials} trials`];
  return parts.join(" · ");
}
