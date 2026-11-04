"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Skill, SkillCase, TrialSet, TrialVariant, TrialResult } from "@ai-hub/db";
// The pure trials module, not the package root: this is a client component, and the root opens Postgres.
import { summarizeTrials } from "@ai-hub/db/trials";
import { saveCaseAction, deleteCaseAction, planTrialsAction, startTrialsAction, trialStatusAction, type CaseDraft } from "../actions";
import { ChecksEditor, Field } from "./ChecksEditor";
import { MODELS } from "../models";
import { useView } from "@/components/ViewProvider";
import { money } from "@/lib/format";

/*
 * A skill's tests (docs/skill-tests.md): the cases it must pass, and the
 * sets of trials that ran them under one setup or several. This is where a
 * champion finds the best setup for a job: the same cases, k times, with
 * another model, effort, brief or agent, and a table that says which passed
 * every time and what each cost.
 *
 * Simple never sees this panel (the Skills tab hides the Tests button).
 * Standard sees cases, the brief variant and pass counts; model and effort
 * choices, costs and run ids are Expert's (docs/views.md).
 */

const POLL_MS = 5_000;
const EFFORTS = ["", "low", "medium", "high", "max"];

type CaseForm = Omit<CaseDraft, "skillId">;

const emptyCase = (skill: Skill): CaseForm => ({
  name: "",
  args: Object.fromEntries(skill.parameters.map((p) => [p.name, ""])),
  prompt: null,
  checks: [],
  reference: "",
});

export function TestsPanel({
  skill,
  agentSlug,
  initialCases,
  initialSets,
  onClose,
}: {
  skill: Skill;
  agentSlug: string;
  initialCases: SkillCase[];
  initialSets: TrialSet[];
  onClose?: () => void;
}) {
  const { atLeast } = useView();
  const expert = atLeast("expert");
  const [cases, setCases] = useState<SkillCase[]>(initialCases);
  const [sets, setSets] = useState<TrialSet[]>(initialSets);
  const [draft, setDraft] = useState<CaseForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState(3);
  const [variants, setVariants] = useState<TrialVariant[]>([{ label: "As it is" }]);
  const [plan, setPlan] = useState<{ runs: number; sentence: string } | null>(null);
  const [live, setLive] = useState<string | null>(sets.find((s) => s.status === "running")?.id ?? null);
  const [setupChanged, setSetupChanged] = useState<Record<string, boolean>>({});

  // A running set is polled until it is done; the table fills in as it goes.
  useEffect(() => {
    if (!live) return;
    let stopped = false;
    const tick = async () => {
      const out = await trialStatusAction(live).catch(() => null);
      if (stopped || !out || "error" in out) return;
      setSets((prev) => [out.set, ...prev.filter((s) => s.id !== out.set.id)]);
      setSetupChanged((prev) => ({ ...prev, [out.set.id]: out.setupChanged }));
      if (out.set.status !== "running") setLive(null);
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(h);
    };
  }, [live]);

  async function saveCase() {
    if (!draft) return;
    setBusy(true);
    const out = await saveCaseAction({ ...draft, skillId: skill.id });
    setBusy(false);
    if ("error" in out) setError(out.error);
    else {
      setCases(out.cases);
      setDraft(null);
      setError(null);
    }
  }

  const request = { skillId: skill.id, k, variants };

  async function ask() {
    setBusy(true);
    const out = await planTrialsAction(request);
    setBusy(false);
    if ("error" in out) {
      setError(out.error);
      setPlan(null);
    } else {
      setError(null);
      setPlan(out);
    }
  }

  async function run() {
    setBusy(true);
    const out = await startTrialsAction(request);
    setBusy(false);
    setPlan(null);
    if ("error" in out) setError(out.error);
    else {
      setError(null);
      setSets((prev) => [out.set, ...prev]);
      setLive(out.set.id);
    }
  }

  const updateVariant = (i: number, patch: Partial<TrialVariant>) => setVariants(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="eyebrow">Tests · {skill.name}</div>
          <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">
            What this skill must get right. Each case is one thing it was asked and what a good answer passes; save one from any answer that went wrong.
            Run the cases a few times each to see how often it passes, and under another setup to see which setup passes most.
          </p>
        </div>
        {onClose && (
          <button type="button" className="text-xs text-[var(--muted)] underline-offset-2 hover:underline" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="panel notice-danger p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* ── cases ─────────────────────────────────────────────────────── */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-bold">
            Cases <span className="font-normal text-[var(--muted)]">· {cases.length}</span>
          </h4>
          {!draft && (
            <button type="button" className="btn min-h-9 text-xs" onClick={() => setDraft(emptyCase(skill))}>
              Add a case
            </button>
          )}
        </div>
        {cases.length === 0 && !draft && (
          <p className="mt-2 text-sm text-[var(--muted)]">
            None yet. Five to ten cases from real answers that went wrong are worth more than fifty invented ones.
          </p>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {cases.map((c) => (
            <li key={c.id} className="inset flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{c.name}</div>
                <div className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">
                  {c.prompt ? c.prompt : Object.entries(c.args).map(([key, v]) => `${key}: ${String(v)}`).join(" · ")}
                </div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  {c.checks.length ? `${c.checks.length} check${c.checks.length === 1 ? "" : "s"} of its own` : "the skill's checks only"}
                  {c.reference ? " · has a reference answer" : ""}
                  {c.fromRunId ? " · from an answer" : ""}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn min-h-9 text-xs"
                  onClick={() => setDraft({ id: c.id, name: c.name, args: Object.fromEntries(Object.entries(c.args).map(([key, v]) => [key, String(v)])), prompt: c.prompt, checks: c.checks, reference: c.reference ?? "" })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn min-h-9 text-xs"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const out = await deleteCaseAction(c.id, skill.id);
                    setBusy(false);
                    if ("error" in out) setError(out.error);
                    else setCases(out.cases);
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>

        {draft && (
          <div className="panel mt-3 border-[var(--text)] p-4">
            <h4 className="text-sm font-bold">{draft.id ? "Edit the case" : "A new case"}</h4>
            <div className="mt-3">
              <Field label="What it is about, or what went wrong" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} placeholder="Missed the price change in the Q3 contract" />
            </div>
            {draft.prompt != null ? (
              <label className="mt-3 block">
                <span className="mb-1 block text-xs text-[var(--muted)]">The exact request, as the run had it</span>
                <textarea className="field min-h-28 text-sm leading-relaxed" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
              </label>
            ) : skill.parameters.length ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {skill.parameters.map((p) => (
                  <label key={p.name} className="block">
                    <span className="mb-1 block text-xs text-[var(--muted)]">{p.name}{p.description ? ` — ${p.description}` : ""}</span>
                    <textarea className="field min-h-11 text-sm" value={draft.args[p.name] ?? ""} onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [p.name]: e.target.value } })} />
                  </label>
                ))}
              </div>
            ) : (
              <label className="mt-3 block">
                <span className="mb-1 block text-xs text-[var(--muted)]">This skill takes no arguments; give the case the exact request instead</span>
                <textarea className="field min-h-20 text-sm" value={draft.prompt ?? ""} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
              </label>
            )}
            <ChecksEditor checks={draft.checks} onChange={(checks) => setDraft({ ...draft, checks })} />
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-[var(--muted)]">What a good answer looked like (optional; for whoever reads a failure)</span>
              <textarea className="field min-h-16 text-sm" value={draft.reference ?? ""} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} />
            </label>
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn-brand min-h-9" disabled={busy} onClick={saveCase}>
                {busy ? "Saving…" : "Save case"}
              </button>
              <button type="button" className="btn min-h-9" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── run them ──────────────────────────────────────────────────── */}
      {cases.length > 0 && (
        <section className="panel p-4">
          <h4 className="text-sm font-bold">Run the cases</h4>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Each case runs the number of times below, as you, with every write held and nothing remembered. Add a setup to compare: the same cases under another brief
            {expert ? ", model, effort or agent" : ""}.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--muted)]">Times each</span>
              <input className="field mono w-20" inputMode="numeric" value={k} onChange={(e) => setK(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
            </label>
            <button type="button" className="btn min-h-9 text-xs" onClick={() => setVariants([...variants, { label: `Setup ${variants.length + 1}` }])} disabled={variants.length >= 6}>
              Add a setup to compare
            </button>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {variants.map((v, i) => (
              <li key={i} className="inset grid gap-2 p-3 sm:grid-cols-[10rem_1fr_auto]">
                <Field label="Label" value={v.label} onChange={(label) => updateVariant(i, { label })} />
                <div className="grid gap-2">
                  {expert && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="block">
                        <span className="mb-1 block text-xs text-[var(--muted)]">Model</span>
                        <select className="field" value={v.model ?? ""} onChange={(e) => updateVariant(i, { model: e.target.value || undefined })}>
                          {MODELS.map((m) => (
                            <option key={m.id} value={m.id}>{m.id ? `${m.label} (${m.id})` : "As the agent has it"}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs text-[var(--muted)]">Effort</span>
                        <select className="field" value={v.effort ?? ""} onChange={(e) => updateVariant(i, { effort: e.target.value || undefined })}>
                          {EFFORTS.map((e) => (
                            <option key={e} value={e}>{e || "As the agent has it"}</option>
                          ))}
                        </select>
                      </label>
                      <Field label="Another agent (slug), given the same request" value={v.agent ?? ""} onChange={(agent) => updateVariant(i, { agent: agent || undefined })} placeholder="e.g. a team's coordinator" mono />
                    </div>
                  )}
                  <label className="block">
                    <span className="mb-1 block text-xs text-[var(--muted)]">A different brief (leave empty to use the agent&apos;s)</span>
                    <textarea className="field min-h-11 text-xs leading-relaxed" value={v.instructions ?? ""} onChange={(e) => updateVariant(i, { instructions: e.target.value || undefined })} />
                  </label>
                </div>
                {variants.length > 1 && (
                  <button type="button" className="btn min-h-9 self-start text-xs" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {!plan ? (
              <button type="button" className="btn-brand min-h-9" disabled={busy || Boolean(live)} onClick={ask}>
                {live ? "A set is running…" : "What would this run?"}
              </button>
            ) : (
              <>
                <span className="text-sm">{plan.sentence}</span>
                <button type="button" className="btn-brand min-h-9" disabled={busy} onClick={run}>
                  Run {plan.runs} {plan.runs === 1 ? "trial" : "trials"}
                </button>
                <button type="button" className="btn min-h-9" onClick={() => setPlan(null)}>
                  Not now
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {/* ── results ───────────────────────────────────────────────────── */}
      {sets.length > 0 && (
        <section>
          <h4 className="text-sm font-bold">
            Results <span className="font-normal text-[var(--muted)]">· {sets.length} set{sets.length === 1 ? "" : "s"}, newest first</span>
          </h4>
          <ul className="mt-2 flex flex-col gap-3">
            {sets.map((set, i) => (
              <li key={set.id}>
                <TrialSetView set={set} agentSlug={agentSlug} expert={expert} open={i === 0} setupChanged={setupChanged[set.id] ?? false} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function TrialSetView({ set, agentSlug, expert, open, setupChanged }: { set: TrialSet; agentSlug: string; expert: boolean; open: boolean; setupChanged: boolean }) {
  const results = set.results ?? [];
  const done = results.reduce((n, r) => n + r.runs.length, 0);
  const total = (set.variants.length || 1) * set.k * new Set(results.map((r) => r.caseId)).size;
  const line = summarizeTrials(set.summary);
  const when = new Date(set.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  return (
    <details open={open} className="inset p-3">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          aria-hidden
          className={`inline-block h-2 w-2 shrink-0 ${set.status === "running" ? "ctx-blink" : ""}`}
          style={{ background: set.status === "failed" ? "var(--brand)" : set.status === "running" ? "var(--muted)" : "var(--ai)" }}
        />
        <span className="text-sm font-medium">{set.label || "A set"}</span>
        <span className="text-xs text-[var(--muted)]">
          {set.status === "running" ? `Running · ${done}${total ? ` of ${total}` : ""} done · ` : set.status === "failed" ? "Did not finish · " : ""}
          {when}
          {expert && set.setupHash ? ` · setup ${set.setupHash}` : ""}
        </span>
      </summary>
      <div className="mt-3">
        {set.status === "failed" && <p className="text-sm text-[var(--danger)]">{set.error ?? "It stopped."}</p>}
        {line && <p className="text-sm">{line}</p>}
        {setupChanged && set.status === "done" && (
          <p className="mt-1 text-xs text-[var(--muted)]">The brief, model, template or checks have changed since this ran. Run the cases again to see what the change did.</p>
        )}
        {set.summary && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--muted)]">
                  <th className="py-1 pr-3 font-normal">Case</th>
                  {set.summary.variants.map((v) => (
                    <th key={v.variant} className="py-1 pr-3 font-normal">{v.variant}{set.summary!.best === v.variant && set.summary!.variants.length > 1 ? " ★" : ""}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {set.summary.byCase.map((row) => (
                  <tr key={row.caseId} className="border-t border-[var(--border)]">
                    <td className="py-1 pr-3">{row.caseName}</td>
                    {set.summary!.variants.map((v) => {
                      const n = row.perVariant[v.variant] ?? 0;
                      return (
                        <td key={v.variant} className={`py-1 pr-3 mono ${n === set.k ? "" : n === 0 ? "text-[var(--brand)]" : "text-[var(--text-soft)]"}`}>
                          {n} of {set.k}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t border-[var(--border)] text-xs text-[var(--muted)]">
                  <td className="py-1 pr-3">Passed every time</td>
                  {set.summary.variants.map((v) => (
                    <td key={v.variant} className="py-1 pr-3 mono">{v.casesAllPassed} of {v.cases} cases</td>
                  ))}
                </tr>
                {expert && (
                  <tr className="text-xs text-[var(--muted)]">
                    <td className="py-1 pr-3">Cost · mean time</td>
                    {set.summary.variants.map((v) => (
                      <td key={v.variant} className="py-1 pr-3 mono">{money(v.costUsd)} · {v.latencyMs === null ? "—" : `${Math.round(v.latencyMs / 1000)}s`}</td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <Failures results={results} agentSlug={agentSlug} expert={expert} />
      </div>
    </details>
  );
}

/** The trials that did not pass, each with why and a link to its run. */
function Failures({ results, agentSlug, expert }: { results: TrialResult[]; agentSlug: string; expert: boolean }) {
  const failed = results.flatMap((r) => r.runs.filter((x) => !x.passed).map((x) => ({ r, x })));
  if (!failed.length) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-[var(--muted)]">{failed.length} trial{failed.length === 1 ? "" : "s"} did not pass</summary>
      <ul className="mt-1 flex flex-col gap-1 text-xs">
        {failed.slice(0, 40).map(({ r, x }, i) => {
          const why = x.error ?? (x.checks ?? []).filter((c) => c.ok !== true).map((c) => c.detail).join(" · ");
          return (
            <li key={i} className="text-[var(--muted)]">
              <span className="text-[var(--text)]">{r.caseName}</span>
              {results.some((o) => o.variant !== r.variant) ? ` · ${r.variant}` : ""} · {why || "did not pass"}
              {x.runId && expert && (
                <>
                  {" · "}
                  <Link href={`/agents/${agentSlug}/runs/${x.runId}`} className="underline underline-offset-2">the run</Link>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
