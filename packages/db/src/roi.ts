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

export interface RoiDay {
  day: string; // YYYY-MM-DD (UTC)
  runs: number;
  minutesSaved: number;
  costUsd: number;
}

// Per-day ROI substrate for the trend chart: succeeded-run count, minutes saved
// (against each run's version baseline), and model cost. Zero-fills missing days
// so the series is continuous over the window.
export async function roiDaily(days = 30): Promise<RoiDay[]> {
  const sql = getSql();
  return sql<RoiDay[]>`
    with span as (
      select generate_series(
        (current_date - make_interval(days => ${days - 1})),
        current_date,
        interval '1 day'
      )::date as day
    ),
    daily as (
      select date_trunc('day', r.created_at)::date                     as day,
             count(r.id) filter (where r.status = 'succeeded')::int     as runs,
             coalesce(sum(v.baseline_minutes)
               filter (where r.status = 'succeeded'), 0)::int           as "minutesSaved",
             coalesce(sum(r.cost_usd), 0)::float8                       as "costUsd"
      from skill_runs r
      left join skill_versions v
        on v.skill_id = r.skill_id and v.version = r.version
      where r.created_at >= current_date - make_interval(days => ${days - 1})
      group by 1
    )
    select to_char(span.day, 'YYYY-MM-DD')       as day,
           coalesce(daily.runs, 0)               as runs,
           coalesce(daily."minutesSaved", 0)     as "minutesSaved",
           coalesce(daily."costUsd", 0)          as "costUsd"
    from span
    left join daily on daily.day = span.day
    order by span.day
  `;
}
