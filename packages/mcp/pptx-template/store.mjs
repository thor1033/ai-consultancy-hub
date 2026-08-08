// Template store. Phase-1 seam: templates load from a directory of JSON files
// (HUB_TEMPLATE_DIR) plus the bundled sample. Phase 2 swaps this for the DB
// `templates` table without changing the MCP server or renderer.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sampleTemplate } from "./sample-template.mjs";

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "template";
}

// Returns Map<id, { id, name, template }>.
export function loadTemplates() {
  const store = new Map();

  // Always available: the bundled sample (proves the pipeline end-to-end).
  store.set("sample-weekly-review", {
    id: "sample-weekly-review",
    name: sampleTemplate.name,
    template: sampleTemplate,
  });

  const dir = process.env.HUB_TEMPLATE_DIR;
  if (dir && existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const template = JSON.parse(readFileSync(join(dir, file), "utf8"));
        const id = template.id ?? slug(file.replace(/\.json$/, ""));
        store.set(id, { id, name: template.name ?? id, template });
      } catch {
        // Skip malformed template files rather than crashing the server.
      }
    }
  }

  return store;
}
