"use server";

import { renderTemplateToBuffer, extractPlaceholders } from "@ai-hub/mcp/pptx-template";
import { createTemplate, updateTemplate, deleteTemplate } from "@ai-hub/db";
import { runSession } from "@/lib/runSession";
import { allStudioTemplates, resolveTemplateSpec, SAMPLE_ID } from "@/lib/pptxTemplates";

// Pull the first balanced JSON object out of an agent's text reply (it may wrap
// it in prose or ```json fences).
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SHAPE_GUIDE = [
  "text -> a string",
  "list -> an array of strings",
  "table-rows -> an array of arrays (first row is the header row)",
  "chart-series -> an array of { name, labels: string[], values: number[] }",
  "data -> the value that fits where it is used",
].join("\n");

// Server action: render a template with the given values into a .pptx and hand
// the bytes back (base64) so the browser can download them. Runs server-trusted
// like the other dashboard actions; no ANTHROPIC key needed — this is the
// deterministic fill path, so it's fully testable without a live agent turn.
export async function generateDeckAction(templateId: string, valuesJson: string, templateJson?: string) {
  // Render the edited template if the client sent one; otherwise the stored one.
  let template: unknown;
  if (templateJson && templateJson.trim()) {
    try {
      template = JSON.parse(templateJson);
    } catch {
      return { error: "Edited template is not valid JSON." };
    }
  } else {
    template = await resolveTemplateSpec(templateId);
    if (!template) return { error: `Unknown template: ${templateId}` };
  }

  let values: Record<string, unknown> = {};
  const trimmed = valuesJson.trim();
  if (trimmed) {
    try {
      values = JSON.parse(trimmed);
    } catch {
      return { error: "Values must be valid JSON." };
    }
  }

  try {
    const { buffer, slides, fileName } = await renderTemplateToBuffer(template, values);
    return { fileName, slides, base64: Buffer.from(buffer).toString("base64") };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Generation failed." };
  }
}

// The real fill path: an agent generates the values JSON for a template. It sees
// the template's field schema and can pull live figures from the data MCP
// servers, then returns a values object the hub previews and renders. Needs
// ANTHROPIC_API_KEY (like the Workbench) — the deterministic path above does not.
export async function fillWithAiAction(templateId: string, context: string) {
  const spec = await resolveTemplateSpec(templateId);
  if (!spec) return { error: `Unknown template: ${templateId}` };

  const fields = extractPlaceholders(spec);
  const system =
    "You fill PowerPoint templates. You reply with ONLY a single JSON object mapping " +
    "each field key to its value — no prose, no code fences.";
  const prompt =
    `Fields to fill (key: kind):\n${fields.map((f) => `- ${f.key}: ${f.kind}`).join("\n")}\n\n` +
    `Value shapes:\n${SHAPE_GUIDE}\n\n` +
    `Request: ${context.trim() || "Generate realistic, coherent sample data for this deck."}\n` +
    `Where relevant, use the market-data and customer-data tools for real figures. ` +
    `Return ONLY the JSON object.`;

  try {
    const { result } = await runSession({
      prompt,
      system,
      servers: ["market-data", "customer-data"],
      effort: "low",
    });
    const values = extractJson(result.text);
    if (!values) return { error: "The agent did not return valid JSON.", raw: result.text };
    return {
      valuesJson: JSON.stringify(values, null, 2),
      model: result.model,
      costUsd: result.costUsd,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI fill failed." };
  }
}

// Persist an edited template. Editing the built-in sample (or any non-stored id)
// creates a new stored template; editing a stored one updates it in place.
// Returns the saved id and the refreshed template list.
export async function saveTemplateAction(id: string, name: string, templateJson: string, isNew: boolean) {
  let spec: unknown;
  try {
    spec = JSON.parse(templateJson);
  } catch {
    return { error: "Template is not valid JSON." };
  }
  const cleanName = name.trim() || "Untitled template";

  try {
    const row = isNew
      ? await createTemplate(cleanName, spec)
      : await updateTemplate(id, cleanName, spec);
    if (!row) return { error: "Template not found to update." };
    return { id: row.id, templates: await allStudioTemplates() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed." };
  }
}

export async function deleteTemplateAction(id: string) {
  if (id === SAMPLE_ID) return { error: "The sample template can't be deleted." };
  try {
    await deleteTemplate(id);
    return { templates: await allStudioTemplates() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Delete failed." };
  }
}
