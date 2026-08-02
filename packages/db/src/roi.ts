import { getSql } from "./client";

// ROI reporting (docs/02 — "Unproven ROI" is one of the four pains, and the
// money-saved number is the key differentiator). Every skill run records its
// cost/latency substrate; here we aggregate it against each version's manual
// baseline into the "time and money saved" story directors can show upward.

export interface SkillRoi {
  slug: string;
  name: string;
  runs: number; // total recorded runs
  succeededRuns: number; // only these are credited with time saved
  minutesSaved: number; // Σ baseline_minutes over succeeded runs
  costUsd: number; // Σ model cost over all runs
  lastRunAt: string | null;
}

export interface RoiTotals {
  runs: number;
  succeededRuns: number;
  minutesSaved: number;
  costUsd: number;
}

export interface RoiSummary {
  totals: RoiTotals;
  bySkill: SkillRoi[];
}

// Aggregates runs → per-skill ROI. Each run credits the manual baseline of the
// exact version that ran (baselines can change across versions), and only
// succeeded runs count toward time saved. Numeric columns are cast to float8 so
// postgres.js returns numbers, not strings.
export async function roiSummary(): Promise<RoiSummary> {
  const sql = getSql();

  const bySkill = await sql<SkillRoi[]>`
    select s.slug,
           s.name,
           count(r.id)::int                                          as "runs",
           count(r.id) filter (where r.status = 'succeeded')::int    as "succeededRuns",
           coalesce(
             sum(v.baseline_minutes) filter (where r.status = 'succeeded'),
             0)::int                                                 as "minutesSaved",
           coalesce(sum(r.cost_usd), 0)::float8                      as "costUsd",
           max(r.created_at)                                         as "lastRunAt"
    from skills s
    join skill_runs r on r.skill_id = s.id
    left join skill_versions v
      on v.skill_id = r.skill_id and v.version = r.version
    where s.archived_at is null
    group by s.id
    order by "minutesSaved" desc, "runs" desc
  `;

  const totals = bySkill.reduce<RoiTotals>(
    (acc, s) => ({
      runs: acc.runs + s.runs,
      succeededRuns: acc.succeededRuns + s.succeededRuns,
      minutesSaved: acc.minutesSaved + s.minutesSaved,
      costUsd: acc.costUsd + s.costUsd,
    }),
    { runs: 0, succeededRuns: 0, minutesSaved: 0, costUsd: 0 },
  );

  return { totals, bySkill };
}
