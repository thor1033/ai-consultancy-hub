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
  chartType: z.enum(["bar", "line", "pie", "area"]).default("bar"),
  // series: [{ name, labels?, values }]  — labels may be shared at top level.
  series: or(z.array(z.object({
    name: z.string().optional(),
    labels: z.array(z.union([z.string(), z.number()])).optional(),
    values: z.array(z.number()),
  }))).optional(),
  labels: or(z.array(z.union([z.string(), z.number()]))).optional(),
  title: z.string().optional(),
  showLegend: z.boolean().optional(),
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
