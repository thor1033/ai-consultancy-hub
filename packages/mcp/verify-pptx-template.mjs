// Verifies the pptx-template pipeline end to end — no API key needed. Covers the
// renderer directly AND the pptx-template MCP server round-trip (list ->
// get_schema -> fill). Mirrors verify-demo.
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderTemplate } from "./pptx-template/render.mjs";
import { parseTemplate } from "./pptx-template/schema.mjs";
import { resolve } from "./pptx-template/render.mjs";
import { sampleTemplate, sampleValues } from "./pptx-template/sample-template.mjs";

const here = dirname(fileURLToPath(import.meta.url));

let ok = true;

// 1. The resolved template must validate against the shared schema — this is the
//    contract the editor and MCP server both rely on.
const resolved = resolve(sampleTemplate, sampleValues);
try {
  parseTemplate(resolved);
  console.log("resolved template: schema OK");
} catch (e) {
  ok = false;
  console.log("resolved template: schema FAILED\n" + e.message);
}

// 2. Tokens and binds must actually be substituted (no leftover {{...}}/$bind).
const asText = JSON.stringify(resolved);
const leftoverToken = /\{\{\s*[\w.]+\s*\}\}/.test(asText);
const leftoverBind = asText.includes("$bind");
if (leftoverToken || leftoverBind) {
  ok = false;
  console.log(`substitution: FAILED (token=${leftoverToken}, bind=${leftoverBind})`);
} else {
  console.log(`substitution: OK (client="${resolved.name}")`);
}

// 3. Render to a real file.
const { filePath, slides } = await renderTemplate(sampleTemplate, sampleValues);
if (existsSync(filePath) && statSync(filePath).size > 0) {
  console.log(`\n.pptx written: ${slides} slides, ${statSync(filePath).size} bytes\n  ${filePath}`);
} else {
  ok = false;
  console.log("\n.pptx NOT written");
}

// 4. MCP server round-trip: list -> get_schema -> fill, as an agent would.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, "servers", "pptx-template", "server.mjs")],
});
const client = new Client({ name: "verify-pptx-template", version: "0.1.0" });
await client.connect(transport);
const parse = (res) => JSON.parse(res.content?.map((b) => b.text ?? "").join("") || "{}");

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`\npptx-template MCP tools: ${tools.join(", ")}`);

const listed = parse(await client.callTool({ name: "list_templates", arguments: {} }));
const first = listed.templates?.[0];
console.log(`  list_templates -> ${listed.templates?.length ?? 0} template(s), first="${first?.id}"`);

const schema = parse(await client.callTool({
  name: "get_template_schema", arguments: { template_id: first.id },
}));
console.log(`  get_template_schema -> ${schema.fields?.length ?? 0} fields: ${schema.fields?.map((f) => `${f.key}:${f.kind}`).join(", ")}`);

const filled = parse(await client.callTool({
  name: "fill_template", arguments: { template_id: first.id, values: sampleValues },
}));
await client.close();

if (filled.ok && filled.filePath && existsSync(filled.filePath) && statSync(filled.filePath).size > 0) {
  console.log(`  fill_template -> ${filled.slides} slides, ${statSync(filled.filePath).size} bytes${filled.warning ? ` (warning: ${filled.warning})` : ""}`);
} else {
  ok = false;
  console.log(`  fill_template -> FAILED: ${JSON.stringify(filled)}`);
}

console.log(ok ? "\npptx-template pipeline OK" : "\npptx-template pipeline FAILED");
process.exit(ok ? 0 : 1);
