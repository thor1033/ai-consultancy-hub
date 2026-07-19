// Market-data MCP server (demo). Deterministic mock data — stands in for a real
// market-data feed in the investment-firm use case.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Deterministic pseudo-random in [-1, 1] from a seed string.
function seeded(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

function pct(seed, spread) {
  return +(seeded(seed) * spread).toFixed(2);
}

const INDICES = [
  ["S&P 500", 2.5],
  ["Nasdaq Composite", 3.2],
  ["FTSE 100", 1.8],
  ["Euro Stoxx 50", 2.1],
  ["Gold", 1.4],
  ["US 10Y Treasury yield", 0.3],
];

const server = new McpServer({ name: "market-data", version: "0.1.0" });

server.registerTool(
  "get_market_summary",
  {
    description:
      "Get a summary of major market index returns over a period (e.g. 'week', 'month', 'YTD').",
    inputSchema: { period: z.string().describe("Time period, e.g. week, month, YTD") },
  },
  async ({ period }) => {
    const rows = INDICES.map(([name, spread]) => {
      const change = pct(`${name}:${period}`, spread);
      return `${name}: ${change >= 0 ? "+" : ""}${change}%`;
    });
    return {
      content: [
        {
          type: "text",
          text: `Market summary (${period}):\n${rows.join("\n")}`,
        },
      ],
    };
  },
);

server.registerTool(
  "get_asset_performance",
  {
    description: "Get period returns for a list of asset tickers.",
    inputSchema: {
      tickers: z.array(z.string()).describe("Asset tickers, e.g. [AAPL, MSFT]"),
      period: z.string().describe("Time period, e.g. week, month, YTD"),
    },
  },
  async ({ tickers, period }) => {
    const rows = tickers.map((t) => {
      const change = pct(`${t}:${period}`, 5);
      return `${t}: ${change >= 0 ? "+" : ""}${change}%`;
    });
    return {
      content: [
        { type: "text", text: `Asset performance (${period}):\n${rows.join("\n")}` },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
