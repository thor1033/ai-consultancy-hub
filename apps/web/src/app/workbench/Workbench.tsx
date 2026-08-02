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

  // Skillify sub-flow state.
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
    <div>
      {/* 1. Run a session */}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the task and do it, e.g. “Generate this week's client presentation for CUST-001.”"
        rows={4}
        className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-sm outline-none focus:border-neutral-600"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-neutral-500">Tools:</span>
        {servers.map((name) => (
          <label
            key={name}
            className={`cursor-pointer rounded-full border px-3 py-1 text-sm transition ${
              selected.includes(name)
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                : "border-neutral-700 text-neutral-400 hover:border-neutral-600"
            }`}
          >
            <input
              type="checkbox"
              checked={selected.includes(name)}
              onChange={() => toggle(name)}
              className="hidden"
            />
            {SERVER_LABELS[name] ?? name}
          </label>
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <button
          onClick={run}
          disabled={running || !prompt.trim()}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? "Running…" : "Run session"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* 2. Session result */}
      {session && (
        <div className="mt-6 space-y-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
              Output
            </div>
            <pre className="whitespace-pre-wrap break-words text-sm text-neutral-100">
              {session.text || "(no text output)"}
            </pre>
          </div>

          <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
            <span>{session.model}</span>
            <span>· {session.iterations} turns</span>
            <span>· ran in {latencyS}s</span>
            <span>· {fmtUsd(session.costUsd)}</span>
            <span>· {session.totalTokens.toLocaleString()} tokens</span>
            {session.toolsUsed.length > 0 && (
              <span>· tools: {session.toolsUsed.join(", ")}</span>
            )}
          </div>

          {/* 3. Skillify */}
          {!draft && !created && (
            <button
              onClick={distill}
              disabled={distilling}
              className="rounded-lg border border-emerald-500/40 px-4 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-40"
            >
              {distilling ? "Distilling…" : "Skillify this session →"}
            </button>
          )}
        </div>
      )}

      {/* 4. Draft review + create */}
      {draft && !created && (
        <div className="mt-6 space-y-4 rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-5">
          <div className="text-sm font-medium text-emerald-300">
            Review the captured Skill
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Slug">
              <input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                className="input"
              />
            </Field>
          </div>

          <Field label="Description">
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="input"
            />
          </Field>

          <Field label="Manual baseline (minutes) — the ROI input">
            <input
              type="number"
              value={draft.baselineMinutes ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  baselineMinutes: e.target.value ? Number(e.target.value) : null,
                })
              }
              className="input w-32"
            />
          </Field>

          <Field label="Instructions (the reusable process)">
            <textarea
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              rows={10}
              className="input font-mono text-xs leading-relaxed"
            />
          </Field>

          <div className="flex items-center justify-between">
            <button
              onClick={() => setDraft(null)}
              className="text-sm text-neutral-400 hover:text-neutral-200"
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={creating}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              {creating ? "Creating…" : "Create Skill"}
            </button>
          </div>
        </div>
      )}

      {/* 5. Done */}
      {created && (
        <div className="mt-6 rounded-lg border border-emerald-800/50 bg-emerald-950/30 p-5">
          <div className="text-sm text-emerald-300">
            Skill <span className="font-semibold">{created.name}</span> created — anyone
            can run it now.
          </div>
          <Link
            href={`/skills/${created.slug}`}
            className="mt-3 inline-block rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400"
          >
            Open the Skill →
          </Link>
        </div>
      )}

      <style>{`
        .input {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgb(38 38 38);
          background: rgb(23 23 23 / 0.6);
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: rgb(245 245 245);
          outline: none;
        }
        .input:focus { border-color: rgb(82 82 82); }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-neutral-500">{label}</div>
      {children}
    </label>
  );
}
