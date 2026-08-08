// Renders a structured template (see schema.mjs) + a values object into a real
// .pptx via pptxgenjs. All-Node, no OOXML surgery, no python sidecar: because
// the template is authored data, we generate the deck rather than edit a file.
import pptxgen from "pptxgenjs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT_DIR = process.env.HUB_OUTPUT_DIR ?? join(tmpdir(), "ai-hub-outputs");

// Professional ("consulting-grade") design system — mirrored in the preview
// (apps/web/src/app/pptx/preview.ts). Restrained palette: deep-navy ink, one
// blue accent, sequential blues + greys for data. Serif titles, sans body.
const FONT = "Arial";          // body / labels
const FONT_TITLE = "Georgia";  // action titles + big numbers (serif)

// The template palette. A deck theme may override any token; anything it omits
// falls back to these McKinsey-style defaults so every deck is coherent by
// default. Sequential blues + greys make data read as one family, not a rainbow.
const DEFAULT_PALETTE = {
  ink: "051C2C",       // deep navy — titles, primary text, dark backgrounds
  accent: "2251FF",    // single brand accent — rules, emphasis, primary series
  accent2: "00A9F4",   // cyan — secondary emphasis
  muted: "6B7684",     // captions, axis + legend labels, sources
  hairline: "D6DCE4",  // rules, gridlines, table borders
  surface: "F2F4F7",   // table header / band fills
  onDark: "FFFFFF",    // text on the ink background
  series: ["2251FF", "051C2C", "00A9F4", "8C9BB0", "1B3A8C", "C9D1DC"],
};

// Merge a template theme onto the defaults. Accepts both the legacy shape
// ({ bg, accent, text }) and the richer palette, so old templates still resolve.
function resolvePalette(theme = {}) {
  const p = { ...DEFAULT_PALETTE };
  if (theme.accent) p.accent = hex(theme.accent);
  if (theme.accent2) p.accent2 = hex(theme.accent2);
  if (theme.ink) p.ink = hex(theme.ink);
  if (theme.muted) p.muted = hex(theme.muted);
  if (theme.hairline) p.hairline = hex(theme.hairline);
  if (theme.surface) p.surface = hex(theme.surface);
  if (Array.isArray(theme.series) && theme.series.length) p.series = theme.series.map(hex);
  return p;
}

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Deep-resolve {{tokens}} in strings and { $bind } markers against `values`.
export function resolve(node, values) {
  if (typeof node === "string") {
    return node.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = get(values, k);
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(node)) return node.map((n) => resolve(n, values));
  if (node && typeof node === "object") {
    if (typeof node.$bind === "string") {
      const v = get(values, node.$bind);
      return resolve(v === undefined ? node.default ?? null : v, values);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolve(v, values);
    return out;
  }
  return node;
}

const hex = (c) => (c ? String(c).replace(/^#/, "") : undefined);

function normalizeChartData(el) {
  // Accept { series:[{name,labels,values}], labels } — labels may be shared.
  const series = Array.isArray(el.series) ? el.series : [];
  const shared = Array.isArray(el.labels) ? el.labels : undefined;
  return series
    .filter((s) => Array.isArray(s?.values) && s.values.length > 0)
    .map((s, i) => ({
      name: s.name ?? `Series ${i + 1}`,
      labels: (s.labels ?? shared ?? s.values.map((_, j) => String(j + 1))).map(String),
      values: s.values,
    }));
}

function renderElement(pptx, slide, el, pal) {
  const base = { x: el.x, y: el.y, w: el.w, h: el.h };
  switch (el.type) {
    case "text":
      slide.addText(el.text ?? "", {
        ...base,
        fontSize: el.fontSize ?? 16,
        bold: !!el.bold,
        italic: !!el.italic,
        color: hex(el.color) ?? pal.ink,
        align: el.align ?? "left",
        valign: el.valign ?? "top",
        charSpacing: el.charSpacing,
        lineSpacingMultiple: el.lineSpacingMultiple,
        fontFace: el.fontFace ?? FONT,
      });
      break;
    case "kpi": {
      // A big-number callout: small-caps label, oversized value, muted caption.
      const accent = hex(el.color) ?? pal.accent;
      const capH = 0.3;
      if (el.label) {
        slide.addText(String(el.label).toUpperCase(), {
          x: el.x, y: el.y, w: el.w, h: capH,
          fontSize: 11, bold: true, color: pal.muted, charSpacing: 1.5,
          fontFace: FONT, align: el.align ?? "left", valign: "top",
        });
      }
      slide.addText(String(el.value ?? ""), {
        x: el.x, y: el.y + (el.label ? capH : 0), w: el.w,
        h: el.h - (el.label ? capH : 0) - (el.caption ? capH : 0),
        fontSize: el.valueSize ?? 40, bold: true, color: accent,
        fontFace: FONT_TITLE, align: el.align ?? "left", valign: "middle",
      });
      if (el.caption) {
        slide.addText(String(el.caption), {
          x: el.x, y: el.y + el.h - capH, w: el.w, h: capH,
          fontSize: 11, color: pal.muted, fontFace: FONT,
          align: el.align ?? "left", valign: "top",
        });
      }
      break;
    }
    case "shape": {
      // Rules, accent bars, bands. `line` draws a hairline; `rect` fills a block.
      if (el.shape === "line") {
        slide.addShape(pptx.ShapeType.line, {
          ...base,
          line: { color: hex(el.line) ?? pal.hairline, width: el.lineWidth ?? 1 },
        });
      } else {
        slide.addShape(pptx.ShapeType.rect, {
          ...base,
          fill: { color: hex(el.fill) ?? pal.accent },
          line: el.line ? { color: hex(el.line), width: el.lineWidth ?? 1 } : { type: "none" },
          rectRadius: el.radius,
        });
      }
      break;
    }
    case "bullets": {
      const items = (el.items ?? []).filter((t) => t != null && t !== "");
      if (items.length) {
        slide.addText(
          items.map((t) => ({
            text: String(t),
            options: { bullet: { code: "2022", indent: 16 } },
          })),
          {
            ...base,
            fontSize: el.fontSize ?? 15,
            color: hex(el.color) ?? pal.ink,
            fontFace: FONT,
            lineSpacingMultiple: 1.15,
            paraSpaceAfter: 8,
            valign: el.valign ?? "top",
          },
        );
      }
      break;
    }
    case "image":
      if (el.path) slide.addImage({ ...base, path: el.path });
      else if (el.data) slide.addImage({ ...base, data: el.data });
      break;
    case "table": {
      const rows = (el.rows ?? [])
        .map((r) => (Array.isArray(r) ? r : [r]))
        .map((r) => r.map((cell) =>
          cell && typeof cell === "object" && !Array.isArray(cell)
            ? cell
            : { text: String(cell ?? "") },
        ));
      if (rows.length) {
        slide.addTable(rows, {
          ...base,
          fontSize: el.fontSize ?? 12,
          fontFace: FONT,
          color: pal.ink,
          valign: "middle",
          margin: [4, 7, 4, 7],
          border: { type: "solid", color: pal.hairline, pt: 0.75 },
        });
      }
      break;
    }
    case "chart": {
      const typeMap = {
        bar: pptx.ChartType.bar,
        line: pptx.ChartType.line,
        pie: pptx.ChartType.pie,
        area: pptx.ChartType.area,
        doughnut: pptx.ChartType.doughnut,
        radar: pptx.ChartType.radar,
      };
      const data = normalizeChartData(el);
      if (data.length) {
        const kind = el.chartType ?? "bar";
        const isCircular = kind === "pie" || kind === "doughnut";
        const isBar = kind === "bar";
        const grouping = el.barGrouping ?? "clustered";
        const stacked = isBar && (grouping === "stacked" || grouping === "percentStacked");
        const colors = (el.colors?.map(hex)) ?? pal.series;
        // Value labels: circular charts show a % share; bars show values by
        // default (off when stacked, to avoid clutter); line/area stay clean.
        const showValue = isCircular ? false : (el.dataLabels ?? (isBar && !stacked));
        slide.addChart(typeMap[kind] ?? pptx.ChartType.bar, data, {
          ...base,
          chartColors: colors,
          ...(kind === "doughnut" ? { holeSize: el.holeSize ?? 55 } : {}),
          ...(isBar ? { barDir: el.barDir ?? "col", barGrouping: grouping } : {}),
          ...(kind === "radar" ? { radarStyle: "standard" } : {}),
          // Title.
          showTitle: !!el.title,
          title: el.title,
          titleColor: pal.ink,
          titleFontFace: FONT,
          titleFontSize: 13,
          // Legend.
          showLegend: el.showLegend ?? (isCircular || data.length > 1),
          legendPos: el.legendPos ?? "b",
          legendColor: pal.muted,
          legendFontFace: FONT,
          legendFontSize: 10,
          // Data labels.
          showValue,
          showPercent: isCircular,
          dataLabelColor: isCircular ? "FFFFFF" : pal.muted,
          dataLabelFontFace: FONT,
          dataLabelFontSize: 9,
          dataLabelPosition: isCircular ? "ctr" : "outEnd",
          // Circular labels read as a % share; bars/lines keep one decimal.
          dataLabelFormatCode: el.dataLabelFormatCode ?? (isCircular ? "0%" : "#,##0.0"),
          valAxisLabelFormatCode: el.valAxisLabelFormatCode,
          // Axis titles (bar/line/area only).
          showCatAxisTitle: !!el.catAxisTitle,
          catAxisTitle: el.catAxisTitle,
          catAxisTitleColor: pal.muted,
          catAxisTitleFontSize: 10,
          showValAxisTitle: !!el.valAxisTitle,
          valAxisTitle: el.valAxisTitle,
          valAxisTitleColor: pal.muted,
          valAxisTitleFontSize: 10,
          // Axes + gridlines for a clean, professional read.
          catAxisLabelColor: pal.muted,
          catAxisLabelFontFace: FONT,
          catAxisLabelFontSize: 10,
          catAxisLineColor: pal.hairline,
          valAxisLabelColor: pal.muted,
          valAxisLabelFontFace: FONT,
          valAxisLabelFontSize: 10,
          valAxisLineShow: false,
          valGridLine: { color: pal.hairline, size: 1 },
          barGapWidthPct: 45,
          ...(kind === "line"
            ? { lineDataSymbol: "circle", lineDataSymbolSize: 5, lineSize: 2 }
            : {}),
        });
      }
      break;
    }
  }
}

// Build a pptxgen deck from `template` filled with `values` (shared by the file
// and buffer renderers). Returns { pptx, slides, safeName }.
function buildDeck(template, values) {
  const t = resolve(template, values);
  const pptx = new pptxgen();
  pptx.layout = t.layout ?? "LAYOUT_WIDE";
  const theme = t.theme ?? {};
  const pal = resolvePalette(theme);

  for (const s of t.slides ?? []) {
    const slide = pptx.addSlide();
    const bg = s.background ?? theme.bg;
    if (bg) slide.background = { color: hex(bg) };
    for (const el of s.elements ?? []) renderElement(pptx, slide, el, pal);
  }

  const safeName = (t.name ?? "presentation")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "presentation";
  return { pptx, slides: (t.slides ?? []).length, safeName };
}

// Render `template` filled with `values` to a .pptx on disk (MCP/CLI use).
// Returns { filePath, slides }.
export async function renderTemplate(template, values = {}) {
  const { pptx, slides, safeName } = buildDeck(template, values);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = join(OUTPUT_DIR, `${safeName}-${Date.now()}.pptx`);
  await pptx.writeFile({ fileName: filePath });
  return { filePath, slides };
}

// Render to an in-memory buffer for HTTP download (web use — no disk needed).
// Returns { buffer, slides, fileName }.
export async function renderTemplateToBuffer(template, values = {}) {
  const { pptx, slides, safeName } = buildDeck(template, values);
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return { buffer, slides, fileName: `${safeName}.pptx` };
}
