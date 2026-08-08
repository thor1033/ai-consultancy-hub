// A sample WYSIWYG-authored template + the values an agent would supply. This is
// exactly the shape the in-browser editor emits: fixed layout/branding with
// {{tokens}} and { $bind } markers marking the fillable spots. Used by the
// offline verify to prove the render pipeline end-to-end (no API key needed).
//
// It doubles as the reference for a professional, consulting-grade deck: a navy
// cover, an executive-summary KPI band, an action-titled performance slide, and
// a holdings/commentary slide — each on a shared palette with kickers, hairline
// rules, and a running footer (the "template style" the renderer's palette backs).

// LAYOUT_WIDE is 13.333in × 7.5in. One 0.7in margin each side → 11.93in content.
const L = 0.7;
const CW = 11.93;
const R = L + CW; // right edge = 12.63

// Palette echoes the renderer defaults (resolvePalette). Named here so the
// template reads like a designed artifact, not a bag of hex codes.
const INK = "051C2C";
const ACCENT = "2251FF";
const CYAN = "00A9F4";
const WHITE = "FFFFFF";
const MUTED = "6B7684";
const HAIRLINE = "D6DCE4";
const SURFACE = "F2F4F7";
const ON_DARK = "AEB9C7"; // muted text that stays legible on the navy cover

// Shared slide furniture — a kicker (small-caps eyebrow), an action title, the
// hairline rule beneath it, and a running footer. Built as functions so every
// content slide is laid out identically: that consistency is the "template".
const kicker = (text) => ({
  type: "text", x: L, y: 0.55, w: CW, h: 0.32,
  text, fontSize: 13, bold: true, color: ACCENT, charSpacing: 1.5,
});
const title = (text) => ({
  type: "text", x: L, y: 0.92, w: CW, h: 0.72,
  text, fontSize: 24, bold: true, color: INK, fontFace: "Georgia",
});
const rule = { type: "shape", shape: "line", x: L, y: 1.7, w: CW, h: 0, line: HAIRLINE, lineWidth: 1.5 };
const source = (text) => ({
  type: "text", x: L, y: 6.55, w: CW, h: 0.3,
  text, fontSize: 10, italic: true, color: MUTED,
});
const footer = (page) => [
  { type: "shape", shape: "line", x: L, y: 6.98, w: CW, h: 0, line: HAIRLINE, lineWidth: 1 },
  { type: "text", x: L, y: 7.06, w: 9, h: 0.3, text: "AI Hub  ·  {{client_name}} — Weekly Review", fontSize: 10, color: MUTED },
  { type: "text", x: R - 1, y: 7.06, w: 1, h: 0.3, text: String(page), fontSize: 10, color: MUTED, align: "right" },
];

export const sampleTemplate = {
  name: "{{client_name}} Weekly Review",
  layout: "LAYOUT_WIDE",
  theme: { bg: WHITE, ink: INK, accent: ACCENT, accent2: CYAN, muted: MUTED, hairline: HAIRLINE, surface: SURFACE },
  slides: [
    // 1 · Cover — navy, one accent bar, client name set large in serif.
    {
      background: INK,
      elements: [
        { type: "shape", shape: "rect", x: L, y: 1.95, w: 1.25, h: 0.1, fill: ACCENT },
        { type: "text", x: L, y: 2.2, w: 11, h: 0.35, text: "WEEKLY PORTFOLIO REVIEW", fontSize: 13, bold: true, color: CYAN, charSpacing: 2 },
        { type: "text", x: L, y: 2.6, w: 11.9, h: 1.4, text: "{{client_name}}", fontSize: 46, bold: true, color: WHITE, fontFace: "Georgia" },
        { type: "text", x: L, y: 4.15, w: 11.9, h: 0.5, text: "Prepared {{date}}", fontSize: 18, color: ON_DARK },
        { type: "shape", shape: "line", x: L, y: 6.6, w: CW, h: 0, line: "24384A", lineWidth: 1 },
        { type: "text", x: L, y: 6.72, w: 9, h: 0.3, text: "AI Hub  ·  Private & Confidential", fontSize: 11, color: ON_DARK },
      ],
    },
    // 2 · Executive summary — a KPI band framed by hairlines, then takeaways.
    {
      background: WHITE,
      elements: [
        kicker("EXECUTIVE SUMMARY"),
        title("Portfolios advanced {{week_return}} this week, extending the year's gains"),
        rule,
        // KPI band.
        { type: "shape", shape: "line", x: L, y: 1.98, w: CW, h: 0, line: HAIRLINE, lineWidth: 1 },
        { type: "kpi", x: L, y: 2.15, w: 3.6, h: 1.15, label: "Week return", value: "{{week_return}}", caption: "vs. prior week" },
        { type: "shape", shape: "line", x: 4.59, y: 2.2, w: 0, h: 1.0, line: HAIRLINE, lineWidth: 1 },
        { type: "kpi", x: 4.85, y: 2.15, w: 3.6, h: 1.15, label: "Year to date", value: "{{ytd_return}}", caption: "since 1 January" },
        { type: "shape", shape: "line", x: 8.75, y: 2.2, w: 0, h: 1.0, line: HAIRLINE, lineWidth: 1 },
        { type: "kpi", x: 9.0, y: 2.15, w: 3.6, h: 1.15, label: "vs. benchmark", value: "{{benchmark_delta}}", caption: "relative performance", color: CYAN },
        { type: "shape", shape: "line", x: L, y: 3.4, w: CW, h: 0, line: HAIRLINE, lineWidth: 1 },
        // Takeaways.
        { type: "text", x: L, y: 3.75, w: CW, h: 0.35, text: "What matters this week", fontSize: 15, bold: true, color: INK },
        { type: "bullets", x: L, y: 4.2, w: CW, h: 2.2, fontSize: 15, color: INK, items: { $bind: "summary" } },
        ...footer(2),
      ],
    },
    // 3 · Performance — action title, native chart, an "in focus" side panel.
    {
      background: WHITE,
      elements: [
        kicker("PERFORMANCE"),
        title("Equities drove the week's gains across the book"),
        rule,
        { type: "chart", x: L, y: 2.0, w: 7.4, h: 4.2, chartType: "bar",
          title: "Return by asset class (%)", colors: [ACCENT, INK],
          series: { $bind: "return_series" } },
        // Side panel.
        { type: "shape", shape: "rect", x: 8.5, y: 2.0, w: 4.13, h: 4.2, fill: SURFACE, radius: 0.04 },
        { type: "text", x: 8.85, y: 2.35, w: 3.5, h: 0.32, text: "IN FOCUS", fontSize: 12, bold: true, color: ACCENT, charSpacing: 1.5 },
        { type: "text", x: 8.85, y: 2.8, w: 3.5, h: 1.6, text: "Risk assets outperformed as technology earnings beat expectations. Duration was trimmed ahead of the rate decision.", fontSize: 14, color: INK, lineSpacingMultiple: 1.25 },
        { type: "kpi", x: 8.85, y: 4.55, w: 3.5, h: 1.2, label: "Top contributor", value: "Equities", valueSize: 28, caption: "+2.4% this week" },
        source("Source: Portfolio accounting system · AI Hub"),
        ...footer(3),
      ],
    },
    // 4 · Holdings & commentary — bound table beside narrative bullets.
    {
      background: WHITE,
      elements: [
        kicker("HOLDINGS"),
        title("Allocation stays balanced with a modest tilt to equities"),
        rule,
        { type: "table", x: L, y: 2.0, w: 6.2, h: 3.4, fontSize: 13, rows: { $bind: "holdings_table" } },
        { type: "text", x: 7.35, y: 2.0, w: 5.28, h: 0.35, text: "Portfolio commentary", fontSize: 15, bold: true, color: INK },
        { type: "bullets", x: 7.35, y: 2.5, w: 5.28, h: 3.4, fontSize: 14, color: INK, items: { $bind: "commentary" } },
        source("Source: Holdings as of {{date}} · AI Hub"),
        ...footer(4),
      ],
    },
  ],
};

export const sampleValues = {
  client_name: "Acme Family Office",
  date: "8 August 2026",
  week_return: "+1.9%",
  ytd_return: "+11.4%",
  benchmark_delta: "+0.6%",
  summary: [
    "Total portfolio returned +1.9% this week, led by equities on strong technology earnings.",
    "Year-to-date performance of +11.4% remains 0.6pts ahead of the blended benchmark.",
    "Positioning is broadly unchanged; duration trimmed modestly ahead of the rate decision.",
  ],
  return_series: [
    { name: "This week", labels: ["Equities", "Fixed Income", "Alternatives", "Cash"], values: [2.4, 0.3, 1.1, 0.0] },
  ],
  holdings_table: [
    [{ text: "Asset class", options: { bold: true, color: "051C2C", fill: { color: "F2F4F7" } } },
     { text: "Weight", options: { bold: true, color: "051C2C", fill: { color: "F2F4F7" }, align: "right" } },
     { text: "Return", options: { bold: true, color: "051C2C", fill: { color: "F2F4F7" }, align: "right" } }],
    ["Equities", { text: "58%", options: { align: "right" } }, { text: "+2.4%", options: { align: "right" } }],
    ["Fixed Income", { text: "27%", options: { align: "right" } }, { text: "+0.3%", options: { align: "right" } }],
    ["Alternatives", { text: "12%", options: { align: "right" } }, { text: "+1.1%", options: { align: "right" } }],
    ["Cash", { text: "3%", options: { align: "right" } }, { text: "0.0%", options: { align: "right" } }],
  ],
  commentary: [
    "Equities led gains on strong technology earnings and resilient consumer data.",
    "Duration trimmed ahead of the rate decision to reduce rate sensitivity.",
    "Alternatives continued to add diversification with low correlation to public markets.",
    "Cash held near target to preserve flexibility for tactical opportunities.",
  ],
};
