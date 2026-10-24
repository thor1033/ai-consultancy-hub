"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Deck, StoredSlide } from "@ai-hub/db";

/*
 * Keeping a deck view current.
 *
 * Two paths, because they solve different problems:
 *
 *  - The database, polled about once a second, is the truth: it carries new
 *    slides, edits and the position to every device, and works on every Fly
 *    machine because it is just a read.
 *  - A BroadcastChannel carries the position between windows of the same
 *    browser instantly. The common setup is the presenter view on the laptop
 *    and the audience window shared into Teams from the same laptop; a
 *    clicker press should move the shared window now, not a second later.
 */

export function useLiveDeck(initial: Deck) {
  const [deck, setDeck] = useState(initial);
  const [online, setOnline] = useState(true);
  const version = useRef(initial.version);

  const apply = useCallback((d: Deck) => {
    if (d.version >= version.current) {
      version.current = d.version;
      setDeck(d);
    }
  }, []);

  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      clearTimeout(timer);
      try {
        const r = await fetch(`/decks/${initial.id}/state?since=${version.current}`, { cache: "no-store" });
        if (r.ok && r.headers.get("content-type")?.includes("json")) {
          const j = (await r.json()) as { version: number; deck?: Deck };
          if (j.deck) apply(j.deck);
          setOnline(true);
        } else setOnline(false);
      } catch {
        setOnline(false);
      }
      // A background tab polls rarely; it catches up the moment it is shown.
      if (!stopped) timer = setTimeout(tick, document.hidden ? 5000 : 900);
    };
    tick();
    poke.current = () => void tick();
    const wake = () => !document.hidden && tick();
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [initial.id, apply]);

  /** Poll now rather than at the next tick: told about a slide we do not have yet. */
  const refresh = useCallback(() => poke.current(), []);

  return { deck, online, apply, refresh };
}

export type PositionMessage = { type: "position"; slideId: string; at: number };

/** Post and receive the on-screen slide between this browser's windows. */
export function usePositionChannel(deckId: string, onMessage?: (m: PositionMessage) => void) {
  const channel = useRef<BroadcastChannel | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(`deck-${deckId}`);
    ch.onmessage = (e) => {
      const m = e.data as PositionMessage;
      if (m?.type === "position" && typeof m.slideId === "string") handler.current?.(m);
    };
    channel.current = ch;
    return () => ch.close();
  }, [deckId]);

  return useCallback((slideId: string) => {
    channel.current?.postMessage({ type: "position", slideId, at: Date.now() } satisfies PositionMessage);
  }, []);
}

export const liveSlides = (d: Deck): StoredSlide[] => d.slides.filter((s) => s.status === "live");
export const pendingSlides = (d: Deck): StoredSlide[] => d.slides.filter((s) => s.status === "pending");

/** Next / previous / first / last keys, the way presentation clickers send them. */
export function navKey(e: KeyboardEvent): "next" | "prev" | "first" | "last" | null {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}
