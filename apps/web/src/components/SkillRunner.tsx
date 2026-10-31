"use client";

import { useEffect, useRef, useState } from "react";
import type { SkillParameter } from "@ai-hub/db";
import { runSkillAction, runStatusAction, type SkillRunResult } from "@/app/agents/actions";
import { Markdown } from "./Markdown";

// A skill as a short form: its arguments become fields, "Run" runs it as you,
// and the answer appears beneath (docs/views.md). A long run is polled, and
// the person is told they may leave: the answer is kept on the agent's runs.

const POLL_MS = 3_000;
const POLL_FOR_MS = 20 * 60_000;

/** Long free text gets a box; a short value a line. Judged from the name and the description. */
function wantsBox(p: SkillParameter): boolean {
  return /transcript|text|notes|content|body|email|document|request|task|brief|input|question|details|description/i.test(`${p.name} ${p.description}`);
}

const label = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

export function SkillRunner({
  skill,
  agentName,
  onClose,
}: {
  skill: { id: string; name: string; description: string; parameters: SkillParameter[] };
  agentName: string;
  onClose?: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((skill.parameters ?? []).map((p) => [p.name, p.type === "boolean" ? "false" : p.options?.[0] && p.required ? p.options[0] : ""])),
  );
  const [result, setResult] = useState<SkillRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const started = useRef(0);

  // Poll a run that outlived the page's wait, until it ends or the page gives up.
  useEffect(() => {
    if (result?.status !== "running") return;
    const t = setInterval(async () => {
      if (Date.now() - started.current > POLL_FOR_MS) {
        clearInterval(t);
        return;
      }
      const next = await runStatusAction(result.runId).catch(() => null);
      if (next && next.status !== "running") {
        setResult(next);
        setBusy(false);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [result]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    started.current = Date.now();
    const out = await runSkillAction(skill.id, values).catch((err) => ({ status: "failed" as const, error: err instanceof Error ? err.message : String(err) }));
    setResult(out);
    if (out.status !== "running") setBusy(false);
  }

  const params = skill.parameters ?? [];
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={run} className="flex flex-col gap-3">
        {params.map((p) => (
          <label key={p.name} className="block">
            <span className="mb-1 block text-xs text-[var(--muted)]">
              {label(p.name)}
              {p.required && <span className="text-[var(--brand)]"> *</span>}
            </span>
            {p.type === "boolean" ? (
              <select className="field" value={values[p.name]} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}>
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            ) : p.options?.length ? (
              <select className="field" value={values[p.name]} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} required={p.required}>
                {!p.required && <option value="">—</option>}
                {p.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : wantsBox(p) ? (
              <textarea className="field min-h-28" value={values[p.name]} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} required={p.required} />
            ) : (
              <input
                className="field"
                type={p.type === "number" ? "number" : "text"}
                value={values[p.name]}
                onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
                required={p.required}
              />
            )}
            {p.description && <span className="mt-1 block text-xs text-[var(--muted)]">{p.description}</span>}
          </label>
        ))}
        {params.length === 0 && <p className="text-sm text-[var(--muted)]">This skill needs nothing from you: it runs the same way every time.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className="btn-brand min-h-11">
            {busy ? (result?.status === "running" ? "Still working…" : "Working…") : "Run"}
          </button>
          {onClose && (
            <button type="button" className="btn min-h-11" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </form>

      {result?.status === "running" && (
        <p className="text-sm text-[var(--muted)]">
          {agentName} is still working — real work takes a few minutes. You can stay, or leave this page: the answer will be under
          &ldquo;Your answers&rdquo; on {agentName}&apos;s page.
        </p>
      )}
      {result?.status === "failed" && (
        <div role="alert" className="panel notice-danger p-3 text-sm text-[var(--danger)]">
          {result.error}
        </div>
      )}
      {result?.status === "done" && (
        <div className="inset p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="eyebrow">{agentName}&apos;s answer</span>
            <button
              type="button"
              className="text-xs text-[var(--muted)] underline-offset-2 hover:text-[var(--brand)] hover:underline"
              onClick={() => navigator.clipboard?.writeText(result.output).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <Markdown>{result.output}</Markdown>
        </div>
      )}
    </div>
  );
}
