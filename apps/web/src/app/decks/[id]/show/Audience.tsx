"use client";

import { useEffect, useRef, useState } from "react";
import type { Deck } from "@ai-hub/db";
import { SlideFrame } from "@/components/slides/SlideFrame";
import { setPositionAction } from "../../actions";
import { liveSlides, navKey, useLiveDeck, usePositionChannel } from "../../live";

/*
 * What the room sees: the slide, nothing else. Never a slide from the tray.
 *
 * While the deck is being presented it follows the presenter. A clicker
 * pointed at this window still works, and moves the presenter's view too.
 * Not presenting, it is a plain slideshow with the arrow keys.
 */
export function Audience({ initial }: { initial: Deck }) {
  const { deck, online, refresh } = useLiveDeck(initial);
  const slides = liveSlides(deck);
  const [pos, setPos] = useState<string | null>(initial.position);
  const post = usePositionChannel(deck.id, (m) => {
    setPos(m.slideId);
    // "Show now" on a slide that was in the tray a moment ago: this window
    // has not fetched it yet, so fetch now instead of at the next tick.
    if (!slides.some((s) => s.id === m.slideId)) refresh();
  });
  const shown = useRef<string | null>(null);
  const serverPos = useRef(initial.position);
  const [hint, setHint] = useState(true);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (deck.position !== serverPos.current) {
      serverPos.current = deck.position;
      if (deck.position && deck.presenting) setPos(deck.position);
    }
  }, [deck.position, deck.presenting]);

  // The slide asked for, or — while it is still on its way — the one already
  // on screen. Never a jump back to the first slide in front of the room.
  const wanted = slides.findIndex((s) => s.id === pos);
  const kept = slides.findIndex((s) => s.id === shown.current);
  const index = wanted >= 0 ? wanted : kept >= 0 ? kept : 0;
  const current = slides[index];
  shown.current = current?.id ?? null;

  function go(slideId: string | undefined) {
    if (!slideId) return;
    setPos(slideId);
    post(slideId);
    if (deck.presenting) {
      serverPos.current = slideId;
      void setPositionAction(deck.id, slideId);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
        return;
      }
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

  // The hint fades, and the pointer hides when it is not moving.
  useEffect(() => {
    const t = setTimeout(() => setHint(false), 4000);
    let idleTimer = setTimeout(() => setIdle(true), 2500);
    const move = () => {
      setIdle(false);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setIdle(true), 2500);
    };
    window.addEventListener("mousemove", move);
    return () => {
      clearTimeout(t);
      clearTimeout(idleTimer);
      window.removeEventListener("mousemove", move);
    };
  }, []);

  return (
    <div className={`fixed inset-0 z-[60] flex items-center justify-center bg-black ${idle ? "cursor-none" : ""}`}>
      {current ? (
        <div style={{ width: "min(100vw, calc(100vh * 16 / 9))" }}>
          <SlideFrame slide={current} deckTitle={deck.title} number={index + 1} total={slides.length} />
        </div>
      ) : (
        <p className="text-sm text-white/60">This deck has no slides yet.</p>
      )}
      <div
        className={`pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/70 px-3 py-1.5 text-xs text-white/80 transition-opacity duration-700 ${hint || !online ? "opacity-100" : "opacity-0"}`}
      >
        {online ? "F for full screen · ← → to move" : "Reconnecting… the slide on screen stays put"}
      </div>
    </div>
  );
}
