"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { KnowledgeReadRow, RetentionPolicy, RetentionSweep, SubjectHits } from "@ai-hub/db";
import { erasePersonAction, findSubjectAction, runRetentionNowAction } from "./dataActions";

// People's data (docs/retention.md): how long the hub keeps things, a
// person's export and erasure, and "find everything about a name".

export function DataPanel({
  policy,
  lastSweep,
  people,
  reads,
}: {
  policy: RetentionPolicy;
  lastSweep: { at: string; detail: Record<string, unknown> } | null;
  people: { id: string; email: string | null; name: string }[];
  reads: KnowledgeReadRow[];
}) {
  return (
    <div className="space-y-8">
      <Retention policy={policy} lastSweep={lastSweep} />
      <PersonData people={people} />
      <FindSubject />
      <ReadLog reads={reads} days={policy.auditDays} />
    </div>
  );
}

const DOORS: Record<string, string> = {
  run: "an agent's answer",
  chat: "a conversation",
  mcp: "Claude Code",
  page: "the Documents page",
};

// The read log (docs/sensitivity.md): who read material labelled
// confidential or special, and how. Never what they asked.
function ReadLog({ reads, days }: { reads: KnowledgeReadRow[]; days: number }) {
  const [filter, setFilter] = useState("");
  const collections = [...new Set(reads.map((r) => r.collection))].sort();
  const shown = filter ? reads.filter((r) => r.collection === filter) : reads;
  return (
    <Section
      title="Who read confidential material"
      subtitle={`Every time someone read a document in a collection labelled confidential or special — opened it, or was given it in an agent's answer. What they asked is never recorded. Kept ${days} days, like the audit trail.`}
    >
      {reads.length === 0 ? (
        <p className="panel p-4 text-sm text-[var(--muted)]">Nothing yet. Label a collection confidential or special under People and access to start the log.</p>
      ) : (
        <>
          {collections.length > 1 && (
            <label className="mb-3 block max-w-xs">
              <span className="mb-1 block text-xs text-[var(--muted)]">Collection</span>
              <select className="field" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">All</option>
                {collections.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ul className="panel divide-y divide-[var(--border)]">
            {shown.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="font-medium">{r.who ?? "Someone no longer here"}</span>
                <span className="text-[var(--text-soft)]">
                  read {r.document ? `“${r.document}”` : "a document since removed"} in {r.collection}
                </span>
                <span className="text-xs text-[var(--muted)]">
                  through {DOORS[r.door] ?? r.door} ·{" "}
                  {new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {r.sensitivity === "special" ? " · special category" : ""}
                </span>
                {r.runId && (
                  <a className="text-xs underline" href={`/runs/${r.runId}`}>
                    the run
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm text-[var(--muted)]">{subtitle}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Retention({ policy, lastSweep }: { policy: RetentionPolicy; lastSweep: { at: string; detail: Record<string, unknown> } | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<RetentionSweep | string | null>(null);
  const rows: [string, string][] = [
    ["A conversation's full record — every message, and everything its tools read", `${policy.transcriptsDays} days`],
    ["What was asked and what came back", `${policy.answersDays} days`],
    ["What an agent wanted to change, once decided", `${policy.answersDays} days after the decision`],
    ["The audit trail", `${policy.auditDays} days`],
  ];
  return (
    <Section
      title="How long the hub keeps things"
      subtitle="After these, the words are removed and only the numbers stay — which agent, which tools, cost and timing. The clean-up runs every six hours; documents and memories stay until someone removes them."
    >
      <dl className="panel divide-y divide-[var(--border)]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
            <dt className="text-[var(--text-soft)]">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          className="btn min-h-10"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const out = await runRetentionNowAction();
              setResult("error" in out ? out.error : out.sweep);
              router.refresh();
            })
          }
        >
          {pending ? "Cleaning up…" : "Run the clean-up now"}
        </button>
        <span className="text-[var(--muted)]">
          {typeof result === "string"
            ? result
            : result
              ? `Done: ${result.answersExpired} answers and ${result.transcriptsDropped} conversation records removed, ${result.proposalsExpired} decided changes cleared, ${result.auditDeleted} old audit entries and ${result.readsDeleted} old read-log entries deleted.`
              : lastSweep
                ? `Last ran ${new Date(lastSweep.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`
                : "Not run yet."}
        </span>
      </div>
    </Section>
  );
}

function PersonData({ people }: { people: { id: string; email: string | null; name: string }[] }) {
  const router = useRouter();
  const [who, setWho] = useState(people[0]?.id ?? "");
  const [erasing, setErasing] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const person = people.find((p) => p.id === who);
  return (
    <Section
      title="A person's data"
      subtitle="Download everything the hub holds about someone as a user — what they asked and were answered, their memories, schedules, decks and audit trail — or erase it. Erasing removes their conversations, their own memories and their access; shared knowledge they added stays, no longer linked to them."
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-64">
          <span className="mb-1 block text-xs text-[var(--muted)]">Person</span>
          <select
            className="field"
            value={who}
            onChange={(e) => {
              setWho(e.target.value);
              setErasing(false);
              setMessage(null);
            }}
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.email || p.id}
                {p.email && p.name ? ` — ${p.email}` : ""}
              </option>
            ))}
          </select>
        </label>
        {who && (
          <a className="btn min-h-11" href={`/settings/export?principal=${encodeURIComponent(who)}`}>
            Download their data
          </a>
        )}
        {who && !erasing && (
          <button type="button" className="btn min-h-11 border-[var(--danger)] text-[var(--danger)]" onClick={() => setErasing(true)}>
            Erase…
          </button>
        )}
      </div>
      {erasing && person && (
        <form
          className="panel notice-danger mt-3 max-w-xl p-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const out = await erasePersonAction(person.id, confirm);
              if ("error" in out) setMessage(out.error);
              else {
                setMessage(
                  `Erased: ${out.erased.runs} conversations, ${out.erased.memories} personal memories, and their access. ${out.erased.memoriesUnattributed} shared memories they added are no longer linked to them.`,
                );
                setErasing(false);
                setConfirm("");
                router.refresh();
              }
            });
          }}
        >
          <p>
            This cannot be undone. Type <strong>{person.email ?? person.id}</strong> to erase {person.name || "this person"}.
          </p>
          <input className="field mt-2" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          <div className="mt-3 flex gap-2">
            <button type="submit" className="btn min-h-10 border-[var(--danger)] text-[var(--danger)]" disabled={pending || !confirm}>
              {pending ? "Erasing…" : "Erase everything"}
            </button>
            <button type="button" className="btn min-h-10" onClick={() => setErasing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && <p className="mt-2 text-sm text-[var(--text-soft)]">{message}</p>}
    </Section>
  );
}

function FindSubject() {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SubjectHits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const groups: [string, number, string[]][] = hits
    ? [
        ["Conversations", hits.runs.length, hits.runs.map((r) => `${new Date(r.at).toLocaleDateString("en-GB")} · ${r.agent ?? "workbench"} · in the ${r.where}`)],
        ["Memories", hits.memories.length, hits.memories.map((m) => `${m.agent ?? "?"} · ${m.key} · ${m.keptFor}`)],
        ["Documents", hits.documents.length, hits.documents.map((d) => `${d.title}${d.collection ? ` · ${d.collection}` : ""}`)],
        ["Proposed changes", hits.proposals.length, hits.proposals.map((p) => `${p.tool} · ${p.status}`)],
        ["Decks", hits.decks.length, hits.decks.map((d) => d.title)],
        ["People", hits.people.length, hits.people.map((p) => p.displayName || p.email || p.id)],
      ]
    : [];
  return (
    <Section
      title="Find everything about a name"
      subtitle="For a request about someone who may never have used the hub — a client's employee named in a meeting, say. Searches conversations, memories, documents, proposed changes and decks. Each search is on the audit trail."
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const out = await findSubjectAction(term);
            if ("error" in out) {
              setError(out.error);
              setHits(null);
            } else {
              setError(null);
              setHits(out.hits);
            }
          });
        }}
      >
        <input className="field max-w-sm" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="A name, an email, a phone number" />
        <button type="submit" className="btn min-h-11" disabled={pending || term.trim().length < 3}>
          {pending ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
      {hits && (
        <ul className="mt-3 grid gap-3 md:grid-cols-2">
          {groups.map(([label, n, lines]) => (
            <li key={label} className="panel p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-sm text-[var(--muted)]">{n === 50 ? "50+" : n}</span>
              </div>
              {lines.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-[var(--text-soft)]">
                  {lines.slice(0, 8).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                  {lines.length > 8 && <li className="text-[var(--muted)]">and {lines.length - 8} more</li>}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
