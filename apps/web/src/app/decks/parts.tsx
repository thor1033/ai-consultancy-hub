"use client";

import { useState, useTransition } from "react";
import type { Deck, StoredSlide } from "@ai-hub/db";
import { SlideFrame } from "@/components/slides/SlideFrame";
import { acceptSlideAction, askAction, discardSlideAction } from "./actions";

// Pieces the deck page and the presenter view share: the question box and the
// tray it fills.

type Reply = { deck: Deck } | { error: string };

export function AskBox({
  deckId,
  onDeck,
  compact = false,
}: {
  deckId: string;
  onDeck: (d: Deck) => void;
  compact?: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function ask() {
    const q = question.trim();
    if (!q || pending) return;
    setMessage(null);
    start(async () => {
      const res = await askAction(deckId, q);
      if ("error" in res) setMessage({ text: res.error, error: true });
      else {
        onDeck(res.deck);
        setQuestion("");
        setMessage({ text: "Drafted. It is in the tray, not on screen.", error: false });
      }
    });
  }

  return (
    <div>
      <label className="block">
        <span className="eyebrow mb-2 block">Question from the room</span>
        <textarea
          className={`field w-full resize-y text-sm ${compact ? "min-h-16" : "min-h-20"}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
          }}
          placeholder="What would it cost to roll this out to the Oslo office?"
          disabled={pending}
        />
      </label>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" className="btn-brand min-h-10" onClick={ask} disabled={pending || !question.trim()}>
          {pending ? "Drafting…" : "Draft a slide"}
        </button>
        {pending && (
          <span className="flex items-center gap-2 text-xs text-[var(--muted)]" role="status">
            <span aria-hidden className="ctx-blink inline-block h-2 w-2 bg-[var(--ai)]" />
            Reading the deck and its knowledge
          </span>
        )}
      </div>
      {message && (
        <p role={message.error ? "alert" : "status"} className={`mt-2 text-xs ${message.error ? "text-[var(--danger)]" : "text-[var(--ai)]"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

export function Tray({
  deck,
  onDeck,
  onShown,
  presenting,
}: {
  deck: Deck;
  onDeck: (d: Deck) => void;
  /** Called with the slide's id when "Show now" put it on screen. */
  onShown?: (slideId: string) => void;
  presenting: boolean;
}) {
  const waiting = deck.slides.filter((s) => s.status === "pending");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<Reply>, then?: () => void) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if ("error" in res) setError(res.error);
      else {
        onDeck(res.deck);
        then?.();
      }
    });

  return (
    <div>
      <div className="eyebrow mb-2">Incoming · {waiting.length}</div>
      {waiting.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          Slides drafted from a question, or added by an agent while you present, wait here. Nothing in the tray is on
          screen.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {waiting.map((s) => (
            <TrayCard key={s.id} slide={s} deckTitle={deck.title}>
              {presenting && (
                <button type="button" className="btn-brand min-h-9 text-xs" disabled={busy} onClick={() => run(() => acceptSlideAction(deck.id, s.id, true), () => onShown?.(s.id))}>
                  Show now
                </button>
              )}
              <button type="button" className="btn min-h-9 text-xs" disabled={busy} onClick={() => run(() => acceptSlideAction(deck.id, s.id, false))}>
                {presenting ? "Add after current" : "Add to deck"}
              </button>
              <button type="button" className="btn min-h-9 text-xs" disabled={busy} onClick={() => run(() => discardSlideAction(deck.id, s.id))}>
                Discard
              </button>
            </TrayCard>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

function TrayCard({ slide, deckTitle, children }: { slide: StoredSlide; deckTitle: string; children: React.ReactNode }) {
  const notes = typeof slide.notes === "string" ? slide.notes : "";
  return (
    <li className="border border-[var(--ai)] bg-[var(--panel)] p-2">
      <div className="relative">
        <SlideFrame slide={slide} deckTitle={deckTitle} />
        <AgentTag slide={slide} />
      </div>
      {notes && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-[var(--text-soft)]">{notes}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">{children}</div>
    </li>
  );
}

/** Blue is the AI layer: a slide an agent wrote says so, to the presenter only. */
export function AgentTag({ slide }: { slide: StoredSlide }) {
  if (slide.by !== "agent") return null;
  return (
    <span className="absolute right-1.5 top-1.5 bg-[var(--ai)] px-1.5 py-0.5 text-[0.62rem] font-medium uppercase tracking-[0.14em] text-white">
      Agent
    </span>
  );
}

export function Sources({ slide }: { slide: StoredSlide | undefined }) {
  const sources = Array.isArray(slide?.sources) ? (slide!.sources as string[]) : [];
  if (!sources.length) return null;
  return (
    <div>
      <div className="eyebrow mb-1">Sources</div>
      <ul className="list-[square] pl-4 text-xs text-[var(--text-soft)]">
        {sources.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
