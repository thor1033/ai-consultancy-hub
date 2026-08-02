"use client";

import { useState } from "react";
import Link from "next/link";
import type { Category, Question, Answers } from "@/lib/assessmentRubric";
import type { AssessmentActionResult } from "./actions";
import { generateAssessmentAction } from "./actions";

function fmtUsd(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

const H2 = "mb-4 text-xs font-medium uppercase tracking-wide text-[var(--muted)]";

export function AssessmentForm({
  questions,
  categoryLabels,
  workflowPrompt,
}: {
  questions: Question[];
  categoryLabels: Record<Category, string>;
  workflowPrompt: string;
}) {
  const [company, setCompany] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [workflow, setWorkflow] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssessmentActionResult | null>(null);

  const answered = questions.filter((q) => typeof answers[q.id] === "number").length;
  const ready = answered === questions.length && workflow.trim().length > 0;
  const categories = [...new Set(questions.map((q) => q.category))] as Category[];

  async function generate() {
    setGenerating(true);
    setError(null);
    setResult(null);
    const out = await generateAssessmentAction({ company, answers, workflow });
    if ("error" in out) setError(out.error);
    else setResult(out);
    setGenerating(false);
  }

  if (result) {
    return <Report result={result} categoryLabels={categoryLabels} onReset={() => setResult(null)} />;
  }

  return (
    <div className="panel p-6">
      <label className="block">
        <div className="mb-1 text-xs text-[var(--muted)]">Company (optional)</div>
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Acme Capital"
          className="field max-w-sm"
        />
      </label>

      {categories.map((cat) => (
        <section key={cat} className="mt-8">
          <h2 className={H2}>{categoryLabels[cat]}</h2>
          <div className="space-y-6">
            {questions
              .filter((q) => q.category === cat)
              .map((q) => (
                <fieldset key={q.id}>
                  <legend className="mb-2 text-sm text-[var(--text-soft)]">{q.prompt}</legend>
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((o) => {
                      const active = answers[q.id] === o.score;
                      return (
                        <label
                          key={o.score}
                          className={`cursor-pointer rounded-lg border px-3 py-1 text-sm transition ${
                            active
                              ? "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
                              : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                          }`}
                        >
                          <input
                            type="radio"
                            name={q.id}
                            checked={active}
                            onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.score }))}
                            className="hidden"
                          />
                          {o.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
          </div>
        </section>
      ))}

      <section className="mt-8">
        <label className="block">
          <div className="mb-2 text-sm text-[var(--text-soft)]">{workflowPrompt}</div>
          <textarea
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            rows={4}
            placeholder="e.g. Every Friday two analysts spend ~2 hours each pulling market data and rebuilding client decks by hand."
            className="field resize-y"
          />
        </label>
      </section>

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--border)] border-l-2 border-l-[var(--danger)] p-4 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <span className="mono text-xs text-[var(--muted)]">
          {answered}/{questions.length} answered
        </span>
        <button onClick={generate} disabled={generating || !ready} className="btn-brand">
          {generating ? "Analyzing…" : "Get my readiness report"}
        </button>
      </div>
    </div>
  );
}

function Report({
  result,
  categoryLabels,
  onReset,
}: {
  result: AssessmentActionResult;
  categoryLabels: Record<Category, string>;
  onReset: () => void;
}) {
  const { report } = result;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {result.scores.map((s) => (
          <Score key={s.category} label={categoryLabels[s.category]} value={s.score} />
        ))}
        <Score label="Overall readiness" value={result.overall} highlight />
      </div>

      <div className="panel border-l-2 border-l-[var(--positive)] p-5">
        <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
          Estimated recoverable value
        </div>
        <div className="metric mt-1 text-3xl font-semibold text-[var(--positive)]">
          {fmtUsd(result.estimatedMonthlyValueUsd)}
          <span className="text-base font-normal text-[var(--muted)]"> / month</span>
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          ~{report.estimatedMonthlyHoursRecoverable} hours of expert time a month, priced at{" "}
          {fmtUsd(result.rate)}/hr.
        </p>
      </div>

      {report.executiveSummary && <p className="text-[var(--text-soft)]">{report.executiveSummary}</p>}

      <section>
        <h2 className={H2}>Where AI creates value</h2>
        <div className="space-y-3">
          {report.opportunities.map((o, i) => (
            <div key={i} className="panel p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium text-[var(--text)]">{o.title}</h3>
                <span className="chip mono shrink-0">~{o.hoursPerMonth} h/mo</span>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">
                <span className="text-[var(--text-soft)]">As a Skill: </span>
                {o.asSkill}
              </p>
            </div>
          ))}
        </div>
      </section>

      {report.recommendedFirstSkill && (
        <section className="panel p-5">
          <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
            Recommended first Skill
          </div>
          <p className="mt-2 text-[var(--text-soft)]">{report.recommendedFirstSkill}</p>
          <Link href="/workbench" className="btn-brand mt-4">
            Capture it in the workbench →
          </Link>
        </section>
      )}

      <button onClick={onReset} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
        ← Start over
      </button>
    </div>
  );
}

function Score({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="panel p-4">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div
        className={`metric mt-1 text-2xl font-semibold ${
          highlight ? "text-[var(--brand-ink)]" : "text-[var(--text)]"
        }`}
      >
        {value.toFixed(1)}
        <span className="text-base font-normal text-[var(--muted)]"> / 5</span>
      </div>
    </div>
  );
}
