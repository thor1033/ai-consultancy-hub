"use client";

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { LAYOUTS, cssColor, CHART_PALETTE, resolvePalette } from "./preview";

type Palette = ReturnType<typeof resolvePalette>;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const snap = (v: number) => Math.round(v * 20) / 20; // nearest 0.05in
// Round an axis maximum up to a clean value (19 -> 20, 33 -> 40, 2.4 -> 3).
const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.max(step, Math.ceil(v / step) * step);
};

// Resize handles: fractional position within the element box + the edges each moves.
const HANDLES: { mode: string; cx: number; cy: number; cursor: string }[] = [
  { mode: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
  { mode: "n", cx: 0.5, cy: 0, cursor: "ns-resize" },
  { mode: "ne", cx: 1, cy: 0, cursor: "nesw-resize" },
  { mode: "e", cx: 1, cy: 0.5, cursor: "ew-resize" },
  { mode: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
  { mode: "s", cx: 0.5, cy: 1, cursor: "ns-resize" },
  { mode: "sw", cx: 0, cy: 1, cursor: "nesw-resize" },
  { mode: "w", cx: 0, cy: 0.5, cursor: "ew-resize" },
];

// Renders a resolved template (values already substituted) as scaled HTML/SVG.
// When `onSelect` is provided the canvas becomes editable: elements are
// clickable and the selected one is outlined. Uses CSS container-query units
// (cqw) so a slide scales to its column while matching pptxgenjs geometry.

type Any = Record<string, unknown>;
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);

export interface Selection {
  s: number;
  e: number;
}

export function SlidePreview({
  template,
  selected,
  onSelect,
}: {
  template: Any | null;
  selected?: Selection | null;
  onSelect?: (s: number, e: number) => void;
}) {
  const layout = str(template?.layout, "LAYOUT_WIDE");
  const dims = LAYOUTS[layout] ?? LAYOUTS.LAYOUT_WIDE;
  const theme = (template?.theme as Any) ?? {};
  const pal = resolvePalette(theme);
  const slides = Array.isArray(template?.slides) ? (template!.slides as Any[]) : [];

  if (!slides.length) {
    return <div className="text-sm text-[var(--muted)]">This template has no slides.</div>;
  }

  return (
    <div className="space-y-4">
      {slides.map((slide, i) => (
        <div key={i}>
          <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-[var(--muted)]">Slide {i + 1}</div>
          <Slide slide={slide} index={i} dims={dims} themeBg={str(theme.bg)} pal={pal} selected={selected} onSelect={onSelect} />
        </div>
      ))}
    </div>
  );
}

// Single-slide view — the editor canvas and the thumbnail rail both use this.
export function SlideView({
  template,
  index,
  selected,
  onSelect,
  onGeom,
}: {
  template: Any | null;
  index: number;
  selected?: Selection | null;
  onSelect?: (s: number, e: number) => void;
  onGeom?: (s: number, e: number, patch: Record<string, number>) => void;
}) {
  const layout = str(template?.layout, "LAYOUT_WIDE");
  const dims = LAYOUTS[layout] ?? LAYOUTS.LAYOUT_WIDE;
  const theme = (template?.theme as Any) ?? {};
  const pal = resolvePalette(theme);
  const slides = Array.isArray(template?.slides) ? (template!.slides as Any[]) : [];
  const slide = slides[index];
  if (!slide) return null;
  return <Slide slide={slide} index={index} dims={dims} themeBg={str(theme.bg)} pal={pal} selected={selected} onSelect={onSelect} onGeom={onGeom} />;
}

function Slide({
  slide,
  index,
  dims,
  themeBg,
  pal,
  selected,
  onSelect,
  onGeom,
}: {
  slide: Any;
  index: number;
  dims: { w: number; h: number };
  themeBg?: string;
  pal: Palette;
  selected?: Selection | null;
  onSelect?: (s: number, e: number) => void;
  onGeom?: (s: number, e: number, patch: Record<string, number>) => void;
}) {
  const W = dims.w;
  const H = dims.h;
  const bg = cssColor(str(slide.background) || themeBg) ?? "#FFFFFF";
  const elements = Array.isArray(slide.elements) ? (slide.elements as Any[]) : [];
  const editable = !!onSelect;
  const draggable = editable && !!onGeom;

  // --- drag / resize on the canvas ---
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: string; e: number; sx: number; sy: number;
    ox: number; oy: number; ow: number; oh: number; ppi: number;
  } | null>(null);

  function beginDrag(ev: ReactPointerEvent, elIndex: number, mode: string) {
    if (!draggable) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    ev.stopPropagation();
    const el = elements[elIndex];
    drag.current = {
      mode, e: elIndex, sx: ev.clientX, sy: ev.clientY,
      ox: num(el.x), oy: num(el.y), ow: num(el.w), oh: num(el.h),
      ppi: rect.width / W, // pixels per inch (width and height share the aspect ratio)
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    onSelect!(index, elIndex);
  }

  function moveDrag(ev: ReactPointerEvent) {
    const d = drag.current;
    if (!d || !onGeom) return;
    const dx = (ev.clientX - d.sx) / d.ppi;
    const dy = (ev.clientY - d.sy) / d.ppi;
    if (d.mode === "move") {
      onGeom(index, d.e, {
        x: clamp(snap(d.ox + dx), 0, Math.max(0, W - d.ow)),
        y: clamp(snap(d.oy + dy), 0, Math.max(0, H - d.oh)),
      });
      return;
    }
    const MIN = 0.2;
    let { ox: nx, oy: ny, ow: nw, oh: nh } = d;
    if (d.mode.includes("e")) nw = clamp(snap(d.ow + dx), MIN, W - d.ox);
    if (d.mode.includes("s")) nh = clamp(snap(d.oh + dy), MIN, H - d.oy);
    if (d.mode.includes("w")) { const right = d.ox + d.ow; nx = clamp(snap(d.ox + dx), 0, right - MIN); nw = right - nx; }
    if (d.mode.includes("n")) { const bottom = d.oy + d.oh; ny = clamp(snap(d.oy + dy), 0, bottom - MIN); nh = bottom - ny; }
    onGeom(index, d.e, { x: nx, y: ny, w: nw, h: nh });
  }

  function endDrag() { drag.current = null; }
  const dragHandlers = draggable
    ? { onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag }
    : {};

  // 1 inch spans (100 / W) cqw; 1pt = (1/72) inch.
  const pt = (p: number) => `${(p / 72 / W) * 100}cqw`;
  const box = (el: Any) => ({
    position: "absolute" as const,
    left: `${(num(el.x) / W) * 100}%`,
    top: `${(num(el.y) / H) * 100}%`,
    width: `${(num(el.w) / W) * 100}%`,
    height: `${(num(el.h) / H) * 100}%`,
  });

  function content(el: Any) {
    const type = str(el.type);
    if (type === "text") {
      const valign = str(el.valign, "top");
      const fontFace = str(el.fontFace);
      return (
        <div
          style={{
            width: "100%", height: "100%", display: "flex",
            alignItems: valign === "middle" ? "center" : valign === "bottom" ? "flex-end" : "flex-start",
            color: cssColor(str(el.color)) ?? pal.ink,
            fontSize: pt(num(el.fontSize, 16)),
            fontWeight: el.bold ? 700 : 400,
            fontStyle: el.italic ? "italic" : "normal",
            fontFamily: fontFace ? `${fontFace}, serif` : undefined,
            letterSpacing: num(el.charSpacing) ? `${num(el.charSpacing) * 0.05}em` : undefined,
            textAlign: (str(el.align, "left") as "left" | "center" | "right"),
            lineHeight: num(el.lineSpacingMultiple) || 1.15, overflow: "hidden",
          }}
        >
          <span style={{ width: "100%" }}>{str(el.text)}</span>
        </div>
      );
    }
    if (type === "kpi") {
      const accent = cssColor(str(el.color)) ?? pal.accent;
      const align = str(el.align, "left") as "left" | "center" | "right";
      return (
        <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", textAlign: align, overflow: "hidden" }}>
          {!!el.label && (
            <div style={{ fontSize: pt(11), fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: pal.muted, marginBottom: pt(3) }}>{str(el.label)}</div>
          )}
          <div style={{ fontSize: pt(num(el.valueSize, 40)), fontWeight: 700, color: accent, fontFamily: "Georgia, serif", lineHeight: 1 }}>{str(el.value)}</div>
          {!!el.caption && <div style={{ fontSize: pt(11), color: pal.muted, marginTop: pt(3) }}>{str(el.caption)}</div>}
        </div>
      );
    }
    if (type === "shape") {
      if (str(el.shape) === "line") {
        const color = cssColor(str(el.line)) ?? pal.hairline;
        const vertical = num(el.h) > num(el.w);
        const thick = `${Math.max(0.5, num(el.lineWidth, 1))}px`;
        return vertical
          ? <div style={{ position: "absolute", top: 0, left: 0, height: "100%", borderLeft: `${thick} solid ${color}` }} />
          : <div style={{ position: "absolute", top: 0, left: 0, width: "100%", borderTop: `${thick} solid ${color}` }} />;
      }
      return <div style={{ width: "100%", height: "100%", background: cssColor(str(el.fill)) ?? pal.accent, borderRadius: pt(num(el.radius) * 72) }} />;
    }
    if (type === "table") {
      const rows = (Array.isArray(el.rows) ? el.rows : []) as unknown[];
      return (
        <table style={{ width: "100%", height: "100%", borderCollapse: "collapse", fontSize: pt(num(el.fontSize, 12)) }}>
          <tbody>
            {rows.map((r, ri) => {
              const cells = Array.isArray(r) ? r : [r];
              return (
                <tr key={ri}>
                  {cells.map((c, ci) => {
                    const cell: Any = (c && typeof c === "object" && !Array.isArray(c)) ? (c as Any) : { text: c };
                    const opts = (cell.options as Any) ?? {};
                    const fill = (opts.fill as Any)?.color;
                    return (
                      <td key={ci} style={{ border: `1px solid ${pal.hairline}`, padding: `${pt(4)} ${pt(7)}`, fontWeight: opts.bold ? 700 : 400, background: fill ? cssColor(String(fill)) : undefined, color: cssColor(str(opts.color)) ?? pal.ink, textAlign: (str(opts.align, "left") as "left" | "center" | "right") }}>
                        {String(cell.text ?? "")}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }
    if (type === "chart") return <Chart el={el} pal={pal} />;
    if (type === "image") {
      const src = str(el.data) || str(el.path);
      return (
        <div style={{ width: "100%", height: "100%", background: "#F1F5F9", display: "grid", placeItems: "center" }}>
          {src.startsWith("data:") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} />
          ) : (
            <span style={{ fontSize: pt(11), color: "#94A3B8" }}>image</span>
          )}
        </div>
      );
    }
    return null;
  }

  const selIdx = selected?.s === index && (selected?.e ?? -1) >= 0 ? selected!.e : -1;
  const selEl = selIdx >= 0 ? elements[selIdx] : null;
  const selIsLine = !!selEl && str(selEl.type) === "shape" && str(selEl.shape) === "line";

  return (
    <div
      ref={wrapRef}
      className="rounded-lg border border-[var(--border)] shadow-sm"
      style={{ containerType: "size", position: "relative", width: "100%", aspectRatio: `${W} / ${H}`, background: bg }}
      onClick={editable ? () => onSelect!(index, -1) : undefined}
    >
      {elements.map((el, i) => {
        const isSel = i === selIdx;
        // Hairlines carry zero thickness in the model; let them draw outside the box.
        const isLine = str(el.type) === "shape" && str(el.shape) === "line";
        return (
          <div
            key={i}
            onClick={editable ? (ev) => { ev.stopPropagation(); onSelect!(index, i); } : undefined}
            onPointerDown={draggable ? (ev) => beginDrag(ev, i, "move") : undefined}
            {...dragHandlers}
            style={{ ...box(el), cursor: draggable ? "move" : editable ? "pointer" : "default", touchAction: draggable ? "none" : undefined, userSelect: draggable ? "none" : undefined, outline: isSel ? `2px solid ${pal.accent}` : editable ? "1px dashed transparent" : "none", outlineOffset: "1px", overflow: isLine ? "visible" : "hidden" }}
          >
            {content(el)}
          </div>
        );
      })}

      {/* Selection overlay — resize handles for the selected element. The body
          drag is handled by the element itself; this sits above it, non-blocking
          except on the handles. Lines resize via the panel, not handles. */}
      {draggable && selEl && !selIsLine && (
        <div style={{ ...box(selEl), pointerEvents: "none", zIndex: 20 }}>
          {HANDLES.map((h) => (
            <div
              key={h.mode}
              onPointerDown={(ev) => beginDrag(ev, selIdx, h.mode)}
              onClick={(ev) => ev.stopPropagation()}
              {...dragHandlers}
              style={{
                position: "absolute", left: `${h.cx * 100}%`, top: `${h.cy * 100}%`,
                width: 9, height: 9, transform: "translate(-50%, -50%)",
                background: "#fff", border: `1.5px solid ${pal.accent}`, borderRadius: 2,
                boxShadow: "0 1px 2px rgba(0,0,0,0.25)", cursor: h.cursor,
                pointerEvents: "auto", touchAction: "none",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// SVG chart for preview, styled to resemble the native pptx chart across every
// supported type (column/bar/stacked, line, area, pie, doughnut, radar). Not
// pixel-identical to the downloaded .pptx (that carries a real Office chart),
// but professional and close, and driven by the same data model + palette.
function Chart({ el, pal }: { el: Any; pal: Palette }) {
  const kind = str(el.chartType, "bar");
  const horizontal = kind === "bar" && str(el.barDir, "col") === "bar";
  const grouping = str(el.barGrouping, "clustered");
  const stacked = kind === "bar" && (grouping === "stacked" || grouping === "percentStacked");
  const percent = kind === "bar" && grouping === "percentStacked";
  const isCircular = kind === "pie" || kind === "doughnut";
  const isRadar = kind === "radar";
  const isBar = kind === "bar";
  const title = str(el.title);

  const sharedLabels = (Array.isArray(el.labels) ? el.labels : []).map(String);
  const clean = (Array.isArray(el.series) ? (el.series as Any[]) : [])
    .map((s) => ({
      name: str(s.name),
      values: (Array.isArray(s.values) ? s.values : []).map((v: unknown) => num(v)),
      labels: (Array.isArray(s.labels) && s.labels.length ? s.labels : sharedLabels).map(String),
    }))
    .filter((s) => s.values.length);
  const colors = Array.isArray(el.colors) && el.colors.length
    ? (el.colors as string[]).map((c) => cssColor(c)!)
    : CHART_PALETTE;

  if (!clean.length) {
    return <div style={{ display: "grid", placeItems: "center", width: "100%", height: "100%", color: pal.muted, fontSize: "3cqw" }}>chart</div>;
  }

  const ar = Math.max(0.2, num(el.w, 4) / num(el.h, 3));
  const VBH = 100, VBW = 100 * ar, FS = 4.2;
  const font = "'Segoe UI', system-ui, sans-serif";
  const cats = clean[0].labels;
  const n = Math.max(...clean.map((s) => s.values.length));
  const names = clean.map((s, i) => s.name || `Series ${i + 1}`);
  const legendItems = isCircular ? cats.slice(0, clean[0].values.length) : names;
  const showLegend = el.showLegend === false ? false : (isCircular || clean.length > 1);

  const mTop = title ? 9 : 4;
  const legendH = showLegend ? 7 : 0;
  const mBottom = (isCircular || isRadar ? 3 : 8) + legendH;
  const mLeft = isCircular || isRadar ? 4 : horizontal ? 17 : 13;
  const mRight = 4;
  const plotW = VBW - mLeft - mRight;
  const plotH = VBH - mTop - mBottom;

  const Frame = ({ children }: { children: ReactNode }) => (
    <svg viewBox={`0 0 ${VBW} ${VBH}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", fontFamily: font }}>
      {title && <text x={VBW / 2} y={5.8} textAnchor="middle" fontSize={FS + 0.8} fontWeight={600} fill={pal.ink}>{title}</text>}
      {children}
      {showLegend && (
        <g>
          {legendItems.map((nm, i) => {
            const per = VBW / legendItems.length;
            const cx = per * i + per / 2;
            return (
              <g key={i} transform={`translate(${cx - 8}, ${VBH - 3})`}>
                <rect x={0} y={-3.2} width={3.2} height={3.2} rx={0.6} fill={colors[i % colors.length]} />
                <text x={4.4} y={-0.4} fontSize={FS - 0.6} fill={pal.muted}>{nm}</text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );

  // --- circular: pie + doughnut ---
  if (isCircular) {
    const vals = clean[0].values;
    const total = vals.reduce((a, b) => a + Math.abs(b), 0) || 1;
    const cx = mLeft + plotW / 2, cy = mTop + plotH / 2, R = Math.min(plotW, plotH) / 2 - 2;
    const holeR = kind === "doughnut" ? R * clamp(num(el.holeSize, 55) / 100, 0.2, 0.85) : 0;
    let a0 = -Math.PI / 2;
    return (
      <Frame>
        {vals.map((v, i) => {
          const frac = Math.abs(v) / total;
          const a1 = a0 + frac * Math.PI * 2;
          const large = frac > 0.5 ? 1 : 0;
          const oS = `${cx + R * Math.cos(a0)},${cy + R * Math.sin(a0)}`;
          const oE = `${cx + R * Math.cos(a1)},${cy + R * Math.sin(a1)}`;
          let d: string;
          if (holeR > 0) {
            const iS = `${cx + holeR * Math.cos(a1)},${cy + holeR * Math.sin(a1)}`;
            const iE = `${cx + holeR * Math.cos(a0)},${cy + holeR * Math.sin(a0)}`;
            d = `M${oS} A${R},${R} 0 ${large} 1 ${oE} L${iS} A${holeR},${holeR} 0 ${large} 0 ${iE} Z`;
          } else {
            d = `M${cx},${cy} L${oS} A${R},${R} 0 ${large} 1 ${oE} Z`;
          }
          const mid = (a0 + a1) / 2, lr = holeR > 0 ? (R + holeR) / 2 : R * 0.6;
          const lx = cx + lr * Math.cos(mid), ly = cy + lr * Math.sin(mid);
          a0 = a1;
          return (
            <g key={i}>
              <path d={d} fill={colors[i % colors.length]} stroke="#fff" strokeWidth={0.5} />
              {frac > 0.06 && <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize={FS - 0.8} fill="#fff" fontWeight={600}>{Math.round(frac * 100)}%</text>}
            </g>
          );
        })}
      </Frame>
    );
  }

  // --- radar ---
  if (isRadar) {
    const k = Math.max(...clean.map((s) => s.values.length));
    const cx = mLeft + plotW / 2, cy = mTop + plotH / 2, R = Math.min(plotW, plotH) / 2 - 6;
    const maxV = niceMax(Math.max(1, ...clean.flatMap((s) => s.values)));
    const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / k;
    const pt = (i: number, v: number) => `${cx + (v / maxV) * R * Math.cos(ang(i))},${cy + (v / maxV) * R * Math.sin(ang(i))}`;
    const rings = 4;
    return (
      <Frame>
        {Array.from({ length: rings }, (_, r) => {
          const rr = (R / rings) * (r + 1);
          const poly = Array.from({ length: k }, (_, i) => `${cx + rr * Math.cos(ang(i))},${cy + rr * Math.sin(ang(i))}`).join(" ");
          return <polygon key={r} points={poly} fill="none" stroke={pal.hairline} strokeWidth={0.4} />;
        })}
        {Array.from({ length: k }, (_, i) => {
          const ex = cx + R * Math.cos(ang(i)), ey = cy + R * Math.sin(ang(i));
          const lx = cx + (R + 3.5) * Math.cos(ang(i)), ly = cy + (R + 3.5) * Math.sin(ang(i));
          return (
            <g key={i}>
              <line x1={cx} y1={cy} x2={ex} y2={ey} stroke={pal.hairline} strokeWidth={0.4} />
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize={FS - 1.2} fill={pal.muted}>{cats[i] ?? ""}</text>
            </g>
          );
        })}
        {clean.map((s, si) => (
          <polygon key={si} points={s.values.map((v, i) => pt(i, v)).join(" ")} fill={colors[si % colors.length]} fillOpacity={0.12} stroke={colors[si % colors.length]} strokeWidth={1.1} />
        ))}
      </Frame>
    );
  }

  // --- cartesian: column / bar / line / area ---
  const stackTotals = Array.from({ length: n }, (_, i) => clean.reduce((a, s) => a + Math.max(0, num(s.values[i])), 0));
  const rawMax = stacked ? Math.max(1, ...stackTotals) : Math.max(1, ...clean.flatMap((s) => s.values));
  const max = percent ? 1 : niceMax(rawMax);
  const x0 = mLeft, y0 = mTop + plotH;
  const yFor = (v: number) => y0 - (v / max) * plotH;
  const gridN = 4;
  const tick = (v: number) => (percent ? `${Math.round(v * 100)}%` : String(Number(v.toFixed(max < 10 ? 1 : 0))));

  const vAxis = (
    <g>
      {Array.from({ length: gridN + 1 }, (_, g) => {
        const gy = mTop + (plotH / gridN) * g;
        const val = max - (max / gridN) * g;
        return (
          <g key={g}>
            <line x1={x0} y1={gy} x2={x0 + plotW} y2={gy} stroke={pal.hairline} strokeWidth={0.4} />
            <text x={x0 - 1.5} y={gy + 1.3} textAnchor="end" fontSize={FS - 1.2} fill={pal.muted}>{tick(val)}</text>
          </g>
        );
      })}
      <line x1={x0} y1={y0} x2={x0 + plotW} y2={y0} stroke={pal.hairline} strokeWidth={0.6} />
    </g>
  );
  const catLabelsBottom = (
    <g>{cats.slice(0, n).map((c, i) => (
      <text key={i} x={x0 + (plotW / n) * (i + 0.5)} y={y0 + 3.8} textAnchor="middle" fontSize={FS - 1.2} fill={pal.muted}>{c}</text>
    ))}</g>
  );

  // horizontal bar: categories run down the left, values across the bottom.
  if (isBar && horizontal) {
    const rowH = plotH / n;
    const hAxis = (
      <g>
        {Array.from({ length: gridN + 1 }, (_, g) => {
          const gx = x0 + (plotW / gridN) * g;
          return (
            <g key={g}>
              <line x1={gx} y1={mTop} x2={gx} y2={y0} stroke={pal.hairline} strokeWidth={0.4} />
              <text x={gx} y={y0 + 3.3} textAnchor="middle" fontSize={FS - 1.2} fill={pal.muted}>{tick((max / gridN) * g)}</text>
            </g>
          );
        })}
        <line x1={x0} y1={mTop} x2={x0} y2={y0} stroke={pal.hairline} strokeWidth={0.6} />
      </g>
    );
    const catLabelsLeft = (
      <g>{cats.slice(0, n).map((c, i) => (
        <text key={i} x={x0 - 1.5} y={mTop + rowH * (i + 0.5) + 1.2} textAnchor="end" fontSize={FS - 1.2} fill={pal.muted}>{c}</text>
      ))}</g>
    );
    return (
      <Frame>
        {hAxis}
        {stacked
          ? Array.from({ length: n }, (_, i) => {
              const total = percent ? (stackTotals[i] || 1) : 1;
              let acc = 0;
              const bh = rowH * 0.6, by = mTop + rowH * i + (rowH - bh) / 2;
              return (
                <g key={i}>{clean.map((s, si) => {
                  const val = (percent ? Math.max(0, num(s.values[i])) / total : Math.max(0, num(s.values[i])));
                  const w = (val / max) * plotW, xL = x0 + acc; acc += w;
                  return <rect key={si} x={xL} y={by} width={Math.max(0, w)} height={bh} fill={colors[si % colors.length]} />;
                })}</g>
              );
            })
          : clean.flatMap((s, si) => s.values.map((v, i) => {
              const bh = (rowH * 0.7) / clean.length, by = mTop + rowH * i + rowH * 0.15 + si * bh;
              const w = (Math.max(0, v) / max) * plotW;
              return (
                <g key={`${si}-${i}`}>
                  <rect x={x0} y={by} width={Math.max(0, w)} height={bh * 0.92} fill={colors[si % colors.length]} rx={0.4} />
                  {clean.length === 1 && <text x={x0 + w + 1} y={by + bh * 0.7} fontSize={FS - 1.4} fill={pal.muted}>{v}</text>}
                </g>
              );
            }))}
        {catLabelsLeft}
      </Frame>
    );
  }

  // vertical columns (clustered / stacked / 100%).
  if (isBar) {
    const groupW = plotW / n;
    return (
      <Frame>
        {vAxis}
        {stacked
          ? Array.from({ length: n }, (_, i) => {
              const total = percent ? (stackTotals[i] || 1) : 1;
              let acc = 0;
              const bw = groupW * 0.6, bx = x0 + groupW * i + (groupW - bw) / 2;
              return (
                <g key={i}>{clean.map((s, si) => {
                  const val = (percent ? Math.max(0, num(s.values[i])) / total : Math.max(0, num(s.values[i])));
                  const h = (val / max) * plotH, yT = y0 - acc - h; acc += h;
                  return <rect key={si} x={bx} y={yT} width={bw} height={Math.max(0, h)} fill={colors[si % colors.length]} />;
                })}</g>
              );
            })
          : clean.flatMap((s, si) => s.values.map((v, i) => {
              const bw = (groupW * 0.7) / clean.length, bx = x0 + groupW * i + groupW * 0.15 + si * bw;
              const h = (Math.max(0, v) / max) * plotH;
              return (
                <g key={`${si}-${i}`}>
                  <rect x={bx} y={y0 - h} width={bw * 0.92} height={Math.max(0, h)} fill={colors[si % colors.length]} rx={0.4} />
                  {clean.length === 1 && <text x={bx + bw * 0.46} y={y0 - h - 1.2} textAnchor="middle" fontSize={FS - 1.4} fill={pal.muted}>{v}</text>}
                </g>
              );
            }))}
        {catLabelsBottom}
      </Frame>
    );
  }

  // line + area.
  return (
    <Frame>
      {vAxis}
      {clean.map((s, si) => {
        const pts = s.values.map((v, i) => [x0 + (plotW / n) * (i + 0.5), yFor(v)] as const);
        return (
          <g key={si}>
            {kind === "area" && (
              <polygon points={`${x0},${y0} ${pts.map((p) => p.join(",")).join(" ")} ${x0 + plotW},${y0}`} fill={colors[si % colors.length]} opacity={0.15} />
            )}
            <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={colors[si % colors.length]} strokeWidth={1.3} strokeLinejoin="round" />
            {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.1} fill={colors[si % colors.length]} />)}
          </g>
        );
      })}
      {catLabelsBottom}
    </Frame>
  );
}
