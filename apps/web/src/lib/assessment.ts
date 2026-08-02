import { runAgent } from "@ai-hub/agent";
import { analystHourlyRate } from "./roi";
import {
  scoreCategories,
  overallScore,
  QUESTIONS,
  type Answers,
  type CategoryScore,
} from "./assessmentRubric";

// The AI Readiness Assessment generator (docs/02). Scoring is deterministic (the
// rubric); the qualitative half — where the value is and what to skillify first —
// is produced by Claude and grounded in the respondent's own described workflow.
// The recoverable-hours estimate is priced at the analyst rate, tying the free
// assessment straight into the ROI story the paid hub then proves.

export interface Opportunity {
  title: string;
  hoursPerMonth: number; // rough manual hours/month this consumes today
  asSkill: string; // one line on how the hub would capture it as a Skill
}

export interface AssessmentReport {
  executiveSummary: string;
  opportunities: Opportunity[];
  recommendedFirstSkill: string;
  estimatedMonthlyHoursRecoverable: number;
}

export interface AssessmentInput {
  company?: string;
  answers: Answers;
  workflow: string; // free-text description of a recurring manual workflow
}

export interface AssessmentResult {
  company: string | null;
  scores: CategoryScore[];
  overall: number;
  report: AssessmentReport;
  rate: number; // analyst hourly rate used to price recoverable time
  estimatedMonthlyValueUsd: number;
}

const SYSTEM = `You are an AI readiness consultant. Given an organization's readiness scores and a description of one recurring manual workflow, identify where AI would create the most value and what to capture as a reusable "Skill" first.

A Skill = a captured expert workflow that the organization then runs one-click, replacing repeated manual effort.

Respond with ONLY a JSON object, no prose or code fences:
{
  "executiveSummary": "2-3 sentences: where they are and where the value is.",
  "opportunities": [
    { "title": "short name", "hoursPerMonth": <integer manual hours/month>, "asSkill": "one line on how the hub captures it" }
  ],
  "recommendedFirstSkill": "the single best first workflow to skillify and why (one sentence).",
  "estimatedMonthlyHoursRecoverable": <integer total hours/month across the opportunities>
}
Give 2-4 opportunities. Ground the first one in the workflow they described. Be concrete and conservative with hour estimates.`;

function renderAnswers(answers: Answers): string {
  return QUESTIONS.map((q) => {
    const score = answers[q.id];
    const chosen = q.options.find((o) => o.score === score);
    return `- ${q.prompt} → ${chosen?.label ?? "(unanswered)"} (${score ?? "?"}/5)`;
  }).join("\n");
}

export async function generateAssessment(
  input: AssessmentInput,
): Promise<AssessmentResult> {
  const scores = scoreCategories(input.answers);
  const overall = overallScore(input.answers);

  const prompt = `ORGANIZATION: ${input.company || "(unnamed)"}

READINESS SCORES (1-5):
${scores.map((s) => `- ${s.label}: ${s.score}`).join("\n")}
- Overall: ${overall}

QUESTIONNAIRE:
${renderAnswers(input.answers)}

DESCRIBED RECURRING WORKFLOW:
${input.workflow || "(none provided)"}`;

  const result = await runAgent({
    prompt,
    system: SYSTEM,
    effort: "high",
    metadata: { source: "assessment.generate" },
  });

  const report = parseReport(result.text);
  const rate = analystHourlyRate();
  return {
    company: input.company?.trim() || null,
    scores,
    overall,
    report,
    rate,
    estimatedMonthlyValueUsd: report.estimatedMonthlyHoursRecoverable * rate,
  };
}

function parseReport(text: string): AssessmentReport {
  const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
  const raw = tryParse(cleaned) ?? tryParse(cleaned.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!raw) throw new Error("Could not parse the assessment report from the model.");

  const opportunities: Opportunity[] = Array.isArray(raw.opportunities)
    ? raw.opportunities.map((o) => ({
        title: String(o?.title ?? "Opportunity"),
        hoursPerMonth: Number(o?.hoursPerMonth) || 0,
        asSkill: String(o?.asSkill ?? ""),
      }))
    : [];

  return {
    executiveSummary: String(raw.executiveSummary ?? ""),
    opportunities,
    recommendedFirstSkill: String(raw.recommendedFirstSkill ?? ""),
    estimatedMonthlyHoursRecoverable:
      Number(raw.estimatedMonthlyHoursRecoverable) ||
      opportunities.reduce((a, o) => a + o.hoursPerMonth, 0),
  };
}

interface RawReport {
  executiveSummary?: unknown;
  opportunities?: Array<{ title?: unknown; hoursPerMonth?: unknown; asSkill?: unknown }>;
  recommendedFirstSkill?: unknown;
  estimatedMonthlyHoursRecoverable?: unknown;
}

function tryParse(s: string): RawReport | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as RawReport;
  } catch {
    return null;
  }
}
