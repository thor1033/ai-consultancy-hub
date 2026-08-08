// Extracts the fillable fields from a template so an agent (or the editor's
// field panel) knows exactly what values to supply. Walks the template for
// {{token}} strings and { $bind } markers and reports each with a breadcrumb.

function walk(node, path, out) {
  if (typeof node === "string") {
    for (const m of node.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      out.push({ key: m[1], kind: "text", where: path });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    if (typeof node.$bind === "string") {
      // Infer the shape expected at this bind from where it sits in the tree.
      const kind = path.endsWith(".series") ? "chart-series"
        : path.endsWith(".rows") ? "table-rows"
        : path.endsWith(".items") ? "list"
        : "data";
      out.push({ key: node.$bind, kind, where: path, hasDefault: node.default !== undefined });
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, out);
  }
}

// Returns a de-duplicated list of { key, kind, where, hasDefault? }.
export function extractPlaceholders(template) {
  const raw = [];
  walk(template, "", raw);
  const seen = new Map();
  for (const p of raw) {
    // Keep the richest description per key (a bind beats a bare text token).
    const prev = seen.get(p.key);
    if (!prev || (prev.kind === "text" && p.kind !== "text")) seen.set(p.key, p);
  }
  return [...seen.values()];
}
