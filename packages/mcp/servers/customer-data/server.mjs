// Customer-data MCP server (demo). Mock CRM/portfolio data — stands in for the
// firm's real client systems in the investment-firm use case.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CLIENTS = {
  "acme-family": {
    name: "Acme Family Office",
    segment: "Family business",
    riskProfile: "Balanced",
    aum: 42_000_000,
    portfolio: {
      periodReturn: 1.9,
      holdings: [
        { name: "Global Equities", assetClass: "Equity", allocation: 45, value: 18_900_000 },
        { name: "Investment-grade Bonds", assetClass: "Fixed income", allocation: 30, value: 12_600_000 },
        { name: "Private Equity", assetClass: "Alternatives", allocation: 15, value: 6_300_000 },
        { name: "Cash", assetClass: "Cash", allocation: 10, value: 4_200_000 },
      ],
    },
  },
  "smith-hnw": {
    name: "Smith Private Wealth",
    segment: "High-net-worth individual",
    riskProfile: "Growth",
    aum: 8_500_000,
    portfolio: {
      periodReturn: 2.7,
      holdings: [
        { name: "US Tech Equities", assetClass: "Equity", allocation: 55, value: 4_675_000 },
        { name: "Global Equities", assetClass: "Equity", allocation: 25, value: 2_125_000 },
        { name: "High-yield Bonds", assetClass: "Fixed income", allocation: 12, value: 1_020_000 },
        { name: "Cash", assetClass: "Cash", allocation: 8, value: 680_000 },
      ],
    },
  },
};

const money = (n) => `$${n.toLocaleString("en-US")}`;

const server = new McpServer({ name: "customer-data", version: "0.1.0" });

server.registerTool(
  "list_clients",
  { description: "List available client IDs and names.", inputSchema: {} },
  async () => ({
    content: [
      {
        type: "text",
        text: Object.entries(CLIENTS)
          .map(([id, c]) => `${id}: ${c.name} (${c.segment})`)
          .join("\n"),
      },
    ],
  }),
);

server.registerTool(
  "get_client",
  {
    description: "Get a client's profile (segment, risk profile, AUM).",
    inputSchema: { client_id: z.string().describe("Client ID, e.g. acme-family") },
  },
  async ({ client_id }) => {
    const c = CLIENTS[client_id];
    if (!c) return { content: [{ type: "text", text: `Unknown client: ${client_id}` }], isError: true };
    return {
      content: [
        {
          type: "text",
          text: `${c.name}\nSegment: ${c.segment}\nRisk profile: ${c.riskProfile}\nAUM: ${money(c.aum)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "get_portfolio",
  {
    description: "Get a client's portfolio holdings, allocation, and period return.",
    inputSchema: { client_id: z.string().describe("Client ID, e.g. acme-family") },
  },
  async ({ client_id }) => {
    const c = CLIENTS[client_id];
    if (!c) return { content: [{ type: "text", text: `Unknown client: ${client_id}` }], isError: true };
    const p = c.portfolio;
    const rows = p.holdings
      .map((h) => `${h.name} (${h.assetClass}): ${h.allocation}% — ${money(h.value)}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `${c.name} portfolio\nPeriod return: ${p.periodReturn >= 0 ? "+" : ""}${p.periodReturn}%\nTotal: ${money(c.aum)}\n\n${rows}`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
