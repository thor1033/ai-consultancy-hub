"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Handoff, Skill } from "@ai-hub/db";
import { createHandoffAction, deleteHandoffAction, setHandoffEnabledAction } from "../actions";

// What starts when this agent finishes, and what starts it. A hand-off is a
// row: when a run of one agent (any run, or one skill's) finishes, the hub
// starts another with a prompt, as the same person. This panel shows both
// directions and lets a person add one from this agent, switch one off, or
// delete it. The prompt is a template; the placeholders are listed under it.

const PLACEHOLDERS: [string, string][] = [
  ["{{output}}", "the finished run's answer"],
  ["{{sessionId}}", "the finished run's id, for an agent that reads sessions"],
  ["{{prompt}}", "what the finished run was asked"],
  ["{{agentName}}", "the agent that finished"],
  ["{{skillName}}", "the skill it ran, if any"],
];

const DEFAULT_PROMPT = "Hand-off from {{agentName}}. Its answer, in full:\n\n{{output}}\n\nDo your part on this.";

export function HandoffsPanel({
  agentId,
  agentName,
  initial,
  skills,
  agents,
  canManage,
}: {
  agentId: string;
  agentName: string;
  initial: Handoff[];
  skills: Skill[];
  /** Every other agent on the hub. */
  agents: { id: string; slug: string; name: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Handoff[]>(initial);
  const [draft, setDraft] = useState<{ skillId: string; toAgentId: string; prompt: string; note: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const others = agents.filter((a) => a.id !== agentId);
  const outgoing = rows.filter((h) => h.fromAgentId === agentId);
  const incoming = rows.filter((h) => h.toAgentId === agentId);

  const apply = (res: { handoffs: Handoff[] } | { error: string }, done?: string) => {
    if ("error" in res) setMessage({ text: res.error, error: true });
    else {
      setRows(res.handoffs);
      setMessage(done ? { text: done, error: false } : null);
      setDraft(null);
      router.refresh();
    }
  };

  function Row({ h, direction }: { h: Handoff; direction: "out" | "in" }) {
    const other = direction === "out" ? { slug: h.toAgentSlug, name: h.toAgentName } : { slug: h.fromAgentSlug, name: h.fromAgentName };
    return (
      <li className={`border-t border-[var(--border)] py-3 ${h.enabled ? "" : "opacity-60"}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="min-w-0 text-sm">
            {direction === "out" ? (
              <>
                When {h.skillName ? <>it finishes <span className="font-medium">{h.skillName}</span></> : "any run of it finishes"}, start{" "}
                <Link href={`/agents/${other.slug}`} className="font-medium underline-offset-2 hover:underline">
                  {other.name}
                </Link>
              </>
            ) : (
              <>
                Started when{" "}
                <Link href={`/agents/${other.slug}`} className="font-medium underline-offset-2 hover:underline">
                  {other.name}
                </Link>{" "}
                finishes {h.skillName ? <span className="font-medium">{h.skillName}</span> : "any run"}
              </>
            )}
            {!h.toAgentEnabled && <span className="text-[var(--warning)]"> · {h.toAgentName} is switched off</span>}
            {!h.enabled && <span className="text-[var(--muted)]"> · off</span>}
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                disabled={pending}
                className="btn min-h-9"
                onClick={() => start(async () => apply(await setHandoffEnabledAction(h.id, agentId, !h.enabled), h.enabled ? "Switched off." : "Switched on."))}
              >
                {h.enabled ? "Switch off" : "Switch on"}
              </button>
              {confirmDelete === h.id ? (
                <>
                  <button type="button" disabled={pending} className="btn min-h-9 border-[var(--danger)] text-[var(--danger)]" onClick={() => start(async () => apply(await deleteHandoffAction(h.id, agentId), "Deleted."))}>
                    Delete
                  </button>
                  <button type="button" className="btn min-h-9" onClick={() => setConfirmDelete(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="btn min-h-9" onClick={() => setConfirmDelete(h.id)}>
                  Delete…
                </button>
              )}
            </div>
          )}
        </div>
        {h.note && <p className="mt-1 text-xs text-[var(--text-soft)]">{h.note}</p>}
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">The prompt it starts with</summary>
          <pre className="inset mono mt-1 max-h-56 overflow-auto whitespace-pre-wrap p-3 text-xs">{h.prompt}</pre>
        </details>
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="panel p-5 md:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="eyebrow">When it finishes</div>
            <p className="mt-1 text-xs text-[var(--muted)]">The agents the hub starts after a run of {agentName}, as the same person, with its answer.</p>
          </div>
          {canManage && !draft && others.length > 0 && (
            <button type="button" className="btn min-h-9" onClick={() => setDraft({ skillId: "", toAgentId: others[0].id, prompt: DEFAULT_PROMPT, note: "" })}>
              Add a hand-off
            </button>
          )}
        </div>
        {outgoing.length === 0 && !draft && <p className="mt-3 text-sm text-[var(--muted)]">None. A finished run of {agentName} starts nothing.</p>}
        {outgoing.length > 0 && (
          <ul className="mt-3 flex flex-col">
            {outgoing.map((h) => (
              <Row key={h.id} h={h} direction="out" />
            ))}
          </ul>
        )}
        {draft && (
          <form
            className="mt-4 border-t border-[var(--border)] pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () =>
                apply(await createHandoffAction({ fromAgentId: agentId, skillId: draft.skillId || null, toAgentId: draft.toAgentId, prompt: draft.prompt, note: draft.note }), "Hand-off added."),
              );
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--muted)]">After</span>
                <select className="field" value={draft.skillId} onChange={(e) => setDraft({ ...draft, skillId: e.target.value })}>
                  <option value="">Any run of {agentName}</option>
                  {skills.map((s) => (
                    <option key={s.id} value={s.id}>
                      A run of {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--muted)]">Start</span>
                <select className="field" value={draft.toAgentId} onChange={(e) => setDraft({ ...draft, toAgentId: e.target.value })}>
                  {others.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs text-[var(--muted)]">With this prompt</span>
              <textarea className="field mono min-h-32" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
              <span className="mt-1 block text-xs text-[var(--muted)]">
                {PLACEHOLDERS.map(([k, what], i) => (
                  <span key={k}>
                    {i > 0 && " · "}
                    <span className="mono">{k}</span> {what}
                  </span>
                ))}
              </span>
            </label>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs text-[var(--muted)]">What the finished run&apos;s answer says the next agent does (optional)</span>
              <input className="field" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="it checks the list against the board" />
            </label>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="submit" disabled={pending} className="btn-brand min-h-11">
                {pending ? "Saving…" : "Add hand-off"}
              </button>
              <button type="button" className="btn min-h-11" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {message && <p className={`mt-3 text-sm ${message.error ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{message.text}</p>}
      </section>

      <section className="panel p-5 md:p-6">
        <div className="eyebrow">What starts it</div>
        <p className="mt-1 text-xs text-[var(--muted)]">Runs of other agents whose finish starts {agentName}.</p>
        {incoming.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">None. {agentName} is started by people, clients, its schedules, or an agent that asks it.</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {incoming.map((h) => (
              <Row key={h.id} h={h} direction="in" />
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-[var(--muted)]">
        A hand-off fires only after the finished run is recorded, and at most two hand-offs deep from a person&apos;s or the clock&apos;s run. Every
        hand-off, made or refused, is said at the end of the finished run&apos;s answer.
      </p>
    </div>
  );
}
