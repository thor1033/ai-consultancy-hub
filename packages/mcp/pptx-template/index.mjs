// Public entry for the pptx-template feature: the structured template model,
// renderer, placeholder extraction, and template store. Consumed by the web app
// (@ai-hub/mcp/pptx-template) and the pptx-template MCP server.
export { renderTemplate, renderTemplateToBuffer, resolve } from "./render.mjs";
export { parseTemplate, templateSchema, validateTemplate, LIMITS } from "./schema.mjs";
export { extractPlaceholders } from "./placeholders.mjs";
export { loadTemplates } from "./store.mjs";
export { sampleTemplate, sampleValues } from "./sample-template.mjs";
