import { Mark } from "@/components/Mark";

/*
 * One slide, drawn at its native 1280×720 in the Teqneo design system, in a
 * consultancy's grammar (lib/decks/schema.ts says what each kind holds).
 *
 * Every content slide has the same frame, top to bottom: the tracker and an
 * optional sticker; the action title; the exhibit's caption; the exhibit;
 * the "so what"; footnote and source; the footer. Readers learn the frame
 * once and then only read what changes, which is the point of the grammar.
 *
 * Pure: no hooks, so the same component draws the audience's screen, the
 * presenter's thumbnails and the print pages. Every field is rendered as
 * text — the one inline format, **bold**, becomes <strong> here and nowhere
 * else. Charts are drawn with boxes, not a charting library, so a slide
 * prints exactly as it shows.
 *
 * White ground, black type, one red for what carries the point, greys for
 * everything that does not. Fixed colours, never the theme's: a slide does
 * not turn dark with the hub.
 */

export type SlideData = { kind: string; [field: string]: unknown };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const objs = <T,>(v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as T[]) : []);
const fmt = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 1 });

/** "**bold**" → <strong>; everything else stays text. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

/** Long content gets a smaller size, so it fits rather than spilling off the slide. */
function density(texts: string[]): "" | "slide-dense" | "slide-denser" {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return chars > 900 ? "slide-denser" : chars > 560 ? "slide-dense" : "";
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="slide-bullets">
      {items.map((b, i) => (
        <li key={i}>
          <Rich text={b} />
        </li>
      ))}
    </ul>
  );
}

// ── exhibits ──────────────────────────────────────────────────────────────

function Summary({ s }: { s: SlideData }) {
  const points = objs<{ headline?: unknown; detail?: unknown }>(s.points);
  return (
    <ol className={`slide-summary ${points.length > 4 ? "slide-summary-tight" : ""}`}>
      {points.map((p, i) => (
        <li key={i}>
          <span className="slide-summary-n">{i + 1}</span>
          <div>
            <div className="slide-summary-head">
              <Rich text={str(p.headline)} />
            </div>
            {str(p.detail) && (
              <div className="slide-summary-detail">
                <Rich text={str(p.detail)} />
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Agenda({ s }: { s: SlideData }) {
  const items = list(s.items);
  const current = typeof s.current === "number" ? s.current : -1;
  return (
    <ol className="slide-agenda">
      {items.map((it, i) => (
        <li key={i} className={current < 0 ? "" : i === current ? "is-current" : "is-other"}>
          <span className="slide-agenda-n">{String(i + 1).padStart(2, "0")}</span>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  );
}

function Bars({ s }: { s: SlideData }) {
  const items = objs<{ label?: unknown; value?: unknown }>(s.items);
  const hi = new Set(Array.isArray(s.highlight) ? (s.highlight as number[]) : []);
  const max = Math.max(...items.map((it) => num(it.value)), 0) || 1;
  return (
    <div className={`slide-hbars ${items.length > 6 ? "slide-hbars-tight" : items.length <= 5 ? "slide-hbars-roomy" : ""}`}>
      {items.map((it, i) => {
        const tone = hi.size === 0 ? "" : hi.has(i) ? "is-hi" : "is-lo";
        return (
          <div key={i} className={`slide-hbar-row ${tone}`}>
            <div className="slide-hbar-label">{str(it.label)}</div>
            <div className="slide-hbar-track">
              <div className="slide-hbar" style={{ width: `${Math.max((num(it.value) / max) * 88, 0.6)}%` }} />
              <span className="slide-hbar-value">{fmt(num(it.value))}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Trend({ s }: { s: SlideData }) {
  const items = objs<{ label?: unknown; value?: unknown }>(s.items);
  const hi = new Set(Array.isArray(s.highlight) ? (s.highlight as number[]) : []);
  const max = Math.max(...items.map((it) => num(it.value)), 0) || 1;
  return (
    <div className="slide-plot">
      {str(s.growth) && (
        <div className="slide-growth">
          <span aria-hidden>↗</span> {str(s.growth)}
        </div>
      )}
      <div className="slide-cols">
        {items.map((it, i) => {
          const tone = hi.size === 0 ? "" : hi.has(i) ? "is-hi" : "is-lo";
          return (
            <div key={i} className={`slide-col ${tone}`}>
              <div className="slide-col-area">
                <span className="slide-col-value">{fmt(num(it.value))}</span>
                <div className="slide-col-bar" style={{ height: `${Math.max((num(it.value) / max) * 100, 0.5)}%` }} />
              </div>
              <div className="slide-col-label">{str(it.label)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Waterfall({ s }: { s: SlideData }) {
  const start = (s.start ?? {}) as { label?: unknown; value?: unknown };
  const steps = objs<{ label?: unknown; value?: unknown }>(s.steps);
  type Bar = { label: string; from: number; to: number; tone: "total" | "up" | "down"; shown: string };
  const bars: Bar[] = [];
  let run = num(start.value);
  bars.push({ label: str(start.label), from: 0, to: run, tone: "total", shown: fmt(run) });
  for (const st of steps) {
    const v = num(st.value);
    bars.push({ label: str(st.label), from: run, to: run + v, tone: v < 0 ? "down" : "up", shown: `${v < 0 ? "−" : "+"}${fmt(Math.abs(v))}` });
    run += v;
  }
  bars.push({ label: str(s.end), from: 0, to: run, tone: "total", shown: fmt(run) });
  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  const hi = Math.max(...bars.map((b) => Math.max(b.from, b.to)), 0) || 1;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return (
    <div className="slide-plot">
      <div className="slide-cols">
        {bars.map((b, i) => {
          const bottom = pct(Math.min(b.from, b.to));
          const height = Math.max(pct(Math.max(b.from, b.to)) - bottom, 0.5);
          return (
            <div key={i} className={`slide-col slide-wf-${b.tone}`}>
              <div className="slide-col-area">
                <div className="slide-wf-bar" style={{ bottom: `${bottom}%`, height: `${height}%` }}>
                  <span className="slide-wf-value">{b.shown}</span>
                </div>
              </div>
              <div className="slide-col-label">{b.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Matrix({ s }: { s: SlideData }) {
  const x = (s.x ?? {}) as { label?: unknown; low?: unknown; high?: unknown };
  const y = (s.y ?? {}) as { label?: unknown; low?: unknown; high?: unknown };
  const quads = objs<{ title?: unknown; text?: unknown }>(s.quadrants);
  const items = objs<{ label?: unknown; x?: unknown; y?: unknown; highlight?: unknown }>(s.items);
  const focus = typeof s.focus === "number" ? s.focus : -1;
  return (
    <div className="slide-matrix">
      <div className="slide-matrix-y">
        <span>{str(y.high)}</span>
        <span className="slide-matrix-axis">{str(y.label)}</span>
        <span>{str(y.low)}</span>
      </div>
      <div className="slide-matrix-main">
        <div className="slide-matrix-grid">
          {quads.slice(0, 4).map((q, i) => (
            <div key={i} className={`slide-quad ${i === focus ? "is-focus" : ""}`}>
              <div className="slide-quad-title">{str(q.title)}</div>
              {str(q.text) && <div className="slide-quad-text">{str(q.text)}</div>}
            </div>
          ))}
          {items.map((it, i) => (
            <div key={i} className={`slide-dot ${it.highlight ? "is-hi" : ""}`} style={{ left: `${num(it.x)}%`, bottom: `${num(it.y)}%` }}>
              <span className="slide-dot-label">{str(it.label)}</span>
            </div>
          ))}
        </div>
        <div className="slide-matrix-x">
          <span>{str(x.low)}</span>
          <span className="slide-matrix-axis">{str(x.label)} →</span>
          <span>{str(x.high)}</span>
        </div>
      </div>
    </div>
  );
}

function Process({ s }: { s: SlideData }) {
  const steps = objs<{ title?: unknown; detail?: unknown }>(s.steps);
  const current = typeof s.current === "number" ? s.current : -1;
  return (
    <div className="slide-process" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((st, i) => {
        const tone = current < 0 ? "" : i === current ? "is-current" : i < current ? "is-done" : "is-next";
        return (
          <div key={i} className={`slide-step ${tone}`}>
            <div className={`slide-chevron ${i === 0 ? "is-first" : ""}`}>
              <span className="slide-step-n">{i + 1}</span>
              <span className="slide-step-title">{str(st.title)}</span>
            </div>
            {str(st.detail) && (
              <div className="slide-step-detail">
                <Rich text={str(st.detail)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ s }: { s: SlideData }) {
  const periods = list(s.periods);
  const rows = objs<{ label?: unknown; from?: unknown; to?: unknown; highlight?: unknown; milestone?: unknown }>(s.rows);
  const n = Math.max(periods.length, 1);
  return (
    <div className={`slide-gantt ${rows.length > 6 ? "slide-gantt-tight" : ""}`}>
      <div className="slide-gantt-row slide-gantt-head">
        <div />
        <div className="slide-gantt-track" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
          {periods.map((p, i) => (
            <span key={i}>{p}</span>
          ))}
        </div>
      </div>
      {rows.map((r, i) => {
        const from = Math.min(num(r.from), n - 1);
        const to = Math.min(Math.max(num(r.to), from), n - 1);
        const milestone = Boolean(r.milestone) || from === to;
        return (
          <div key={i} className={`slide-gantt-row ${r.highlight ? "is-hi" : ""}`}>
            <div className="slide-gantt-label">{str(r.label)}</div>
            <div className="slide-gantt-track" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
              {periods.map((_, j) => (
                <span key={j} className="slide-gantt-cell" />
              ))}
              {milestone && r.milestone ? (
                <span className="slide-gantt-diamond" style={{ left: `${((from + 0.5) / n) * 100}%` }} />
              ) : (
                <span className="slide-gantt-bar" style={{ left: `${(from / n) * 100}%`, width: `${((to - from + 1) / n) * 100}%` }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A Harvey ball: 0 empty to 4 full, in quarters. */
function Ball({ score }: { score: number }) {
  const q = Math.max(0, Math.min(4, Math.round(score)));
  const r = 11;
  const c = 13;
  let wedge = null;
  if (q === 4) wedge = <circle cx={c} cy={c} r={r} />;
  else if (q > 0) {
    const a = (q / 4) * 2 * Math.PI;
    const x = c + r * Math.sin(a);
    const y = c - r * Math.cos(a);
    wedge = <path d={`M${c},${c} L${c},${c - r} A${r},${r} 0 ${q > 2 ? 1 : 0} 1 ${x},${y} Z`} />;
  }
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" className="slide-ball" aria-label={`${q} of 4`}>
      <circle cx={c} cy={c} r={r} className="slide-ball-ring" />
      <g className="slide-ball-fill">{wedge}</g>
    </svg>
  );
}

function Harvey({ s }: { s: SlideData }) {
  const options = list(s.options);
  const criteria = list(s.criteria);
  const scores = Array.isArray(s.scores) ? (s.scores as unknown[]).map((r) => (Array.isArray(r) ? r.map(num) : [])) : [];
  const rec = typeof s.recommended === "number" ? s.recommended : -1;
  return (
    <div>
      <table className="slide-harvey">
        <thead>
          <tr>
            <th />
            {options.map((o, j) => (
              <th key={j} className={j === rec ? "is-rec" : ""}>
                {j === rec && <span className="slide-rec-tag">Recommended</span>}
                {o}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {criteria.map((c, i) => (
            <tr key={i}>
              <td>{c}</td>
              {options.map((_, j) => (
                <td key={j} className={j === rec ? "is-rec" : ""}>
                  <Ball score={scores[i]?.[j] ?? 0} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="slide-legend">
        <Ball score={4} /> Strong <Ball score={2} /> Partial <Ball score={0} /> Weak
      </div>
    </div>
  );
}

function Quotes({ s }: { s: SlideData }) {
  const quotes = objs<{ quote?: unknown; attribution?: unknown }>(s.quotes);
  return (
    <div className="slide-quotes" style={{ gridTemplateColumns: `repeat(${quotes.length === 4 ? 2 : quotes.length}, minmax(0, 1fr))` }}>
      {quotes.map((q, i) => (
        <figure key={i} className="slide-qcard">
          <span className="slide-qmark" aria-hidden>
            “
          </span>
          <blockquote>
            <Rich text={str(q.quote)} />
          </blockquote>
          {str(q.attribution) && <figcaption>{str(q.attribution)}</figcaption>}
        </figure>
      ))}
    </div>
  );
}

function Exhibit({ s }: { s: SlideData }) {
  switch (s.kind) {
    case "summary":
      return <Summary s={s} />;
    case "agenda":
      return <Agenda s={s} />;
    case "bullets":
      return <Bullets items={list(s.bullets)} />;
    case "columns": {
      const col = (c: unknown) => (c && typeof c === "object" ? (c as { heading?: unknown; bullets?: unknown }) : {});
      return (
        <div className="slide-columns">
          {[col(s.left), col(s.right)].map((c, i) => (
            <div key={i}>
              {str(c.heading) && <div className="slide-col-head">{str(c.heading)}</div>}
              <Bullets items={list(c.bullets)} />
            </div>
          ))}
        </div>
      );
    }
    case "table": {
      const cols = list(s.columns);
      const rows = Array.isArray(s.rows) ? (s.rows as unknown[]).map(list) : [];
      return (
        <table className={`slide-table ${rows.length > 6 ? "slide-table-tight" : ""}`}>
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>
                    <Rich text={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "stats": {
      const stats = objs<{ value?: unknown; label?: unknown }>(s.stats);
      return (
        <div className="slide-stats" style={{ gridTemplateColumns: `repeat(${Math.max(stats.length, 1)}, minmax(0, 1fr))` }}>
          {stats.map((st, i) => (
            <div key={i} className="slide-stat">
              <div className="slide-stat-value">{str(st.value)}</div>
              <div className="slide-stat-label">
                <Rich text={str(st.label)} />
              </div>
            </div>
          ))}
        </div>
      );
    }
    case "bars":
      return <Bars s={s} />;
    case "trend":
      return <Trend s={s} />;
    case "waterfall":
      return <Waterfall s={s} />;
    case "matrix":
      return <Matrix s={s} />;
    case "process":
      return <Process s={s} />;
    case "timeline":
      return <Timeline s={s} />;
    case "harvey":
      return <Harvey s={s} />;
    case "quotes":
      return <Quotes s={s} />;
    default:
      return <p className="slide-missing">This slide&apos;s kind, “{s.kind}”, cannot be drawn.</p>;
  }
}

/** The texts that decide whether a list-like slide needs a smaller size. */
function bodyTexts(s: SlideData): string[] {
  if (s.kind === "bullets") return list(s.bullets);
  if (s.kind === "columns") {
    const b = (c: unknown) => list((c as { bullets?: unknown } | undefined)?.bullets);
    return [...b(s.left), ...b(s.right)];
  }
  if (s.kind === "summary") return objs<{ headline?: unknown; detail?: unknown }>(s.points).flatMap((p) => [str(p.headline), str(p.detail)]);
  return [];
}

// ── the frame ─────────────────────────────────────────────────────────────

function Foot({ deckTitle, number, total }: { deckTitle?: string; number?: number; total?: number }) {
  return (
    <footer className="slide-foot">
      <span className="slide-brand">
        <Mark size={12} />
        <span className="slide-wordmark">Teqneo</span>
      </span>
      {deckTitle && <span className="slide-deck">{deckTitle}</span>}
      {number !== undefined && (
        <span className="slide-page">
          {number}
          {total ? ` / ${total}` : ""}
        </span>
      )}
    </footer>
  );
}

function Fine({ s }: { s: SlideData }) {
  const sources = list(s.sources);
  if (!str(s.footnote) && !sources.length) return null;
  return (
    <div className="slide-fine">
      {str(s.footnote) && <div>1. {str(s.footnote)}</div>}
      {sources.length > 0 && <div>Source: {sources.join("; ")}</div>}
    </div>
  );
}

export function Slide({ slide, deckTitle, number, total }: { slide: SlideData; deckTitle?: string; number?: number; total?: number }) {
  const s = slide;
  const kicker = str(s.kicker);
  const sticker = str(s.sticker);

  if (s.kind === "title") {
    return (
      <div className="slide slide-k-title">
        <div className="slide-cover-brand">
          <Mark size={22} />
          <span className="slide-wordmark">Teqneo</span>
        </div>
        {sticker && <span className="slide-sticker slide-cover-sticker">{sticker}</span>}
        <div className="slide-cover">
          <span className="slide-rule" aria-hidden />
          {kicker && <div className="slide-cover-kicker">{kicker}</div>}
          <h1 className="slide-cover-title">
            <Rich text={str(s.title)} />
          </h1>
          {str(s.subtitle) && (
            <p className="slide-cover-sub">
              <Rich text={str(s.subtitle)} />
            </p>
          )}
        </div>
        {(str(s.client) || str(s.date)) && (
          <div className="slide-cover-meta">
            {str(s.client) && <span>{str(s.client)}</span>}
            {str(s.date) && <span>{str(s.date)}</span>}
          </div>
        )}
        <div className="slide-cover-conf">Confidential · prepared by Teqneo</div>
      </div>
    );
  }

  if (s.kind === "section" || s.kind === "quote") {
    return (
      <div className={`slide slide-k-${s.kind}`}>
        <div className="slide-cover">
          {kicker && <div className="slide-cover-kicker">{kicker}</div>}
          {s.kind === "section" ? (
            <>
              <h1 className="slide-section-title">
                <Rich text={str(s.title)} />
              </h1>
              {str(s.subtitle) && <p className="slide-cover-sub">{str(s.subtitle)}</p>}
            </>
          ) : (
            <>
              <blockquote className={`slide-quote ${str(s.quote).length > 220 ? "slide-quote-long" : ""}`}>
                <Rich text={str(s.quote)} />
              </blockquote>
              {str(s.attribution) && <div className="slide-attribution">{str(s.attribution)}</div>}
            </>
          )}
        </div>
        <div className="slide-bottom">
          <Fine s={s} />
          <Foot deckTitle={deckTitle} number={number} total={total} />
        </div>
      </div>
    );
  }

  const title = str(s.title) || (s.kind === "agenda" ? "Agenda" : "");
  const caption = str(s.caption);
  const unit = str(s.unit);
  return (
    <div className={`slide slide-k-${s.kind} ${density(bodyTexts(s))}`}>
      <header className="slide-head">
        {(kicker || sticker) && (
          <div className="slide-tracker-row">
            <span className="slide-tracker">{kicker}</span>
            {sticker && <span className="slide-sticker">{sticker}</span>}
          </div>
        )}
        <h2 className={`slide-title ${title.length > 95 ? "slide-title-long" : ""}`}>
          <Rich text={title} />
        </h2>
        {(caption || unit) && (
          <div className="slide-caption">
            {caption}
            {caption && unit ? ", " : ""}
            {unit && <span className="slide-caption-unit">{unit}</span>}
          </div>
        )}
      </header>
      <div className="slide-content">
        <Exhibit s={s} />
      </div>
      {str(s.takeaway) && (
        <div className="slide-takeaway">
          <Rich text={str(s.takeaway)} />
        </div>
      )}
      <div className="slide-bottom">
        <Fine s={s} />
        <Foot deckTitle={deckTitle} number={number} total={total} />
      </div>
    </div>
  );
}
