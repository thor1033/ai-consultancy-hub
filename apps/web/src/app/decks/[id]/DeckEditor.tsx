"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { Deck, StoredSlide } from "@ai-hub/db";
import { SlideFrame } from "@/components/slides/SlideFrame";
import { addSlideJsonAction, deleteDeckAction, moveSlideAction, removeSlideAction, renameDeckAction, updateSlideJsonAction } from "../actions";
import { liveSlides, useLiveDeck } from "../live";
import { AgentTag, AskBox, Tray } from "../parts";

// A deck between presentations: its slides in order, the tray, and the ways
// in — the question box, a slide as JSON, or Claude Code with the deck's id.

// The slide as its author wrote it: the bookkeeping fields are the deck's.
const BOOKKEEPING = new Set(["id", "status", "by", "createdAt", "after"]);
const contentOf = (s: StoredSlide) => Object.fromEntries(Object.entries(s).filter(([k]) => !BOOKKEEPING.has(k)));

export function DeckEditor({ initial, canDelete, spec }: { initial: Deck; canDelete: boolean; spec: string }) {
  const { deck, online, apply } = useLiveDeck(initial);
  const slides = liveSlides(deck);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(deck.title);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const act = (fn: () => Promise<{ deck: Deck } | { error: string }>, then?: () => void) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if ("error" in res) setError(res.error);
      else {
        apply(res.deck);
        then?.();
      }
    });

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="eyebrow mb-2">
            <Link href="/decks" className="hover:text-[var(--brand)]">
              Decks
            </Link>
            {deck.collection && <span> · {deck.collection}</span>}
            {!online && <span className="text-[var(--danger)]"> · reconnecting</span>}
          </div>
          <input
            className="w-full bg-transparent text-2xl font-bold tracking-tight outline-none md:text-3xl"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== deck.title && act(() => renameDeckAction(deck.id, title))}
            aria-label="Deck title"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/decks/${deck.id}/present`} className="btn-brand min-h-10">
            Present
          </Link>
          <a href={`/decks/${deck.id}/show`} target={`deck-${deck.id}`} className="btn min-h-10">
            Audience view
          </a>
          <a href={`/decks/${deck.id}/print`} target="_blank" rel="noopener" className="btn min-h-10">
            PDF
          </a>
          {canDelete &&
            (confirmDelete ? (
              <>
                <button type="button" className="btn-brand min-h-10" disabled={busy} onClick={() => start(async () => {
                  const res = await deleteDeckAction(deck.id);
                  if (res?.error) setError(res.error);
                })}>
                  Yes, delete it
                </button>
                <button type="button" className="btn min-h-10" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn min-h-10" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            ))}
        </div>
      </header>

      {error && (
        <div role="alert" className="notice-danger mb-4 border border-[var(--danger)] p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {deck.presenting && (
        <div className="panel mb-4 p-3 text-sm text-[var(--brand)]">
          Being presented now. Agents&apos; changes go to the tray until the presentation stops.
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section>
          <ol className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {slides.map((s, i) => (
              <li key={s.id} className="panel p-2">
                <div className="relative">
                  <SlideFrame slide={s} deckTitle={deck.title} number={i + 1} total={slides.length} />
                  <AgentTag slide={s} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="mono mr-auto text-[var(--muted)]">
                    {i + 1} · {s.kind} · {s.id}
                  </span>
                  <button type="button" className="btn min-h-8 px-2" disabled={busy || i === 0} onClick={() => act(() => moveSlideAction(deck.id, s.id, "up"))} aria-label="Move earlier">
                    ↑
                  </button>
                  <button type="button" className="btn min-h-8 px-2" disabled={busy || i === slides.length - 1} onClick={() => act(() => moveSlideAction(deck.id, s.id, "down"))} aria-label="Move later">
                    ↓
                  </button>
                  <button type="button" className="btn min-h-8 px-2" onClick={() => setEditing(editing === s.id ? null : s.id)}>
                    Edit
                  </button>
                  <button type="button" className="btn min-h-8 px-2" disabled={busy || slides.length <= 1} onClick={() => act(() => removeSlideAction(deck.id, s.id))}>
                    Remove
                  </button>
                </div>
                {editing === s.id && (
                  <JsonEditor
                    initial={JSON.stringify(contentOf(s), null, 2)}
                    busy={busy}
                    label="Save slide"
                    onCancel={() => setEditing(null)}
                    onSave={(json) => act(() => updateSlideJsonAction(deck.id, s.id, json), () => setEditing(null))}
                  />
                )}
              </li>
            ))}
          </ol>

          <div className="mt-4">
            {adding ? (
              <div className="panel p-4">
                <div className="eyebrow mb-2">Add a slide at the end</div>
                <JsonEditor
                  initial={JSON.stringify({ kind: "bullets", title: "", bullets: [""] }, null, 2)}
                  busy={busy}
                  label="Add slide"
                  onCancel={() => setAdding(false)}
                  onSave={(json) => act(() => addSlideJsonAction(deck.id, json, slides.at(-1)?.id ?? null), () => setAdding(false))}
                />
                <details className="mt-3 text-xs text-[var(--muted)]">
                  <summary className="cursor-pointer">The slide kinds</summary>
                  <pre className="mt-2 whitespace-pre-wrap">{spec}</pre>
                </details>
              </div>
            ) : (
              <button type="button" className="btn min-h-10" onClick={() => setAdding(true)}>
                Add a slide as JSON
              </button>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <div className="panel p-4">
            <AskBox deckId={deck.id} onDeck={apply} />
          </div>
          <div className="panel p-4">
            <Tray deck={deck} onDeck={apply} presenting={deck.presenting} />
          </div>
          <div className="panel p-4 text-xs text-[var(--muted)]">
            <div className="eyebrow mb-2">From Claude Code</div>
            Ask Claude to work on deck <span className="mono text-[var(--text)]">{deck.id}</span>. It uses the hub&apos;s
            <span className="mono"> hub_deck_*</span> tools, and the changes appear here as they are made.
          </div>
        </aside>
      </div>
    </div>
  );
}

function JsonEditor({
  initial,
  busy,
  label,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  label: string;
  onSave: (json: string) => void;
  onCancel: () => void;
}) {
  const [json, setJson] = useState(initial);
  return (
    <div className="mt-2">
      <textarea className="field mono min-h-48 w-full text-xs leading-relaxed" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-brand min-h-9 text-xs" disabled={busy} onClick={() => onSave(json)}>
          {busy ? "Saving…" : label}
        </button>
        <button type="button" className="btn min-h-9 text-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
