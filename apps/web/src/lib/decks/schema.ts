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
 * The limits are the slide's, not the database's: past them the text no
 * longer fits a 16:9 slide at a size a room can read, so a slide that would
 * overflow is refused with the field named, and the caller splits it.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).optional();

const common = {
  /** Small uppercase line above the title: the section or the client. */
  kicker: optText(60),
  /** Speaker notes. Never on the audience's screen. */
  notes: optText(4000),
  /** Where the content came from: document titles, mails, tasks. Shown to the presenter. */
  sources: z.array(text(300)).max(10).optional(),
};

const column = z.object({ heading: optText(60), bullets: z.array(text(180)).min(1).max(6) });

export const SLIDE_SCHEMAS = {
  title: z.object({ kind: z.literal("title"), title: text(120), subtitle: optText(200), ...common }),
  section: z.object({ kind: z.literal("section"), title: text(100), subtitle: optText(200), ...common }),
  bullets: z.object({ kind: z.literal("bullets"), title: text(120), bullets: z.array(text(220)).min(1).max(7), ...common }),
  columns: z.object({ kind: z.literal("columns"), title: text(120), left: column, right: column, ...common }),
  table: z
    .object({
      kind: z.literal("table"),
      title: text(120),
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
    title: text(120),
    stats: z.array(z.object({ value: text(16), label: text(80) })).min(1).max(4),
    ...common,
  }),
  bars: z.object({
    kind: z.literal("bars"),
    title: text(120),
    unit: optText(12),
    items: z.array(z.object({ label: text(40), value: z.number().finite().min(0) })).min(1).max(10),
    ...common,
  }),
  quote: z.object({ kind: z.literal("quote"), quote: text(400), attribution: optText(120), ...common }),
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
export const SLIDE_SPEC = `A slide is a JSON object with a "kind" and its fields. Every kind also takes optional "kicker" (≤60 chars, small line above the title), "notes" (speaker notes, never shown to the audience) and "sources" (≤10 strings: where the content came from).
- title: { title ≤120, subtitle? ≤200 }
- section: { title ≤100, subtitle? ≤200 } (a divider between parts)
- bullets: { title ≤120, bullets: 1–7 strings ≤220 }
- columns: { title ≤120, left: { heading? ≤60, bullets: 1–6 strings ≤180 }, right: same }
- table: { title ≤120, columns: 2–6 strings ≤40, rows: 1–10 arrays with one cell (≤120) per column }
- stats: { title ≤120, stats: 1–4 of { value ≤16 (e.g. "38%"), label ≤80 } }
- bars: { title ≤120, unit? ≤12, items: 1–10 of { label ≤40, value: number ≥0 } }
- quote: { quote ≤400, attribution? ≤120 }
Text is plain; **double asterisks** make bold. Write for a room: short lines, one idea per bullet, no paragraphs.`;
