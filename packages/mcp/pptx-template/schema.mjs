// The structured PowerPoint template model. This is the single source of truth
// shared by three consumers: the in-browser WYSIWYG editor (produces it), the
// pptx-template MCP server (fills + renders it), and the renderer below.
//
// A template is authored data — never a foreign .pptx — so filling it never
// requires parsing OOXML. Fillable content is expressed two ways:
//   • {{token}} inside any string field   -> replaced from `values`
//   • { "$bind": "key", "default": ... }   -> whole value pulled from `values`
// Both are resolved by resolve() in render.mjs before pptxgenjs ever runs.
import { z } from "zod";

// Geometry is in inches, matching pptxgenjs coordinates.
const geometry = {
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
};

// Any leaf may instead be a bind marker; the editor emits these for data-driven
// fields (chart series, table rows) that the agent fills at run time.
const bindable = z.object({ $bind: z.string(), default: z.any().optional() });
const or = (inner) => z.union([inner, bindable]);

const textEl = z.object({
  type: z.literal("text"),
  ...geometry,
  text: z.string().default(""),
  fontSize: z.number().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: z.string().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  valign: z.enum(["top", "middle", "bottom"]).optional(),
  fontFace: z.string().optional(),
  charSpacing: z.number().optional(),
  lineSpacingMultiple: z.number().optional(),
});

const bulletsEl = z.object({
  type: z.literal("bullets"),
  ...geometry,
  items: or(z.array(z.string())).default([]),
  fontSize: z.number().optional(),
  color: z.string().optional(),
});

const imageEl = z.object({
  type: z.literal("image"),
  ...geometry,
  path: z.string().optional(),
  data: z.string().optional(), // base64 data URI
});

const tableEl = z.object({
  type: z.literal("table"),
  ...geometry,
  rows: or(z.array(z.array(z.any()))).default([]),
  fontSize: z.number().optional(),
});

// A big-number callout (KPI). value/label/caption are plain strings so {{tokens}}
// fill them; the renderer stacks small-caps label · oversized value · caption.
const kpiEl = z.object({
  type: z.literal("kpi"),
  ...geometry,
  value: z.string().default(""),
  label: z.string().optional(),
  caption: z.string().optional(),
  valueSize: z.number().optional(),
  color: z.string().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});

// A decorative primitive: `line` (a hairline rule) or `rect` (a filled band /
// accent bar). Carries no fillable content — it's pure layout / branding.
const shapeEl = z.object({
  type: z.literal("shape"),
  ...geometry,
  shape: z.enum(["rect", "line"]).default("rect"),
  fill: z.string().optional(),
  line: z.string().optional(),
  lineWidth: z.number().optional(),
  radius: z.number().optional(),
});

const chartEl = z.object({
  type: z.literal("chart"),
  ...geometry,
  chartType: z.enum(["bar", "line", "pie", "area", "doughnut", "radar"]).default("bar"),
  // Bar family: direction (col = vertical columns, bar = horizontal) + grouping.
  barDir: z.enum(["col", "bar"]).optional(),
  barGrouping: z.enum(["clustered", "stacked", "percentStacked"]).optional(),
  holeSize: z.number().optional(),   // doughnut inner hole (0–90)
  // series: [{ name, labels?, values }]  — labels may be shared at top level.
  series: or(z.array(z.object({
    name: z.string().optional(),
    labels: z.array(z.union([z.string(), z.number()])).optional(),
    values: z.array(z.number()),
  }))).optional(),
  labels: or(z.array(z.union([z.string(), z.number()]))).optional(),
  title: z.string().optional(),
  showLegend: z.boolean().optional(),
  legendPos: z.enum(["b", "t", "l", "r"]).optional(),
  dataLabels: z.boolean().optional(),   // force value labels on/off
  catAxisTitle: z.string().optional(),
  valAxisTitle: z.string().optional(),
  colors: z.array(z.string()).optional(),
  dataLabelFormatCode: z.string().optional(),
  valAxisLabelFormatCode: z.string().optional(),
});

export const elementSchema = z.discriminatedUnion("type", [
  textEl, bulletsEl, imageEl, tableEl, chartEl, kpiEl, shapeEl,
]);

export const slideSchema = z.object({
  background: z.string().optional(),
  elements: z.array(elementSchema).default([]),
});

export const templateSchema = z.object({
  name: z.string().default("presentation"),
  layout: z.enum(["LAYOUT_WIDE", "LAYOUT_16x9", "LAYOUT_16x10", "LAYOUT_4x3"]).default("LAYOUT_WIDE"),
  // The deck palette. Any token omitted falls back to the renderer's McKinsey
  // defaults (see resolvePalette in render.mjs). `bg`/`text` are the legacy names.
  theme: z.object({
    bg: z.string().optional(),
    text: z.string().optional(),
    accent: z.string().optional(),
    accent2: z.string().optional(),
    ink: z.string().optional(),
    muted: z.string().optional(),
    hairline: z.string().optional(),
    surface: z.string().optional(),
    series: z.array(z.string()).optional(),
  }).optional(),
  slides: z.array(slideSchema).default([]),
});

// Validate a *resolved* template (after binds/tokens are substituted). Raw
// templates from the editor may carry $bind markers, so validate post-resolve.
export function parseTemplate(t) {
  return templateSchema.parse(t);
}

// Resource limits for untrusted (client-supplied) templates. A template is data,
// but an oversized or pathological one can still exhaust memory or the renderer.
export const LIMITS = {
  maxJsonBytes: 1_000_000,   // 1 MB serialized
  maxSlides: 100,
  maxElementsPerSlide: 200,
  maxTotalElements: 2000,
  maxTextLen: 20_000,        // per text/kpi string
  maxImageBytes: 2_000_000,  // per embedded data: image
};

// Structural + resource validation for a *raw* template (may carry $bind /
// {{token}} markers — the schema permits those in bindable positions). Run this
// before persisting or rendering anything a client sent. Returns {ok:true} or
// {ok:false, error}. Does not mutate/return the spec, so extra fields survive.
export function validateTemplate(spec) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(spec)); }
  catch { return { ok: false, error: "Template is not serializable." }; }
  if (bytes > LIMITS.maxJsonBytes) return { ok: false, error: `Template is too large (${bytes} bytes; max ${LIMITS.maxJsonBytes}).` };

  const parsed = templateSchema.safeParse(spec);
  if (!parsed.success) {
    const i = parsed.error.issues?.[0];
    return { ok: false, error: i ? `${i.path.join(".") || "template"}: ${i.message}` : "Template failed validation." };
  }
  const t = parsed.data;
  if (t.slides.length > LIMITS.maxSlides) return { ok: false, error: `Too many slides (max ${LIMITS.maxSlides}).` };
  let total = 0;
  for (const s of t.slides) {
    if (s.elements.length > LIMITS.maxElementsPerSlide) return { ok: false, error: `Too many elements on a slide (max ${LIMITS.maxElementsPerSlide}).` };
    total += s.elements.length;
    for (const el of s.elements) {
      if (el.type === "image") {
        const src = typeof el.data === "string" ? el.data : (typeof el.path === "string" ? el.path : "");
        if (src && !src.startsWith("data:")) return { ok: false, error: "Images must be inline data: URIs, not file paths or URLs." };
        if (src.length > LIMITS.maxImageBytes) return { ok: false, error: "An embedded image is too large." };
      }
      if ((el.type === "text" && typeof el.text === "string" && el.text.length > LIMITS.maxTextLen)
        || (el.type === "kpi" && typeof el.value === "string" && el.value.length > LIMITS.maxTextLen)) {
        return { ok: false, error: "A text value is too long." };
      }
    }
  }
  if (total > LIMITS.maxTotalElements) return { ok: false, error: `Too many elements total (max ${LIMITS.maxTotalElements}).` };
  return { ok: true };
}
