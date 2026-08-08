import { sampleTemplate, sampleValues, extractPlaceholders } from "@ai-hub/mcp/pptx-template";
import { listTemplates, getTemplate } from "@ai-hub/db";

// Bridges the pptx Studio to storage: the bundled sample template (in code, a
// starting point) plus user-saved templates (in the DB). One resolution path so
// the page, the render action, and AI fill all agree on what a template id means.

export const SAMPLE_ID = "sample-weekly-review";
const SAMPLE_NAME = "Sample: Weekly Review";

export interface StudioField {
  key: string;
  kind: "text" | "list" | "table-rows" | "chart-series" | "data";
  where: string;
  hasDefault?: boolean;
}

export interface StudioTemplate {
  id: string;
  name: string;
  slides: number;
  fields: StudioField[];
  template: unknown;
  prefill: string;
  stored: boolean;
}

function toStudio(id: string, name: string, spec: unknown, stored: boolean): StudioTemplate {
  const slides = (spec as { slides?: unknown[] }).slides?.length ?? 0;
  return {
    id,
    name,
    slides,
    fields: extractPlaceholders(spec) as StudioField[],
    template: spec,
    // Prefill the sample with sample data so it previews on open; others blank.
    prefill: JSON.stringify(id === SAMPLE_ID ? sampleValues : {}, null, 2),
    stored,
  };
}

// The sample plus every stored template. If the DB is unreachable we still return
// the sample so the Studio is usable.
export async function allStudioTemplates(): Promise<StudioTemplate[]> {
  const list: StudioTemplate[] = [toStudio(SAMPLE_ID, SAMPLE_NAME, sampleTemplate, false)];
  try {
    const rows = await listTemplates();
    for (const r of rows) list.push(toStudio(r.id, r.name, r.spec, true));
  } catch {
    /* DB down — the sample alone still lets the user work. */
  }
  return list;
}

// Resolve a template id to its spec (for render / AI fill when the client didn't
// send an edited spec).
export async function resolveTemplateSpec(id: string): Promise<unknown | null> {
  if (id === SAMPLE_ID) return sampleTemplate;
  try {
    const row = await getTemplate(id);
    return row?.spec ?? null;
  } catch {
    return null;
  }
}
