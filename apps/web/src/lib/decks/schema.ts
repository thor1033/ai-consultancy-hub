import { z } from "zod";

/*
 * What a slide may contain.
 *
 * A slide is a kind plus fields, never markup. The model fills fields; the
 * hub renders them in the Teqneo design system. Three things follow: every
 * slide is on brand however it was made, a new slide renders the instant it
 * arrives, and nothing a model writes can run in the audience's browser —
 * every field is text, rendered as text.
 *
 * The grammar is a consultancy's: the title of a content slide is an ACTION
 * TITLE, the takeaway in one sentence, not a topic; a tracker says where in
 * the storyline the slide sits; an exhibit says what it measures and in what
 * unit; the source is printed on the slide; and a "so what" can close it.
 * Most kinds are exhibits — charts, matrices, processes — because a
 * consultancy shows rather than lists.
 *
 * The limits are the slide's, not the database's: past them the text no
 * longer fits a 16:9 slide at a size a room can read, so a slide that would
 * overflow is refused with the field named, and the caller splits it.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).optional();
const indices = (max: number) => z.array(z.number().int().min(0).max(max)).max(max + 1).optional();

const common = {
  /** The tracker: where in the storyline this slide sits ("Diagnostic", "Recommendation"). */
  kicker: optText(60),
  /** A sticker in the corner: "Preliminary", "For discussion", "Illustrative". */
  sticker: optText(24),
  /** The "so what", in a callout at the foot of the slide. */
  takeaway: optText(220),
  /** A footnote, printed small above the source. */
  footnote: optText(240),
  /** Where the content came from; printed on the slide as "Source: …". */
  sources: z.array(text(160)).max(6).optional(),
  /** Speaker notes. Never on the audience's screen. */
  notes: optText(4000),
};

/** An exhibit: what the chart measures and in what unit, under the action title. */
const exhibit = { caption: optText(120) };

const column = z.object({ heading: optText(60), bullets: z.array(text(180)).min(1).max(6) });
const point = z.object({ label: text(40), value: z.number().finite() });

export const SLIDE_SCHEMAS = {
  title: z.object({
    kind: z.literal("title"),
    title: text(120),
    subtitle: optText(200),
    /** The client or audience, and the date, on the cover. */
    client: optText(80),
    date: optText(40),
    ...common,
  }),
  section: z.object({ kind: z.literal("section"), title: text(100), subtitle: optText(200), ...common }),
  agenda: z.object({
    kind: z.literal("agenda"),
    title: optText(120),
    items: z.array(text(90)).min(2).max(8),
    /** Which item we are at (from 0); it is highlighted and the rest recede. */
    current: z.number().int().min(0).max(7).optional(),
    ...common,
  }),
  summary: z.object({
    kind: z.literal("summary"),
    title: text(140),
    points: z.array(z.object({ headline: text(130), detail: optText(260) })).min(2).max(6),
    ...common,
  }),
  bullets: z.object({ kind: z.literal("bullets"), title: text(140), bullets: z.array(text(220)).min(1).max(7), ...common }),
  columns: z.object({ kind: z.literal("columns"), title: text(140), left: column, right: column, ...common }),
  table: z
    .object({
      kind: z.literal("table"),
      title: text(140),
      ...exhibit,
      columns: z.array(text(40)).min(2).max(6),
      rows: z.array(z.array(z.string().trim().max(120))).min(1).max(10),
      ...common,
    })
    .refine((t) => t.rows.every((r) => r.length === t.columns.length), {
      message: "every row needs exactly one cell per column",
      path: ["rows"],
    }),
  stats: z.object({
    kind: z.literal("stats"),
    title: text(140),
    stats: z.array(z.object({ value: text(16), label: text(90) })).min(1).max(4),
    ...common,
  }),
  bars: z.object({
    kind: z.literal("bars"),
    title: text(140),
    ...exhibit,
    unit: optText(12),
    items: z.array(z.object({ label: text(40), value: z.number().finite().min(0) })).min(1).max(10),
    /** Which bars carry the point (from 0); drawn in red, the rest in grey. */
    highlight: indices(9),
    ...common,
  }),
  trend: z.object({
    kind: z.literal("trend"),
    title: text(140),
    ...exhibit,
    unit: optText(12),
    /** Periods in order, e.g. 2022 … 2026E. */
    items: z.array(z.object({ label: text(16), value: z.number().finite().min(0) })).min(2).max(12),
    highlight: indices(11),
    /** A growth annotation over the series, e.g. "CAGR +18%". */
    growth: optText(30),
    ...common,
  }),
  waterfall: z.object({
    kind: z.literal("waterfall"),
    title: text(140),
    ...exhibit,
    unit: optText(12),
    start: point,
    steps: z.array(point).min(1).max(8),
    /** The label of the closing bar; its value is computed. */
    end: text(40),
    ...common,
  }),
  matrix: z.object({
    kind: z.literal("matrix"),
    title: text(140),
    ...exhibit,
    x: z.object({ label: text(40), low: optText(20), high: optText(20) }),
    y: z.object({ label: text(40), low: optText(20), high: optText(20) }),
    /** Top-left, top-right, bottom-left, bottom-right. */
    quadrants: z.array(z.object({ title: text(40), text: optText(120) })).length(4),
    /** Positions from 0 (low) to 100 (high) on each axis. */
    items: z
      .array(z.object({ label: text(30), x: z.number().min(0).max(100), y: z.number().min(0).max(100), highlight: z.boolean().optional() }))
      .max(12)
      .optional(),
    /** The quadrant that carries the point (0–3), shaded. */
    focus: z.number().int().min(0).max(3).optional(),
    ...common,
  }),
  process: z.object({
    kind: z.literal("process"),
    title: text(140),
    steps: z.array(z.object({ title: text(36), detail: optText(170) })).min(2).max(6),
    /** The step we are at (from 0), highlighted. */
    current: z.number().int().min(0).max(5).optional(),
    ...common,
  }),
  timeline: z
    .object({
      kind: z.literal("timeline"),
      title: text(140),
      ...exhibit,
      /** Column headings, e.g. weeks or months. */
      periods: z.array(text(12)).min(2).max(12),
      rows: z
        .array(
          z.object({
            label: text(44),
            /** First and last period (from 0), inclusive. Equal for a single milestone. */
            from: z.number().int().min(0).max(11),
            to: z.number().int().min(0).max(11),
            highlight: z.boolean().optional(),
            milestone: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(9),
      ...common,
    })
    .refine((t) => t.rows.every((r) => r.from <= r.to && r.to < t.periods.length), {
      message: "each row needs from ≤ to, both within the periods",
      path: ["rows"],
    }),
  harvey: z
    .object({
      kind: z.literal("harvey"),
      title: text(140),
      ...exhibit,
      /** The options compared, as columns. */
      options: z.array(text(30)).min(2).max(5),
      /** The criteria, as rows. */
      criteria: z.array(text(50)).min(1).max(8),
      /** One row per criterion, one score per option, 0 (none) to 4 (full). */
      scores: z.array(z.array(z.number().int().min(0).max(4))),
      /** Which option is recommended (from 0), outlined. */
      recommended: z.number().int().min(0).max(4).optional(),
      ...common,
    })
    .refine((h) => h.scores.length === h.criteria.length && h.scores.every((r) => r.length === h.options.length), {
      message: "scores needs one row per criterion with one score per option",
      path: ["scores"],
    }),
  quote: z.object({ kind: z.literal("quote"), quote: text(400), attribution: optText(120), ...common }),
  quotes: z.object({
    kind: z.literal("quotes"),
    title: text(140),
    quotes: z.array(z.object({ quote: text(220), attribution: optText(80) })).min(2).max(4),
    ...common,
  }),
} as const;

export type SlideKind = keyof typeof SLIDE_SCHEMAS;
export const SLIDE_KINDS = Object.keys(SLIDE_SCHEMAS) as SlideKind[];
export type SlideContent = z.infer<(typeof SLIDE_SCHEMAS)[SlideKind]>;

/** Check a slide; the error names the field, so a model can fix it in one go. */
export function validateSlide(input: unknown): { slide: SlideContent } | { error: string } {
  const kind = (input as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string" || !(kind in SLIDE_SCHEMAS)) {
    return { error: `"kind" must be one of: ${SLIDE_KINDS.join(", ")}.` };
  }
  const parsed = SLIDE_SCHEMAS[kind as SlideKind].safeParse(input);
  if (parsed.success) return { slide: parsed.data as SlideContent };
  const issue = parsed.error.issues[0];
  const path = issue.path.length ? issue.path.join(".") : "slide";
  return { error: `${kind} slide, ${path}: ${issue.message}` };
}

/**
 * The schema in words, for tool descriptions and the drafting prompt. Kept
 * next to the schema so the two cannot drift by more than one edit.
 */
export const SLIDE_SPEC = `Slides follow consulting conventions. The "title" of every content slide is an ACTION TITLE: the takeaway as one full sentence (e.g. "Reporting effort can fall by a third without new headcount"), never a topic ("Reporting"). Prefer an exhibit (chart, matrix, process, timeline) to a bullet list.

A slide is a JSON object with a "kind" and its fields. Every kind also takes optional: "kicker" (≤60, the tracker: where in the storyline, e.g. "Diagnostic"), "sticker" (≤24, e.g. "Preliminary"), "takeaway" (≤220, the so-what, in a callout), "footnote" (≤240), "sources" (≤6 strings, printed as "Source: …"), "notes" (speaker notes, never shown).
- title: { title ≤120, subtitle? ≤200, client? ≤80, date? ≤40 } — the cover
- section: { title ≤100, subtitle? } — a divider
- agenda: { title?, items: 2–8 strings ≤90, current?: index of the part we are at }
- summary: { title ≤140, points: 2–6 of { headline ≤130, detail? ≤260 } } — executive summary, numbered
- bullets: { title ≤140, bullets: 1–7 strings ≤220 }
- columns: { title, left: { heading?, bullets: 1–6 }, right: same }
- table: { title, caption?, columns: 2–6 strings ≤40, rows: 1–10 arrays with one cell ≤120 per column }
- stats: { title, stats: 1–4 of { value ≤16 e.g. "38%", label ≤90 } }
- bars: { title, caption? ≤120 (what is measured, e.g. "Hours per week on reporting, by team"), unit? ≤12, items: 1–10 of { label ≤40, value ≥0 }, highlight?: indices of the bars that carry the point }
- trend: { title, caption?, unit?, items: 2–12 periods of { label ≤16, value ≥0 } in order, highlight?: indices, growth? ≤30 e.g. "CAGR +18%" }
- waterfall: { title, caption?, unit?, start: { label, value }, steps: 1–8 of { label, value (negative to subtract) }, end: label of the computed closing bar }
- matrix: { title, caption?, x: { label, low?, high? }, y: same, quadrants: exactly 4 of { title ≤40, text? ≤120 } in order top-left, top-right, bottom-left, bottom-right, items?: ≤12 of { label ≤30, x 0–100, y 0–100, highlight? }, focus?: quadrant index 0–3 }
- process: { title, steps: 2–6 of { title ≤36, detail? ≤170 }, current?: index }
- timeline: { title, caption?, periods: 2–12 strings ≤12, rows: 1–9 of { label ≤44, from, to (period indices, inclusive), highlight?, milestone? } }
- harvey: { title, caption?, options: 2–5 strings ≤30 (columns), criteria: 1–8 strings ≤50 (rows), scores: one row per criterion of 0–4 per option, recommended?: option index }
- quote: { quote ≤400, attribution? ≤120 }
- quotes: { title, quotes: 2–4 of { quote ≤220, attribution? ≤80 } } — what we heard
Text is plain; **double asterisks** make bold. Write for a room: short lines, numbers with units, no paragraphs.`;
