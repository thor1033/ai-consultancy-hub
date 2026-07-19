// Verifies the investment-firm demo MCP servers end to end — no API key needed.
// Exercises market-data, customer-data, and pptx (produces a real .pptx).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function connect(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "servers", name, "server.mjs")],
  });
  const client = new Client({ name: "verify-demo", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function text(res) {
  return res.content?.map((b) => b.text ?? "").join("\n") ?? "";
}

let ok = true;

const market = await connect("market-data");
console.log("market-data tools:", (await market.listTools()).tools.map((t) => t.name).join(", "));
console.log(text(await market.callTool({ name: "get_market_summary", arguments: { period: "week" } })));
await market.close();

const customer = await connect("customer-data");
console.log("\ncustomer-data tools:", (await customer.listTools()).tools.map((t) => t.name).join(", "));
console.log(text(await customer.callTool({ name: "get_portfolio", arguments: { client_id: "acme-family" } })));
await customer.close();

const pptx = await connect("pptx");
console.log("\npptx tools:", (await pptx.listTools()).tools.map((t) => t.name).join(", "));
const res = await pptx.callTool({
  name: "create_presentation",
  arguments: {
    title: "Acme Family Office — Weekly Review",
    subtitle: "Prepared by the AI Hub",
    sections: [
      { heading: "Market Overview", bullets: ["S&P 500 +2.1%", "FTSE 100 +1.3%"] },
      { heading: "Your Portfolio", body: "Balanced allocation, +1.9% this week." },
    ],
  },
});
const out = text(res);
console.log(out);
await pptx.close();

const path = out.match(/at: (.+\.pptx)/)?.[1];
if (path && existsSync(path) && statSync(path).size > 0) {
  console.log(`\n.pptx written (${statSync(path).size} bytes)`);
} else {
  ok = false;
  console.log("\n.pptx NOT written");
}

console.log(ok ? "\nDemo MCP servers OK" : "\nDemo MCP servers FAILED");
process.exit(ok ? 0 : 1);
