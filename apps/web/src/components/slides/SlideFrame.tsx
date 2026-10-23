"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Slide, type SlideData } from "./Slide";

/**
 * A slide scaled to whatever box it is given, keeping 16:9.
 *
 * The slide is laid out once at 1280×720 and scaled as a picture, so text
 * wraps the same on a thumbnail, the presenter's screen and the projector:
 * what the presenter previews is exactly what the room sees.
 */
export function SlideFrame({
  slide,
  deckTitle,
  number,
  total,
  className = "",
}: {
  slide: SlideData;
  deckTitle?: string;
  number?: number;
  total?: number;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / 1280);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} className={`relative w-full overflow-hidden ${className}`} style={{ aspectRatio: "16 / 9" }}>
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: 1280, height: 720, transform: `scale(${scale})`, visibility: scale ? "visible" : "hidden" }}
      >
        <Slide slide={slide} deckTitle={deckTitle} number={number} total={total} />
      </div>
    </div>
  );
}
