"use server";

import { recordAssessment } from "@ai-hub/db";
import { generateAssessment, type AssessmentResult } from "@/lib/assessment";
import { QUESTIONS, type Answers } from "@/lib/assessmentRubric";

// Server action for the AI Readiness Assessment (docs/02) — the free, ungated
// lead-gen on-ramp. Prospects have no accounts yet, so like the workbench actions
// this runs server-trusted without a PolicyEngine gate; the persisted row is what
// the consultancy reviews as a lead.

export interface AssessmentActionResult extends AssessmentResult {
  id: string;
}

export async function generateAssessmentAction(input: {
  company?: string;
  answers: Answers;
  workflow: string;
}): Promise<AssessmentActionResult | { error: string }> {
  // Every scored question must be answered — the scores (and the report grounded
  // in them) are meaningless otherwise.
  const missing = QUESTIONS.filter((q) => typeof input.answers[q.id] !== "number");
  if (missing.length > 0) {
    return { error: "Please answer every question before generating." };
  }
  if (!input.workflow.trim()) {
    return { error: "Describe one recurring workflow so we can find where AI helps." };
  }

  try {
    const result = await generateAssessment({
      company: input.company?.trim() || undefined,
      answers: input.answers,
      workflow: input.workflow.trim(),
    });

    const usage = result.scores.find((s) => s.category === "usage")?.score ?? 0;
    const data = result.scores.find((s) => s.category === "data")?.score ?? 0;

    const id = await recordAssessment({
      company: result.company,
      answers: input.answers,
      workflow: input.workflow.trim(),
      usageScore: usage,
      dataScore: data,
      overall: result.overall,
      report: result.report,
      rate: result.rate,
      monthlyValueUsd: result.estimatedMonthlyValueUsd,
    });

    return { id, ...result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not generate the assessment." };
  }
}
