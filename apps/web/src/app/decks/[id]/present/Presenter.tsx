"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import type { Deck } from "@ai-hub/db";
import { SlideFrame } from "@/components/slides/SlideFrame";
import { setPositionAction, setPresentingAction } from "../../actions";
import { liveSlides, navKey, useLiveDeck, usePositionChannel } from "../../live";
import { AgentTag, AskBox, Sources, Tray } from "../../parts";

/*
 * The presenter view: the slide on screen, what comes next, the notes, and
 * the tray. Full screen over the hub's chrome, because it is meant for the
 * presenter's own monitor while the audience window is shared.
 *
 * Moving here moves every audience view: at once for windows in this
 * browser (BroadcastChannel), and through the database for everything else
 * once "Start presenting" is on.
 */
export function Presenter({ initial }: { initial: Deck }) {
  const { deck, online, apply } = useLiveDeck(initial);
  const slides = liveSlides(deck);
  const [pos, setPos] = useState<string | null>(() => {
    const live = liveSlides(initial);
    return live.some((s) => s.id === initial.position) ? initial.position : (live[0]?.id ?? null);
  });
  const [startedAt, setStartedAt] = useState<number | null>(initial.presenting ? Date.now() : null);
  const [now, setNow] = useState(Date.now());
  const [busy, start] = useTransition();
  const post = usePositionChannel(deck.id, (m) => setPos(m.slideId));
  const serverPos = useRef(initial.position);

  // Another device moved the presentation: follow it. Only a change in the
  // stored position counts, so a poll that read the database just before our
  // own write landed does not drag the presenter back a slide.
  useEffect(() => {
    if (deck.position !== serverPos.current) {
      serverPos.current = deck.position;
      if (deck.position && deck.presenting) setPos(deck.position);
    }
  }, [deck.position, deck.presenting]);

  // The slide asked for; while it is still on its way from another device,
  // the one already shown; only failing both, the first.
  const shown = useRef<string | null>(null);
  const wanted = slides.findIndex((s) => s.id === pos);
  const kept = slides.findIndex((s) => s.id === shown.current);
  const index = wanted >= 0 ? wanted : kept >= 0 ? kept : 0;
  const current = slides[index];
  shown.current = current?.id ?? null;
  const next = slides[index + 1];

  function go(slideId: string | undefined) {
    if (!slideId || slideId === current?.id) return;
    setPos(slideId);
    post(slideId);
    if (deck.presenting) {
      serverPos.current = slideId;
      void setPositionAction(deck.id, slideId);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = navKey(e);
      if (!k) return;
      e.preventDefault();
      if (k === "next") go(slides[index + 1]?.id);
      if (k === "prev") go(slides[index - 1]?.id);
      if (k === "first") go(slides[0]?.id);
      if (k === "last") go(slides.at(-1)?.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  function togglePresenting() {
    const on = !deck.presenting;
    start(async () => {
      const res = await setPresentingAction(deck.id, on);
      if ("error" in res) return;
      apply(res.deck);
      if (on) {
        setStartedAt(Date.now());
        if (current) {
          serverPos.current = current.id;
          await setPositionAction(deck.id, current.id);
        }
      } else setStartedAt(null);
    });
  }

  function openAudience() {
    window.open(`/decks/${deck.id}/show`, `deck-${deck.id}`, "popup,width=1280,height=760");
    if (current) setTimeout(() => post(current.id), 1200);
  }

  const elapsed = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const notes = typeof current?.notes === "string" ? current.notes : "";

  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[var(--bg)]">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5">
        <Link href={`/decks/${deck.id}`} className="text-xs text-[var(--muted)] hover:text-[var(--brand)]">
          ← Deck
        </Link>
        <span className="min-w-0 flex-1 truncate font-medium">{deck.title}</span>
        <span className="mono text-sm">
          {slides.length ? index + 1 : 0} / {slides.length}
        </span>
        <span className={`mono text-sm ${startedAt ? "" : "text-[var(--muted)]"}`}>{clock}</span>
        {!online && <span className="text-xs text-[var(--danger)]">Reconnecting…</span>}
        <button type="button" className="btn min-h-9 text-xs" onClick={openAudience}>
          Open audience window
        </button>
        <button type="button" className={`${deck.presenting ? "btn" : "btn-brand"} min-h-9 text-xs`} disabled={busy} onClick={togglePresenting}>
          {deck.presenting ? "Stop presenting" : "Start presenting"}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 overflow-auto p-4 lg:grid-cols-[minmax(0,1fr)_23rem] lg:overflow-hidden">
        <main className="flex min-h-0 flex-col gap-3">
          <div className="mx-auto w-full" style={{ maxWidth: "calc((100vh - 17rem) * 16 / 9)" }}>
            {current ? (
              <div className="relative shadow-[var(--shadow-print)]">
                <SlideFrame slide={current} deckTitle={deck.title} number={index + 1} total={slides.length} />
                <AgentTag slide={current} />
              </div>
            ) : (
              <div className="panel p-8 text-sm text-[var(--muted)]">This deck has no slides yet.</div>
            )}
          </div>
          <div className="flex items-center justify-center gap-2">
            <button type="button" className="btn min-h-10 px-5" disabled={index === 0} onClick={() => go(slides[index - 1]?.id)}>
              ← Previous
            </button>
            <button type="button" className="btn-brand min-h-10 px-5" disabled={index >= slides.length - 1} onClick={() => go(slides[index + 1]?.id)}>
              Next →
            </button>
          </div>
          <div className="grid min-h-0 gap-4 overflow-auto md:grid-cols-[minmax(0,1fr)_16rem]">
            <div>
              <div className="eyebrow mb-1">Notes</div>
              <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed text-[var(--text-soft)]">{notes || "No notes on this slide."}</p>
            </div>
            <Sources slide={current} />
          </div>
          <nav aria-label="Slides" className="flex gap-2 overflow-x-auto border-t border-[var(--border)] pt-3">
            {slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go(s.id)}
                className={`w-36 shrink-0 border-2 p-0 text-left ${s.id === current?.id ? "border-[var(--brand)]" : "border-transparent hover:border-[var(--border-strong)]"}`}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={s.id === current?.id}
              >
                <SlideFrame slide={s} number={i + 1} />
              </button>
            ))}
          </nav>
        </main>

        <aside className="flex min-h-0 flex-col gap-4 overflow-auto">
          <div>
            <div className="eyebrow mb-2">Next</div>
            {next ? <SlideFrame slide={next} deckTitle={deck.title} number={index + 2} total={slides.length} /> : <p className="text-xs text-[var(--muted)]">End of the deck.</p>}
          </div>
          <div className="panel p-3">
            <AskBox deckId={deck.id} onDeck={apply} compact />
          </div>
          <div className="panel p-3">
            <Tray
              deck={deck}
              onDeck={apply}
              presenting={deck.presenting}
              onShown={(id) => {
                setPos(id);
                post(id);
                serverPos.current = id;
              }}
            />
          </div>
          {!deck.presenting && (
            <p className="text-xs text-[var(--muted)]">
              Start presenting to move audience views on other devices too, and to send agents&apos; new slides to the tray
              instead of the deck.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
