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
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Run
      </h2>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Enter the input for this skill…"
        rows={4}
        className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-sm outline-none focus:border-neutral-600"
      />

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input
            type="checkbox"
            checked={retrieve}
            onChange={(e) => setRetrieve(e.target.checked)}
            className="accent-emerald-500"
          />
          Use knowledge base (RAG)
        </label>
        <button
          onClick={run}
          disabled={loading || !input.trim()}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Running…" : "Run skill"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-6 space-y-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
              Output
            </div>
            <pre className="whitespace-pre-wrap break-words text-sm text-neutral-100">
              {result.result.text || "(no text output)"}
            </pre>
          </div>

          {/* ROI — the number that makes the value visible. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label="Manual baseline"
              value={
                baselineMinutes != null ? `${baselineMinutes} min` : "—"
              }
              accent
            />
            <Metric label="Ran in" value={`${latencyS}s`} accent />
            <Metric label="Model cost" value={fmtUsd(result.result.costUsd)} />
            <Metric
              label="Tokens"
              value={result.result.usage.totalTokens.toLocaleString()}
            />
          </div>

          <div className="text-xs text-neutral-500">
            v{result.skill.version} · {result.result.model} ·{" "}
            {result.result.iterations} turn
            {result.result.iterations === 1 ? "" : "s"}
            {result.retrievedCount > 0 &&
              ` · ${result.retrievedCount} context chunk${
                result.retrievedCount === 1 ? "" : "s"
              }`}
            {result.result.traceId && ` · trace ${result.result.traceId}`}
          </div>
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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold ${
          accent ? "text-emerald-400" : "text-neutral-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
