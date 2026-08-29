// A remote (Streamable HTTP) MCP server for local testing — the HTTP sibling of
// sample-server/server.mjs. It stands in for the PM-tool's future /api/mcp
// endpoint so the hub's remote path can be exercised without running PM-tool.
//
//   npm run mcp:remote-fixture -w @ai-hub/mcp     # listens on :8790
//
// Then declare it in apps/web/.env.local:
//   HUB_REMOTE_MCP_SERVERS={"pm-tool":{"url":"http://127.0.0.1:8790/mcp","label":"PM-tool","description":"Read-only project delivery data.","tokenEnv":"PM_TOOL_MCP_TOKEN"}}
//   PM_TOOL_MCP_TOKEN=dev-pm-token
//
// Stateless (a fresh server + transport per request, no session id) — the shape a
// serverless deployment has to use, and the shape the real endpoint will take.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const TOKEN = process.env.PM_TOOL_MCP_TOKEN ?? "dev-pm-token";
const PORT = Number(process.env.PORT ?? 8790);

// Canned data shaped like the PM-tool's real working set.
const PROJECTS = [
  { id: "p-helios", name: "Helios ERP rollout", code: "HEL", tasks: 42, done: 17 },
  { id: "p-intranet", name: "Intranet refresh", code: "INT", tasks: 18, done: 18 },
];
const TASKS = {
  "p-helios": [
    { id: "t-1", title: "Finance data migration dry run", status: "doing", owner: "AM" },
    { id: "t-2", title: "Cutover comms to plant managers", status: "todo", owner: "TS" },
  ],
  "p-intranet": [{ id: "t-9", title: "Retire legacy CMS", status: "done", owner: "TS" }],
};

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

function buildServer() {
  const s = new McpServer({ name: "pm-tool-fixture", version: "0.1.0" });

  s.registerTool(
    "pm_list_projects",
    { description: "List the projects in the workspace.", inputSchema: {} },
    async () => json(PROJECTS),
  );

  s.registerTool(
    "pm_get_project",
    {
      description: "Get one project's working set (board, risks, scope, business case).",
      inputSchema: { projectId: z.string().describe("The project id, e.g. p-helios.") },
    },
    async ({ projectId }) => {
      const p = PROJECTS.find((x) => x.id === projectId);
      if (!p) return { isError: true, content: [{ type: "text", text: `No project ${projectId}` }] };
      return json({ ...p, tasks: TASKS[projectId] ?? [] });
    },
  );

  s.registerTool(
    "pm_list_tasks",
    {
      description: "List a project's tasks, optionally filtered by status.",
      inputSchema: {
        projectId: z.string(),
        status: z.string().optional().describe("todo | doing | done"),
      },
    },
    async ({ projectId, status }) => {
      const rows = TASKS[projectId] ?? [];
      return json(status ? rows.filter((t) => t.status === status) : rows);
    },
  );

  return s;
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });

createServer(async (req, res) => {
  // The guard the real endpoint will have: fail closed, before any MCP handling.
  if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  const body = await readBody(req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await buildServer().connect(transport);
  await transport.handleRequest(req, res, body);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`remote MCP fixture listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`bearer token: ${TOKEN}`);
});
