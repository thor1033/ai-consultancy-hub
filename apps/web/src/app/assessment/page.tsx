import { QUESTIONS, CATEGORY_LABELS, WORKFLOW_PROMPT } from "@/lib/assessmentRubric";
import { AssessmentForm } from "./AssessmentForm";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

// The AI Readiness Assessment (docs/02): a free, no-login questionnaire that
// scores a prospect's AI usage + data readiness and returns a Claude-generated,
// dollar-priced opportunity report — the top of the consultancy's funnel.
export default function AssessmentPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Assessment"
        title="AI Readiness Assessment"
        subtitle="Six questions and one workflow. Get a readiness score and a concrete, dollar-valued view of what to automate first — free, no login."
      />
      <AssessmentForm
        questions={QUESTIONS}
        categoryLabels={CATEGORY_LABELS}
        workflowPrompt={WORKFLOW_PROMPT}
      />
    </main>
  );
}
