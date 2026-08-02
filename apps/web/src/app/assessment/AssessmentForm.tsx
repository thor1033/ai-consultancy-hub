"use client";

import { useState } from "react";
import Link from "next/link";
import type { Category, Question, Answers } from "@/lib/assessmentRubric";
import type { AssessmentActionResult } from "./actions";
import { generateAssessmentAction } from "./actions";

function fmtUsd(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

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
    <div>
      <label className="block">
        <div className="mb-1 text-xs text-neutral-500">Company (optional)</div>
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Acme Capital"
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
        />
      </label>

      {categories.map((cat) => (
        <section key={cat} className="mt-8">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
            {categoryLabels[cat]}
          </h2>
          <div className="space-y-6">
            {questions
              .filter((q) => q.category === cat)
              .map((q) => (
                <fieldset key={q.id}>
                  <legend className="mb-2 text-sm text-neutral-200">{q.prompt}</legend>
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((o) => {
                      const active = answers[q.id] === o.score;
                      return (
                        <label
                          key={o.score}
                          className={`cursor-pointer rounded-full border px-3 py-1 text-sm transition ${
                            active
                              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                              : "border-neutral-700 text-neutral-400 hover:border-neutral-600"
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
          <div className="mb-2 text-sm text-neutral-200">{workflowPrompt}</div>
          <textarea
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            rows={4}
            placeholder="e.g. Every Friday two analysts spend ~2 hours each pulling market data and rebuilding client decks by hand."
            className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-sm text-neutral-100 outline-none focus:border-neutral-600"
          />
        </label>
      </section>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs text-neutral-500">
          {answered}/{questions.length} answered
        </span>
        <button
          onClick={generate}
          disabled={generating || !ready}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
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
    <div className="space-y-8">
      {/* Scores */}
      <div className="grid gap-4 sm:grid-cols-3">
        {result.scores.map((s) => (
          <Score key={s.category} label={categoryLabels[s.category]} value={s.score} />
        ))}
        <Score label="Overall readiness" value={result.overall} highlight />
      </div>

      {/* Headline value */}
      <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-5">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          Estimated recoverable value
        </div>
        <div className="mt-1 text-3xl font-semibold text-emerald-400">
          {fmtUsd(result.estimatedMonthlyValueUsd)}
          <span className="text-base font-normal text-neutral-400"> / month</span>
        </div>
        <p className="mt-2 text-sm text-neutral-400">
          ~{report.estimatedMonthlyHoursRecoverable} hours of expert time a month,
          priced at {fmtUsd(result.rate)}/hr.
        </p>
      </div>

      {/* Executive summary */}
      {report.executiveSummary && (
        <p className="text-neutral-200">{report.executiveSummary}</p>
      )}

      {/* Opportunities */}
      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Where AI creates value
        </h2>
        <div className="space-y-3">
          {report.opportunities.map((o, i) => (
            <div
              key={i}
              className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium text-neutral-100">{o.title}</h3>
                <span className="shrink-0 rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
                  ~{o.hoursPerMonth} h/mo
                </span>
              </div>
              <p className="mt-2 text-sm text-neutral-400">
                <span className="text-neutral-500">As a Skill: </span>
                {o.asSkill}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Recommended first skill */}
      {report.recommendedFirstSkill && (
        <section className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Recommended first Skill
          </div>
          <p className="mt-2 text-neutral-200">{report.recommendedFirstSkill}</p>
          <Link
            href="/workbench"
            className="mt-4 inline-block rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400"
          >
            Capture it in the workbench →
          </Link>
        </section>
      )}

      <button
        onClick={onReset}
        className="text-sm text-neutral-400 hover:text-neutral-200"
      >
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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold ${
          highlight ? "text-emerald-400" : "text-neutral-100"
        }`}
      >
        {value.toFixed(1)}
        <span className="text-base font-normal text-neutral-500"> / 5</span>
      </div>
    </div>
  );
}
