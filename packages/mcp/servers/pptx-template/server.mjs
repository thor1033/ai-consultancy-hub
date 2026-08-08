// PowerPoint-template MCP server. Exposes the hub's structured templates so an
// agent can (1) list them, (2) learn what fields each expects, and (3) fill one
// with data into a real .pptx. Rendering is all-Node (pptxgenjs) — see
// ../../pptx-template/render.mjs. Built-in server, resolved by bare name.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderTemplate } from "../../pptx-template/render.mjs";
import { extractPlaceholders } from "../../pptx-template/placeholders.mjs";
import { loadTemplates } from "../../pptx-template/store.mjs";

const server = new McpServer({ name: "pptx-template", version: "0.1.0" });

function json(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

server.registerTool(
  "list_templates",
  {
    description:
      "List the available PowerPoint templates. Returns each template's id, name, " +
      "and slide count. Use this first to pick a template.",
    inputSchema: {},
  },
  async () => {
    const templates = [...loadTemplates().values()].map((t) => ({
      id: t.id,
      name: t.name,
      slides: t.template.slides?.length ?? 0,
    }));
    return json({ templates });
  },
);

server.registerTool(
  "get_template_schema",
  {
    description:
      "Describe the fillable fields of a template so you know exactly what values " +
      "to provide to fill_template. Returns a list of { key, kind } where kind is " +
      "one of text, list, table-rows, chart-series, data.",
    inputSchema: { template_id: z.string().describe("id from list_templates") },
  },
  async ({ template_id }) => {
    const entry = loadTemplates().get(template_id);
    if (!entry) return json({ error: `Unknown template_id: ${template_id}` });
    return json({
      template_id,
      name: entry.name,
      fields: extractPlaceholders(entry.template),
    });
  },
);

server.registerTool(
  "fill_template",
  {
    description:
      "Fill a template with values and render a real .pptx (native charts + tables). " +
      "`values` is a JSON object keyed by the field keys from get_template_schema. " +
      "Returns the path to the generated file.",
    inputSchema: {
      template_id: z.string().describe("id from list_templates"),
      values: z
        .record(z.string(), z.any())
        .describe("Field key -> value (text, list, table rows, or chart series)"),
    },
  },
  async ({ template_id, values }) => {
    const entry = loadTemplates().get(template_id);
    if (!entry) return json({ error: `Unknown template_id: ${template_id}` });

    // Report any required fields the caller left unfilled (no token/bind value).
    const provided = new Set(Object.keys(values ?? {}));
    const missing = extractPlaceholders(entry.template)
      .filter((f) => !f.hasDefault && !provided.has(f.key))
      .map((f) => f.key);

    const { filePath, slides } = await renderTemplate(entry.template, values ?? {});
    return json({
      ok: true,
      filePath,
      slides,
      ...(missing.length ? { warning: `Unfilled fields (rendered empty): ${missing.join(", ")}` } : {}),
    });
  },
);

await server.connect(new StdioServerTransport());
