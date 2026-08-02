import { getSql } from "./client";

// AI Readiness Assessment persistence (docs/02). The web app owns the scoring +
// report shapes; here we just store/return them as opaque JSON alongside the
// scalar scores the consultancy filters leads by.

export interface RecordAssessmentInput {
  company?: string | null;
  answers: Record<string, number>;
  workflow?: string | null;
  usageScore: number;
  dataScore: number;
  overall: number;
  report: unknown;
  rate: number;
  monthlyValueUsd: number;
}

export interface AssessmentSummary {
  id: string;
  company: string | null;
  overall: number | null;
  monthlyValueUsd: number | null;
  createdAt: string;
}

export interface AssessmentRecord extends AssessmentSummary {
  answers: Record<string, number>;
  workflow: string | null;
  usageScore: number | null;
  dataScore: number | null;
  report: unknown;
  rate: number | null;
}

export async function recordAssessment(input: RecordAssessmentInput): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into assessments
      (company, answers, workflow, usage_score, data_score, overall,
       report, rate, monthly_value_usd)
    values
      (${input.company ?? null}, ${sql.json(input.answers as never)},
       ${input.workflow ?? null}, ${input.usageScore}, ${input.dataScore},
       ${input.overall}, ${sql.json(input.report as never)},
       ${input.rate}, ${input.monthlyValueUsd})
    returning id
  `;
  return row.id;
}

export async function getAssessment(id: string): Promise<AssessmentRecord | null> {
  const sql = getSql();
  const [row] = await sql<AssessmentRecord[]>`
    select id, company,
           answers,
           workflow,
           usage_score       as "usageScore",
           data_score        as "dataScore",
           overall,
           report,
           rate,
           monthly_value_usd as "monthlyValueUsd",
           created_at        as "createdAt"
    from assessments where id = ${id}
  `;
  return row ?? null;
}

export async function listAssessments(limit = 50): Promise<AssessmentSummary[]> {
  const sql = getSql();
  return sql<AssessmentSummary[]>`
    select id, company, overall,
           monthly_value_usd as "monthlyValueUsd",
           created_at        as "createdAt"
    from assessments
    order by created_at desc
    limit ${limit}
  `;
}
