"use client";

import { useState } from "react";
import Link from "next/link";
import {
  runSessionAction,
  distillSessionAction,
  createSkillFromDraftAction,
} from "./actions";
import type { SkillDraft } from "@/lib/skillify";

const SERVER_LABELS: Record<string, string> = {
  sample: "Sample (add)",
  "market-data": "Market data",
  "customer-data": "Customer data",
  pptx: "PowerPoint",
};

interface SessionResult {
  sessionId: string;
  servers: string[];
  text: string;
  model: string;
  iterations: number;
  toolsUsed: string[];
  costUsd: number;
  latencyMs: number;
  totalTokens: number;
}

function fmtUsd(n: number) {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function Workbench({ servers }: { servers: string[] }) {
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [session, setSession] = useState<SessionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ slug: string; name: string } | null>(null);

  function toggle(name: string) {
    setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  }

  async function run() {
    setRunning(true);
    setError(null);
    setSession(null);
    setDraft(null);
    setCreated(null);
    const out = await runSessionAction(prompt, selected);
    if ("error" in out) setError(out.error as string);
    else setSession(out as SessionResult);
    setRunning(false);
  }

  async function distill() {
    if (!session) return;
    setDistilling(true);
    setError(null);
    const out = await distillSessionAction(session.sessionId);
    if ("error" in out) setError(out.error as string);
    else setDraft(out.draft as SkillDraft);
    setDistilling(false);
  }

  async function create() {
    if (!session || !draft) return;
    setCreating(true);
    setError(null);
    const out = await createSkillFromDraftAction(session.sessionId, draft);
    if ("error" in out) setError(out.error as string);
    else setCreated(out as { slug: string; name: string });
    setCreating(false);
  }

  const latencyS = session ? (session.latencyMs / 1000).toFixed(1) : null;

  return (
    <div className="panel p-5">
      {/* 1. Run a session */}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the task and do it, e.g. “Generate this week's client presentation for CUST-001.”"
        rows={4}
        className="field resize-y"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-[var(--muted)]">Tools:</span>
        {servers.map((name) => {
          const on = selected.includes(name);
          return (
            <label
              key={name}
              className={`cursor-pointer rounded-lg border px-3 py-1 text-sm transition ${
                on
                  ? "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(name)}
                className="hidden"
              />
              {SERVER_LABELS[name] ?? name}
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex justify-end">
        <button onClick={run} disabled={running || !prompt.trim()} className="btn-brand">
          {running ? "Running…" : "Run session"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--border)] border-l-2 border-l-[var(--danger)] p-4 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* 2. Session result */}
      {session && (
        <div className="mt-6 space-y-4">
          <div className="inset p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">Output</div>
            <pre className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">
              {session.text || "(no text output)"}
            </pre>
          </div>

          <div className="mono flex flex-wrap gap-2 text-xs text-[var(--muted)]">
            <span>{session.model}</span>
            <span>· {session.iterations} turns</span>
            <span>· ran in {latencyS}s</span>
            <span>· {fmtUsd(session.costUsd)}</span>
            <span>· {session.totalTokens.toLocaleString()} tokens</span>
            {session.toolsUsed.length > 0 && <span>· tools: {session.toolsUsed.join(", ")}</span>}
          </div>

          {/* 3. Skillify */}
          {!draft && !created && (
            <button onClick={distill} disabled={distilling} className="btn">
              {distilling ? "Distilling…" : "Skillify this session →"}
            </button>
          )}
        </div>
      )}

      {/* 4. Draft review + create */}
      {draft && !created && (
        <div className="mt-6 space-y-4 rounded-xl border border-[color:color-mix(in_oklab,var(--brand)_30%,var(--border))] bg-[var(--brand-soft)] p-5">
          <div className="text-sm font-medium text-[var(--brand-ink)]">Review the captured Skill</div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="field" />
            </Field>
            <Field label="Slug">
              <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} className="field" />
            </Field>
          </div>

          <Field label="Description">
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="field"
            />
          </Field>

          <Field label="Manual baseline (minutes) — the ROI input">
            <input
              type="number"
              value={draft.baselineMinutes ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, baselineMinutes: e.target.value ? Number(e.target.value) : null })
              }
              className="field w-32"
            />
          </Field>

          <Field label="Instructions (the reusable process)">
            <textarea
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              rows={10}
              className="field mono resize-y text-xs leading-relaxed"
            />
          </Field>

          <div className="flex items-center justify-between">
            <button onClick={() => setDraft(null)} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
              Cancel
            </button>
            <button onClick={create} disabled={creating} className="btn-brand">
              {creating ? "Creating…" : "Create Skill"}
            </button>
          </div>
        </div>
      )}

      {/* 5. Done */}
      {created && (
        <div className="mt-6 rounded-xl border border-[color:color-mix(in_oklab,var(--positive)_35%,var(--border))] bg-[color:color-mix(in_oklab,var(--positive)_10%,transparent)] p-5">
          <div className="text-sm text-[var(--positive)]">
            Skill <span className="font-semibold">{created.name}</span> created — anyone can run it now.
          </div>
          <Link href={`/skills/${created.slug}`} className="btn-brand mt-3">
            Open the Skill →
          </Link>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-[var(--muted)]">{label}</div>
      {children}
    </label>
  );
}
