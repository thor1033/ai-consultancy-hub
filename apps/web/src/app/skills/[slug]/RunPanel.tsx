"use client";

import { useState } from "react";
import { runSkillAction } from "./actions";

interface RunOk {
  runId: string;
  skill: { slug: string; version: number };
  result: {
    text: string;
    model: string;
    iterations: number;
    costUsd: number;
    latencyMs: number;
    usage: { totalTokens: number };
    traceId?: string;
  };
  retrievedCount: number;
  retrieved: {
    title: string | null;
    documentId: string;
    chunkIndex: number;
    score: number;
  }[];
  roi: { baselineMinutes: number | null; costUsd: number; latencyMs: number };
}

function fmtUsd(n: number) {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function RunPanel({
  slug,
  baselineMinutes,
}: {
  slug: string;
  baselineMinutes: number | null;
}) {
  const [input, setInput] = useState("");
  const [retrieve, setRetrieve] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunOk | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    const out = await runSkillAction(slug, input, retrieve);
    if ("error" in out) setError(out.error as string);
    else setResult(out as RunOk);
    setLoading(false);
  }

  const latencyS = result ? (result.result.latencyMs / 1000).toFixed(1) : null;

  return (
    <div className="panel mt-6 p-5">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        Run
      </h2>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Enter the input for this skill…"
        rows={4}
        className="field resize-y"
      />

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            checked={retrieve}
            onChange={(e) => setRetrieve(e.target.checked)}
            className="accent-[var(--brand)]"
          />
          Use knowledge base (RAG)
        </label>
        <button onClick={run} disabled={loading || !input.trim()} className="btn-brand">
          {loading ? "Running…" : "Run skill"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--border)] border-l-2 border-l-[var(--danger)] p-4 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-6 space-y-4">
          <div className="inset p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">Output</div>
            <pre className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">
              {result.result.text || "(no text output)"}
            </pre>
          </div>

          {/* ROI — the number that makes the value visible. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label="Manual baseline"
              value={baselineMinutes != null ? `${baselineMinutes} min` : "—"}
              accent
            />
            <Metric label="Ran in" value={`${latencyS}s`} accent />
            <Metric label="Model cost" value={fmtUsd(result.result.costUsd)} />
            <Metric label="Tokens" value={result.result.usage.totalTokens.toLocaleString()} />
          </div>

          <div className="mono text-xs text-[var(--muted)]">
            v{result.skill.version} · {result.result.model} · {result.result.iterations} turn
            {result.result.iterations === 1 ? "" : "s"}
            {result.retrievedCount > 0 &&
              ` · ${result.retrievedCount} context chunk${result.retrievedCount === 1 ? "" : "s"}`}
            {result.result.traceId && ` · trace ${result.result.traceId}`}
          </div>

          {/* RAG provenance: exactly what context the agent was given. */}
          {result.retrieved.length > 0 && (
            <div className="inset p-4">
              <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">
                Context used ({result.retrieved.length})
              </div>
              <ul className="space-y-1 text-sm">
                {result.retrieved.map((r) => (
                  <li key={`${r.documentId}-${r.chunkIndex}`} className="flex items-center justify-between gap-3">
                    <span className="truncate text-[var(--text-soft)]">
                      {r.title || "(untitled)"}{" "}
                      <span className="text-[var(--muted)]">#{r.chunkIndex}</span>
                    </span>
                    <span className="mono shrink-0 text-xs text-[var(--brand-ink)]">
                      {(r.score * 100).toFixed(0)}% match
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="inset p-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div
        className={`metric mt-1 text-lg font-semibold ${
          accent ? "text-[var(--positive)]" : "text-[var(--text)]"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
