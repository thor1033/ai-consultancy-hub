"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AgentMemory } from "@ai-hub/db";
import { forgetMemoryAction, setMemoryActiveAction } from "../actions";

// What the agent has chosen to remember, split the way the runtime splits it:
// memories loaded into every run (the work in flight) and memories set aside
// (kept and searchable, but not loaded). An agent that quietly accumulates
// beliefs about a client is a liability; being able to read, park and delete
// any one of them is what makes it something to point at real work.

export function MemoryPanel({ agentId, name, memories }: { agentId: string; name: string; memories: AgentMemory[] }) {
  const loaded = memories.filter((m) => m.active);
  const aside = memories.filter((m) => !m.active);

  if (memories.length === 0) {
    return (
      <div className="panel p-6 md:p-8">
        <div className="eyebrow">Nothing remembered yet</div>
        <p className="mt-2 max-w-xl text-[var(--text-soft)]">
          {name} writes memories itself, through its memory tool, when something is worth keeping between runs. Have a
          conversation and they appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Column
        title="Loaded every run"
        hint="The work in flight. Read into the start of every conversation and scheduled run."
        node="var(--c-mem)"
        memories={loaded}
        agentId={agentId}
        empty="Nothing loaded — every run starts cold apart from its brief."
      />
      <Column
        title="Set aside"
        hint="Kept and searchable, but not loaded. The agent can still recall them when asked."
        node="var(--faint)"
        memories={aside}
        agentId={agentId}
        empty="Nothing set aside."
      />
    </div>
  );
}

function Column({
  title,
  hint,
  node,
  memories,
  agentId,
  empty,
}: {
  title: string;
  hint: string;
  node: string;
  memories: AgentMemory[];
  agentId: string;
  empty: string;
}) {
  return (
    <section>
      <div className="rule-heavy flex items-baseline justify-between gap-3 pt-3">
        <h2 className="flex items-center gap-2 text-lg">
          <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ background: node }} />
          {title}
        </h2>
        <span className="metric text-2xl font-bold">{memories.length}</span>
      </div>
      <p className="mt-1 text-sm text-[var(--muted)]">{hint}</p>
      {memories.length === 0 ? (
        <p className="inset mt-4 p-4 text-sm text-[var(--muted)]">{empty}</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {memories.map((m) => (
            <MemoryCard key={m.id} memory={m} agentId={agentId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryCard({ memory: m, agentId }: { memory: AgentMemory; agentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "That did not work.");
        setConfirm(false);
        return;
      }
      router.refresh();
    });

  return (
    <li className={`panel p-4 ${pending ? "opacity-60" : ""}`}>
      <div className="mono break-all text-xs font-medium">{m.key}</div>
      {/* Memories are often written hard-wrapped; reflow lines, keep paragraphs. */}
      {m.content.split(/\n\s*\n/).map((para, i) => (
        <p key={i} className="mt-1.5 text-sm leading-relaxed text-[var(--text-soft)]">
          {para.replace(/\s*\n\s*/g, " ")}
        </p>
      ))}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--muted)]">
          Updated{" "}
          {new Date(m.updatedAt).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <div className="flex gap-2">
          {confirm ? (
            <>
              <button
                type="button"
                className="btn min-h-9 border-[var(--danger)] text-[var(--danger)]"
                disabled={pending}
                onClick={() => run(() => forgetMemoryAction(agentId, m.key))}
              >
                Forget it
              </button>
              <button type="button" className="btn min-h-9" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn min-h-9"
                disabled={pending}
                onClick={() => run(() => setMemoryActiveAction(agentId, m.key, !m.active))}
              >
                {m.active ? "Set aside" : "Load again"}
              </button>
              <button type="button" className="btn min-h-9" disabled={pending} onClick={() => setConfirm(true)}>
                Forget…
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </li>
  );
}
