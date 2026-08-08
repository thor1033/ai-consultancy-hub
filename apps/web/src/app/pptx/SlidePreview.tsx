"use client";

import type { ReactNode } from "react";
import { LAYOUTS, cssColor, CHART_PALETTE, resolvePalette } from "./preview";

type Palette = ReturnType<typeof resolvePalette>;

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
}: {
  template: Any | null;
  index: number;
  selected?: Selection | null;
  onSelect?: (s: number, e: number) => void;
}) {
  const layout = str(template?.layout, "LAYOUT_WIDE");
  const dims = LAYOUTS[layout] ?? LAYOUTS.LAYOUT_WIDE;
  const theme = (template?.theme as Any) ?? {};
  const pal = resolvePalette(theme);
  const slides = Array.isArray(template?.slides) ? (template!.slides as Any[]) : [];
  const slide = slides[index];
  if (!slide) return null;
  return <Slide slide={slide} index={index} dims={dims} themeBg={str(theme.bg)} pal={pal} selected={selected} onSelect={onSelect} />;
}

function Slide({
  slide,
  index,
  dims,
  themeBg,
  pal,
  selected,
  onSelect,
}: {
  slide: Any;
  index: number;
  dims: { w: number; h: number };
  themeBg?: string;
  pal: Palette;
  selected?: Selection | null;
  onSelect?: (s: number, e: number) => void;
}) {
  const W = dims.w;
  const H = dims.h;
  const bg = cssColor(str(slide.background) || themeBg) ?? "#FFFFFF";
  const elements = Array.isArray(slide.elements) ? (slide.elements as Any[]) : [];
  const editable = !!onSelect;

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
    if (type === "chart") return <Chart el={el} />;
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

  return (
    <div
      className="rounded-lg border border-[var(--border)] shadow-sm"
      style={{ containerType: "size", position: "relative", width: "100%", aspectRatio: `${W} / ${H}`, background: bg }}
      onClick={editable ? () => onSelect!(index, -1) : undefined}
    >
      {elements.map((el, i) => {
        const isSel = selected?.s === index && selected?.e === i;
        // Hairlines carry zero thickness in the model; let them draw outside the box.
        const isLine = str(el.type) === "shape" && str(el.shape) === "line";
        return (
          <div
            key={i}
            onClick={editable ? (ev) => { ev.stopPropagation(); onSelect!(index, i); } : undefined}
            style={{ ...box(el), cursor: editable ? "pointer" : "default", outline: isSel ? `2px solid ${pal.accent}` : editable ? "1px dashed transparent" : "none", outlineOffset: "1px", overflow: isLine ? "visible" : "hidden" }}
          >
            {content(el)}
          </div>
        );
      })}
    </div>
  );
}

// SVG chart for preview, styled to resemble the native pptx chart: axes,
// gridlines, value + category labels, and a legend. Not pixel-identical to the
// downloaded .pptx (that carries a real Office chart), but professional and close.
function Chart({ el }: { el: Any }) {
  const type = str(el.chartType, "bar");
  const title = str(el.title);
  const series = (Array.isArray(el.series) ? el.series : []) as Any[];
  const colors = (Array.isArray(el.colors) ? (el.colors as string[]).map((c) => cssColor(c)!) : CHART_PALETTE);
  const clean = series
    .map((s) => ({ name: str(s.name), values: (Array.isArray(s.values) ? s.values : []).map((v) => num(v)), labels: (Array.isArray(s.labels) ? s.labels : []).map(String) }))
    .filter((s) => s.values.length);

  if (!clean.length) {
    return <div style={{ display: "grid", placeItems: "center", width: "100%", height: "100%", color: "#94A3B8", fontSize: "3cqw" }}>chart</div>;
  }

  const ar = Math.max(0.2, num(el.w, 4) / num(el.h, 3));
  const VBH = 100;
  const VBW = 100 * ar;
  const FS = 4.2;

  const isPie = type === "pie";
  const names = clean.map((s, i) => s.name || `Series ${i + 1}`);
  const showLegend = el.showLegend === false ? false : (isPie || clean.length > 1);

  const mTop = title ? 9 : 4;
  const mBottom = 9 + (showLegend ? 7 : 0);
  const mLeft = isPie ? 4 : 13;
  const mRight = 4;
  const plotW = VBW - mLeft - mRight;
  const plotH = VBH - mTop - mBottom;
  const font = "'Segoe UI', system-ui, sans-serif";

  const Frame = ({ children }: { children: ReactNode }) => (
    <svg viewBox={`0 0 ${VBW} ${VBH}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", fontFamily: font }}>
      {title && <text x={VBW / 2} y={5.8} textAnchor="middle" fontSize={FS + 0.8} fontWeight={600} fill="#334155">{title}</text>}
      {children}
      {showLegend && (
        <g>
          {names.map((nm, i) => {
            const per = VBW / names.length;
            const cx = per * i + per / 2;
            return (
              <g key={i} transform={`translate(${cx - 8}, ${VBH - 3})`}>
                <rect x={0} y={-3.2} width={3.2} height={3.2} rx={0.6} fill={colors[i % colors.length]} />
                <text x={4.4} y={-0.4} fontSize={FS - 0.4} fill="#64748B">{nm}</text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );

  if (isPie) {
    const vals = clean[0].values;
    const total = vals.reduce((a, b) => a + Math.abs(b), 0) || 1;
    const cx = mLeft + plotW / 2, cy = mTop + plotH / 2, r = Math.min(plotW, plotH) / 2 - 2;
    let angle = -Math.PI / 2;
    return (
      <Frame>
        {vals.map((v, i) => {
          const frac = Math.abs(v) / total;
          const next = angle + frac * Math.PI * 2;
          const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
          const x2 = cx + r * Math.cos(next), y2 = cy + r * Math.sin(next);
          const mid = (angle + next) / 2;
          const lx = cx + r * 0.6 * Math.cos(mid), ly = cy + r * 0.6 * Math.sin(mid);
          const large = frac > 0.5 ? 1 : 0;
          const d = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
          angle = next;
          return (
            <g key={i}>
              <path d={d} fill={colors[i % colors.length]} stroke="#fff" strokeWidth={0.5} />
              {frac > 0.06 && <text x={lx} y={ly} textAnchor="middle" fontSize={FS - 0.6} fill="#fff" fontWeight={600}>{Math.round(frac * 100)}%</text>}
            </g>
          );
        })}
      </Frame>
    );
  }

  const allVals = clean.flatMap((s) => s.values);
  const rawMax = Math.max(0, ...allVals);
  const step = Math.pow(10, Math.floor(Math.log10(rawMax || 1)));
  const max = Math.max(step, Math.ceil((rawMax || 1) / step) * step) || 1;
  const cats = clean[0].labels;
  const n = Math.max(...clean.map((s) => s.values.length));
  const x0 = mLeft, y0 = mTop + plotH;
  const yFor = (v: number) => y0 - (v / max) * plotH;
  const gridN = 4;

  const axis = (
    <g>
      {Array.from({ length: gridN + 1 }, (_, g) => {
        const gy = mTop + (plotH / gridN) * g;
        const val = max - (max / gridN) * g;
        return (
          <g key={g}>
            <line x1={x0} y1={gy} x2={x0 + plotW} y2={gy} stroke="#EEF2F7" strokeWidth={0.5} />
            <text x={x0 - 1.5} y={gy + 1.4} textAnchor="end" fontSize={FS - 0.8} fill="#94A3B8">{Number(val.toFixed(max < 10 ? 1 : 0))}</text>
          </g>
        );
      })}
      <line x1={x0} y1={y0} x2={x0 + plotW} y2={y0} stroke="#E5E7EB" strokeWidth={0.6} />
    </g>
  );

  const catLabels = (
    <g>
      {cats.slice(0, n).map((c, i) => {
        const cx = x0 + (plotW / n) * (i + 0.5);
        return <text key={i} x={cx} y={y0 + 4.2} textAnchor="middle" fontSize={FS - 0.8} fill="#64748B">{c}</text>;
      })}
    </g>
  );

  if (type === "line" || type === "area") {
    return (
      <Frame>
        {axis}
        {clean.map((s, si) => {
          const pts = s.values.map((v, i) => [x0 + (plotW / n) * (i + 0.5), yFor(v)] as const);
          return (
            <g key={si}>
              {type === "area" && (
                <polygon points={`${x0},${y0} ${pts.map((p) => p.join(",")).join(" ")} ${x0 + plotW},${y0}`} fill={colors[si % colors.length]} opacity={0.15} />
              )}
              <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={colors[si % colors.length]} strokeWidth={1.3} strokeLinejoin="round" />
              {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.1} fill={colors[si % colors.length]} />)}
            </g>
          );
        })}
        {catLabels}
      </Frame>
    );
  }

  const groupW = plotW / n;
  const bw = (groupW * 0.62) / clean.length;
  return (
    <Frame>
      {axis}
      {clean.flatMap((s, si) =>
        s.values.map((v, i) => {
          const h = (v / max) * plotH;
          const bx = x0 + groupW * i + groupW * 0.19 + si * bw;
          return (
            <g key={`${si}-${i}`}>
              <rect x={bx} y={y0 - h} width={bw * 0.9} height={Math.max(0, h)} fill={colors[si % colors.length]} rx={0.5} />
              {clean.length === 1 && <text x={bx + bw * 0.45} y={y0 - h - 1.2} textAnchor="middle" fontSize={FS - 1} fill="#64748B">{v}</text>}
            </g>
          );
        }),
      )}
      {catLabels}
    </Frame>
  );
}
