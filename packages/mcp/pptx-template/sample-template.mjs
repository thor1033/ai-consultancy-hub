// A sample WYSIWYG-authored template + the values an agent would supply. This is
// exactly the shape the in-browser editor emits: fixed layout/branding with
// {{tokens}} and { $bind } markers marking the fillable spots. Used by the
// offline verify to prove the render pipeline end-to-end (no API key needed).

export const sampleTemplate = {
  name: "{{client_name}} Weekly Review",
  layout: "LAYOUT_WIDE",
  theme: { bg: "0B1220", accent: "6EE7B7", text: "FFFFFF" },
  slides: [
    // Title slide (branding fixed, client + date filled).
    {
      background: "0B1220",
      elements: [
        { type: "text", x: 0.6, y: 2.1, w: 12, h: 1.2, text: "{{client_name}} — Weekly Review",
          fontSize: 40, bold: true, color: "FFFFFF" },
        { type: "text", x: 0.6, y: 3.4, w: 12, h: 0.6, text: "Prepared {{date}} · AI Hub",
          fontSize: 20, color: "6EE7B7" },
      ],
    },
    // Performance slide: KPI text + a native bar chart driven by bound data.
    {
      background: "FFFFFF",
      elements: [
        { type: "text", x: 0.6, y: 0.4, w: 12, h: 0.8, text: "Portfolio Performance",
          fontSize: 26, bold: true, color: "0B1220" },
        { type: "text", x: 0.6, y: 1.3, w: 6, h: 0.6, text: "Week return: {{week_return}}",
          fontSize: 18, bold: true, color: "059669" },
        { type: "chart", x: 0.6, y: 2.0, w: 12, h: 4.5, chartType: "bar",
          title: "Return by asset class (%)", colors: ["6EE7B7", "0B1220"],
          series: { $bind: "return_series" } },
      ],
    },
    // Holdings slide: a bound table + narrative bullets.
    {
      background: "FFFFFF",
      elements: [
        { type: "text", x: 0.6, y: 0.4, w: 12, h: 0.8, text: "Holdings & Commentary",
          fontSize: 26, bold: true, color: "0B1220" },
        { type: "table", x: 0.6, y: 1.4, w: 6.5, h: 3, rows: { $bind: "holdings_table" } },
        { type: "bullets", x: 7.4, y: 1.4, w: 5.2, h: 3, color: "1F2937",
          items: { $bind: "commentary" } },
      ],
    },
  ],
};

export const sampleValues = {
  client_name: "Acme Family Office",
  date: "8 Aug 2026",
  week_return: "+1.9%",
  return_series: [
    { name: "This week", labels: ["Equities", "Fixed Income", "Alts", "Cash"], values: [2.4, 0.3, 1.1, 0.0] },
  ],
  holdings_table: [
    [{ text: "Asset", options: { bold: true, fill: { color: "F1F5F9" } } },
     { text: "Weight", options: { bold: true, fill: { color: "F1F5F9" } } },
     { text: "Return", options: { bold: true, fill: { color: "F1F5F9" } } }],
    ["Equities", "58%", "+2.4%"],
    ["Fixed Income", "27%", "+0.3%"],
    ["Alternatives", "12%", "+1.1%"],
    ["Cash", "3%", "0.0%"],
  ],
  commentary: [
    "Equities led gains on strong tech earnings.",
    "Duration trimmed ahead of the rate decision.",
    "Alternatives added diversification with low correlation.",
  ],
};
