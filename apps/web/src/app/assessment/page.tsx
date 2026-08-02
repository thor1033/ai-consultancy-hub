import Link from "next/link";
import { QUESTIONS, CATEGORY_LABELS, WORKFLOW_PROMPT } from "@/lib/assessmentRubric";
import { AssessmentForm } from "./AssessmentForm";

export const dynamic = "force-dynamic";

// The AI Readiness Assessment (docs/02): a free, no-login questionnaire that
// scores a prospect's AI usage + data readiness and returns a Claude-generated,
// dollar-priced opportunity report — the top of the consultancy's funnel.
export default function AssessmentPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Skills
      </Link>

      <header className="mt-6 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">AI Readiness Assessment</h1>
        <p className="mt-1 text-neutral-400">
          Six questions and one workflow. Get a readiness score and a concrete,
          dollar-valued view of what to automate first — free, no login.
        </p>
      </header>

      <AssessmentForm
        questions={QUESTIONS}
        categoryLabels={CATEGORY_LABELS}
        workflowPrompt={WORKFLOW_PROMPT}
      />
    </main>
  );
}
