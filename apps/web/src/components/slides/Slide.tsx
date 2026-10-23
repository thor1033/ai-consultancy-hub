import { Mark } from "@/components/Mark";

/*
 * One slide, drawn at its native 1280×720 in the Teqneo design system.
 *
 * Pure: no hooks, so the same component draws the audience's screen, the
 * presenter's thumbnails and the print pages. Every field is rendered as
 * text — the slide schema (lib/decks/schema.ts) holds no markup, and the one
 * inline format, **bold**, is turned into <strong> here and nowhere else.
 *
 * Light theme always: a slide is a printed page, the same whether the hub is
 * in dark mode or not.
 */

export type SlideData = { kind: string; [field: string]: unknown };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

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
  return chars > 900 ? "slide-denser" : chars > 520 ? "slide-dense" : "";
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

function Body({ s }: { s: SlideData }) {
  const title = str(s.title);
  const kicker = str(s.kicker);
  const Head = () => (
    <>
      {kicker && <div className="slide-kicker">{kicker}</div>}
      {title && (
        <h2 className="slide-title">
          <Rich text={title} />
        </h2>
      )}
    </>
  );

  switch (s.kind) {
    case "title":
      return (
        <div className="slide-cover">
          <span className="slide-rule" aria-hidden />
          {kicker && <div className="slide-kicker">{kicker}</div>}
          <h1 className="slide-cover-title">
            <Rich text={title} />
          </h1>
          {str(s.subtitle) && (
            <p className="slide-subtitle">
              <Rich text={str(s.subtitle)} />
            </p>
          )}
        </div>
      );
    case "section":
      return (
        <div className="slide-cover">
          {kicker && <div className="slide-kicker">{kicker}</div>}
          <h1 className="slide-section-title">
            <Rich text={title} />
          </h1>
          {str(s.subtitle) && (
            <p className="slide-subtitle">
              <Rich text={str(s.subtitle)} />
            </p>
          )}
        </div>
      );
    case "bullets": {
      const items = list(s.bullets);
      return (
        <div className={density(items)}>
          <Head />
          <Bullets items={items} />
        </div>
      );
    }
    case "columns": {
      const col = (c: unknown) => (c && typeof c === "object" ? (c as { heading?: unknown; bullets?: unknown }) : {});
      const l = col(s.left);
      const r = col(s.right);
      return (
        <div className={density([...list(l.bullets), ...list(r.bullets)])}>
          <Head />
          <div className="slide-columns">
            {[l, r].map((c, i) => (
              <div key={i}>
                {str(c.heading) && <div className="slide-col-head">{str(c.heading)}</div>}
                <Bullets items={list(c.bullets)} />
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "table": {
      const cols = list(s.columns);
      const rows = Array.isArray(s.rows) ? (s.rows as unknown[]).map(list) : [];
      return (
        <div className={rows.length > 6 ? "slide-dense" : ""}>
          <Head />
          <table className="slide-table">
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
        </div>
      );
    }
    case "stats": {
      const stats = Array.isArray(s.stats) ? (s.stats as { value?: unknown; label?: unknown }[]) : [];
      return (
        <div>
          <Head />
          <div className="slide-stats" style={{ gridTemplateColumns: `repeat(${Math.max(stats.length, 1)}, minmax(0, 1fr))` }}>
            {stats.map((st, i) => (
              <div key={i} className="slide-stat">
                <div className="slide-stat-value">{str(st.value)}</div>
                <div className="slide-stat-label">{str(st.label)}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "bars": {
      const items = Array.isArray(s.items) ? (s.items as { label?: unknown; value?: unknown }[]) : [];
      const max = Math.max(...items.map((it) => (typeof it.value === "number" ? it.value : 0)), 0) || 1;
      const unit = str(s.unit);
      return (
        <div>
          <Head />
          <div className={`slide-bars ${items.length > 6 ? "slide-bars-tight" : ""}`}>
            {items.map((it, i) => {
              const v = typeof it.value === "number" ? it.value : 0;
              return (
                <div key={i} className="slide-bar-row">
                  <div className="slide-bar-label">{str(it.label)}</div>
                  <div className="slide-bar-track">
                    <div className="slide-bar" style={{ width: `${Math.max((v / max) * 100, 0.5)}%` }} />
                  </div>
                  <div className="slide-bar-value">
                    {v.toLocaleString("en-GB")}
                    {unit && <span className="slide-bar-unit">{unit}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    case "quote":
      return (
        <div className="slide-quote-wrap">
          {kicker && <div className="slide-kicker">{kicker}</div>}
          <blockquote className={`slide-quote ${str(s.quote).length > 220 ? "slide-quote-long" : ""}`}>
            <Rich text={str(s.quote)} />
          </blockquote>
          {str(s.attribution) && <div className="slide-attribution">{str(s.attribution)}</div>}
        </div>
      );
    default:
      return (
        <div>
          <Head />
          <p className="slide-subtitle">This slide&apos;s kind, “{s.kind}”, cannot be drawn.</p>
        </div>
      );
  }
}

export function Slide({
  slide,
  deckTitle,
  number,
  total,
}: {
  slide: SlideData;
  deckTitle?: string;
  number?: number;
  total?: number;
}) {
  return (
    <div className={`slide slide-k-${slide.kind}`}>
      <div className="slide-body">
        <Body s={slide} />
      </div>
      <footer className="slide-foot">
        <span className="slide-brand">
          <Mark size={15} />
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
    </div>
  );
}
