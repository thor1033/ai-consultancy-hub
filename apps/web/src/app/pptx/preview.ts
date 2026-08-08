// Client-safe helpers for rendering a template preview from the structured model.
// Mirrors the server-side resolve() in @ai-hub/mcp/pptx-template — kept standalone
// so the preview never pulls pptxgenjs/node into the browser bundle.

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    obj,
  );
}

// Deep-resolve {{tokens}} and { $bind } markers against `values`.
export function resolveTemplate(node: unknown, values: Record<string, unknown>): unknown {
  if (typeof node === "string") {
    return node.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = get(values, k);
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(node)) return node.map((n) => resolveTemplate(n, values));
  if (node && typeof node === "object") {
    const bind = (node as { $bind?: unknown }).$bind;
    if (typeof bind === "string") {
      const v = get(values, bind);
      return resolveTemplate(
        v === undefined ? (node as { default?: unknown }).default ?? null : v,
        values,
      );
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveTemplate(v, values);
    return out;
  }
  return node;
}

// Slide dimensions in inches per pptxgenjs layout (points/inches share the 72 factor).
export const LAYOUTS: Record<string, { w: number; h: number }> = {
  LAYOUT_WIDE: { w: 13.333, h: 7.5 },
  LAYOUT_16x9: { w: 10, h: 5.625 },
  LAYOUT_16x10: { w: 10, h: 6.25 },
  LAYOUT_4x3: { w: 10, h: 7.5 },
};

export function cssColor(c?: string): string | undefined {
  if (!c) return undefined;
  return c.startsWith("#") ? c : `#${c}`;
}

// Mirrors the renderer's McKinsey-style design system (resolvePalette in
// render.mjs) so the on-screen preview matches the downloaded .pptx.
export const PALETTE = {
  ink: "#051C2C",
  accent: "#2251FF",
  accent2: "#00A9F4",
  muted: "#6B7684",
  hairline: "#D6DCE4",
  surface: "#F2F4F7",
};
// Sequential blues + greys — one data family, not a rainbow.
export const CHART_PALETTE = ["#2251FF", "#051C2C", "#00A9F4", "#8C9BB0", "#1B3A8C", "#C9D1DC"];

// Resolve a deck theme onto the defaults (accepts legacy { bg, accent, text }
// and the richer palette). Kept in lockstep with the renderer.
export function resolvePalette(theme: Record<string, unknown> = {}): typeof PALETTE {
  const pick = (v: unknown, d: string) => (typeof v === "string" && v ? cssColor(v)! : d);
  return {
    ink: pick(theme.ink, PALETTE.ink),
    accent: pick(theme.accent, PALETTE.accent),
    accent2: pick(theme.accent2, PALETTE.accent2),
    muted: pick(theme.muted, PALETTE.muted),
    hairline: pick(theme.hairline, PALETTE.hairline),
    surface: pick(theme.surface, PALETTE.surface),
  };
}
