"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useView } from "@/components/ViewProvider";
import { createFromPatternAction, previewPatternAction, type PatternPreviewView } from "./actions";

// Picking a pattern and filling it in. The preview is the point: before
// anything is created, the person sees every agent it would make, which ones
// remember, who may ask whom, and what hands to what — the same reading the
// org chart will give once they exist.

export interface PatternView {
  slug: string;
  name: string;
  nickname: string;
  summary: string;
  when: string[];
  diagram: string;
  decisions: string[];
  params: { key: string; label: string; help: string; kind: "text" | "textarea" | "list"; required?: boolean; placeholder?: string; default?: string }[];
}

export function PatternPicker({ patterns, canManage }: { patterns: PatternView[]; canManage: boolean }) {
  const router = useRouter();
  // The diagram, slugs and server names are Expert reading (docs/views.md);
  // the words above and below them say the same thing.
  const expert = useView().view === "expert";
  const [open, setOpen] = useState<string>(patterns[0]?.slug ?? "");
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [preview, setPreview] = useState<PatternPreviewView | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, start] = useTransition();
  const pattern = patterns.find((p) => p.slug === open) ?? patterns[0];
  const v = values[pattern.slug] ?? {};
  const set = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [pattern.slug]: { ...(prev[pattern.slug] ?? {}), [key]: value } }));
    setPreview(null);
    setMessage(null);
  };

  function doPreview() {
    start(async () => {
      const res = await previewPatternAction(pattern.slug, v);
      if ("error" in res) setMessage({ text: res.error, error: true });
      else setPreview(res);
    });
  }

  function create() {
    start(async () => {
      const res = await createFromPatternAction(pattern.slug, v);
      if ("error" in res) setMessage({ text: res.error, error: true });
      else router.push(`/agents/${res.agents[0]?.slug ?? ""}`);
    });
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label="Patterns" className="flex flex-col gap-2 lg:sticky lg:top-6 lg:self-start">
        {patterns.map((p) => {
          const active = p.slug === pattern.slug;
          return (
            <button
              key={p.slug}
              type="button"
              onClick={() => {
                setOpen(p.slug);
                setPreview(null);
                setMessage(null);
              }}
              className={`panel panel-hover block border-l-2 p-4 text-left ${active ? "border-l-[var(--brand)]" : "border-l-transparent"}`}
            >
              <span className="block text-base font-bold leading-tight">{p.nickname}</span>
              <span className="mt-0.5 block text-xs text-[var(--muted)]">{p.name}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-col gap-6">
        <section className="panel p-5 md:p-6">
          <div className="eyebrow">{pattern.name}</div>
          <h2 className="mt-2 text-2xl md:text-3xl">{pattern.nickname}</h2>
          <p className="mt-3 max-w-3xl text-[var(--text-soft)]">{pattern.summary}</p>
          {expert && <pre className="inset mono mt-4 overflow-x-auto p-4 text-xs leading-relaxed">{pattern.diagram}</pre>}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs font-medium">When it is the right shape</div>
              <ul className="mt-1.5 flex flex-col gap-1 text-sm text-[var(--text-soft)]">
                {pattern.when.map((w) => (
                  <li key={w} className="flex gap-2">
                    <span aria-hidden className="mt-2 inline-block h-1.5 w-1.5 shrink-0 bg-[var(--ai)]" />
                    {w}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium">After creating it, you decide</div>
              <ul className="mt-1.5 flex flex-col gap-1 text-sm text-[var(--text-soft)]">
                {pattern.decisions.map((d) => (
                  <li key={d} className="flex gap-2">
                    <span aria-hidden className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--c-skill)]" />
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <form
          className="panel p-5 md:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            doPreview();
          }}
        >
          <div className="eyebrow">Fill it in</div>
          <div className="mt-4 grid gap-4">
            {pattern.params.map((p) => (
              <label key={p.key} className="block">
                <span className="mb-1 block text-xs text-[var(--muted)]">
                  {p.label}
                  {p.required && <span className="text-[var(--brand)]"> *</span>}
                </span>
                {p.kind === "text" ? (
                  <input className="field" value={v[p.key] ?? p.default ?? ""} onChange={(e) => set(p.key, e.target.value)} placeholder={p.placeholder} required={p.required} />
                ) : (
                  <textarea
                    className={`field ${p.kind === "list" && expert ? "mono" : ""} min-h-28`}
                    value={v[p.key] ?? p.default ?? ""}
                    onChange={(e) => set(p.key, e.target.value)}
                    placeholder={p.placeholder}
                    required={p.required}
                  />
                )}
                <span className="mt-1 block text-xs text-[var(--muted)]">{p.help}</span>
              </label>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button type="submit" disabled={pending} className="btn min-h-11">
              {pending && !preview ? "Previewing…" : "Preview what it creates"}
            </button>
            {preview && preview.errors.length === 0 && (
              <button type="button" disabled={pending || !canManage} onClick={create} className="btn-brand min-h-11">
                {pending ? "Creating…" : `Create ${preview.agents.length} agent${preview.agents.length === 1 ? "" : "s"}`}
              </button>
            )}
            {!canManage && <span className="text-xs text-[var(--warning)]">Only an admin can create agents; you can preview.</span>}
          </div>
          {message && <p className={`mt-3 text-sm ${message.error ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{message.text}</p>}
        </form>

        {preview && (
          <section className="panel p-5 md:p-6" aria-live="polite">
            <div className="eyebrow">What it creates</div>
            {preview.errors.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1 text-sm text-[var(--danger)]">
                {preview.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : (
              <>
                <ol className="mt-3 flex flex-col">
                  {preview.agents.map((a) => (
                    <li key={a.slug} className="border-t border-[var(--border)] py-3">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-base font-bold">{a.name}</span>
                        {expert && <span className="mono text-xs text-[var(--muted)]">{a.slug}</span>}
                      </div>
                      <p className="mt-1 text-sm text-[var(--text-soft)]">{a.description}</p>
                      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                        <li className="flex items-center gap-1.5">
                          <span aria-hidden className="inline-block h-1.5 w-1.5" style={{ background: a.keepsMemory ? "var(--c-mem)" : "var(--border-strong)" }} />
                          {a.keepsMemory ? "Remembers" : "No memory: starts clean every run"}
                        </li>
                        {a.asks.length > 0 && (
                          <li className="flex items-center gap-1.5">
                            <span aria-hidden className="inline-block h-1.5 w-1.5 bg-[var(--c-person)]" />
                            May ask {a.asks.join(", ")}
                          </li>
                        )}
                        {expert && a.servers.length > 0 && (
                          <li className="flex items-center gap-1.5">
                            <span aria-hidden className="inline-block h-1.5 w-1.5 border-2 border-[var(--c-src)]" />
                            Tools: {a.servers.join(", ")}
                          </li>
                        )}
                        {a.skills.length > 0 && (
                          <li className="flex items-center gap-1.5">
                            <span aria-hidden className="inline-block h-1.5 w-1.5 rotate-45 bg-[var(--c-skill)]" />
                            Skill: {a.skills.join(", ")}
                          </li>
                        )}
                      </ul>
                      {expert && a.unknownServers.length > 0 && (
                        <p className="mt-1.5 text-xs text-[var(--warning)]">
                          Not declared on this deployment, so skipped at run time: {a.unknownServers.join(", ")}.
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
                {preview.handoffs.length > 0 && (
                  <>
                    <div className="mt-4 text-xs font-medium">Hand-offs</div>
                    <ul className="mt-1.5 flex flex-col gap-1 text-sm text-[var(--text-soft)]">
                      {preview.handoffs.map((h, i) => (
                        <li key={i}>
                          When {h.from} finishes {h.skill ? <span className="font-medium">{h.skill}</span> : "any run"} → start {h.to}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="mt-4 text-xs text-[var(--muted)]">
                  These become ordinary agents on the org chart: yours to edit, switch off or delete, one by one. The pattern is only where they
                  came from.
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
