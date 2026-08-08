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
const INK = "051C2C";       // deep navy — titles/body
const ACCENT = "2251FF";    // single brand accent
const MUTED = "6B7684";     // secondary text / axis labels
const GRID = "EDF0F3";      // hairline gridlines / rules
const FONT = "Arial";       // body / labels
const FONT_TITLE = "Georgia"; // action titles (serif)
// Sequential blues + greys — data reads as one professional family, not a rainbow.
const CHART_COLORS = ["2251FF", "051C2C", "00A9F4", "8C9BB0", "1B3A8C", "C9D1DC"];

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

function renderElement(pptx, slide, el) {
  const base = { x: el.x, y: el.y, w: el.w, h: el.h };
  switch (el.type) {
    case "text":
      slide.addText(el.text ?? "", {
        ...base,
        fontSize: el.fontSize ?? 16,
        bold: !!el.bold,
        italic: !!el.italic,
        color: hex(el.color) ?? "1F2937",
        align: el.align ?? "left",
        valign: el.valign ?? "top",
        fontFace: el.fontFace,
      });
      break;
    case "bullets": {
      const items = (el.items ?? []).filter((t) => t != null && t !== "");
      if (items.length) {
        slide.addText(
          items.map((t) => ({ text: String(t), options: { bullet: true } })),
          { ...base, fontSize: el.fontSize ?? 16, color: hex(el.color) ?? "1F2937" },
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
          border: { type: "solid", color: "E5E7EB", pt: 1 },
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
      };
      const data = normalizeChartData(el);
      if (data.length) {
        const isPie = el.chartType === "pie";
        const colors = (el.colors?.map(hex)) ?? CHART_COLORS;
        slide.addChart(typeMap[el.chartType] ?? pptx.ChartType.bar, data, {
          ...base,
          chartColors: colors,
          // Title.
          showTitle: !!el.title,
          title: el.title,
          titleColor: "334155",
          titleFontFace: "Segoe UI",
          titleFontSize: 13,
          // Legend (bottom) when it aids reading.
          showLegend: el.showLegend ?? (isPie || data.length > 1),
          legendPos: "b",
          legendColor: "64748B",
          legendFontFace: "Segoe UI",
          legendFontSize: 10,
          // Data labels.
          showValue: !isPie && el.chartType !== "line",
          showPercent: isPie,
          dataLabelColor: isPie ? "FFFFFF" : "334155",
          dataLabelFontFace: "Segoe UI",
          dataLabelFontSize: 9,
          dataLabelPosition: isPie ? "ctr" : "outEnd",
          // Axes + gridlines for a clean, professional read.
          catAxisLabelColor: "64748B",
          catAxisLabelFontFace: "Segoe UI",
          catAxisLabelFontSize: 10,
          catAxisLineColor: "E5E7EB",
          valAxisLabelColor: "64748B",
          valAxisLabelFontFace: "Segoe UI",
          valAxisLabelFontSize: 10,
          valAxisLineShow: false,
          valGridLine: { color: "EEF2F7", size: 1 },
          barGapWidthPct: 40,
          ...(el.chartType === "line"
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

  for (const s of t.slides ?? []) {
    const slide = pptx.addSlide();
    const bg = s.background ?? theme.bg;
    if (bg) slide.background = { color: hex(bg) };
    for (const el of s.elements ?? []) renderElement(pptx, slide, el);
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
