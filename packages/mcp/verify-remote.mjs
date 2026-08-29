// Standalone verification of the REMOTE (Streamable HTTP) MCP transport — no
// API key, no database. Stands up a throwaway HTTP MCP server that requires a
// bearer token, then drives it through the hub's own client path
// (remoteServerConfig -> connectMcpServers) exactly as a run would.
//
// This is the transport the PM-tool's /api/mcp endpoint will speak.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const TOKEN = randomUUID();

// --- the throwaway remote server -------------------------------------------
// Stateless: a fresh server+transport per request, no session id. That's the
// shape a serverless deployment (PM-tool on Vercel) has to use.
function buildServer() {
  const server = new McpServer({ name: "verify-remote", version: "0.1.0" });
  server.registerTool(
    "whoami",
    {
      description: "Return the caller identity the server resolved from the request.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: "hub" }] }),
  );
  server.registerTool(
    "echo",
    { description: "Echo a message back.", inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
  );
  return server;
}

function readBody(req) {
  return new Promise((resolve) => {
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
}

const http = createServer(async (req, res) => {
  // The guard the PM-tool will have: fail closed, before any MCP handling.
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
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
});

await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${http.address().port}/mcp`;

// --- drive it through the hub's client path ---------------------------------
process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({
  "verify-remote": {
    url,
    label: "Verify remote",
    description: "Throwaway remote server used by verify-remote.mjs.",
    tokenEnv: "VERIFY_REMOTE_TOKEN",
  },
});
process.env.VERIFY_REMOTE_TOKEN = TOKEN;

// Imported from the module files directly (not ./src/index.ts): the sources use
// bundler-style extensionless imports, which Node's ESM resolver won't follow.
// Node ≥22 strips the types; both modules only import types across files.
const { connectMcpServers } = await import("./src/manager.ts");
const { remoteServerConfig, remoteServerNames, remoteServerInfo } = await import(
  "./src/remote.ts"
);

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

check("remote server is declared", remoteServerNames().includes("verify-remote"));
check("registry info reports it configured", remoteServerInfo()[0]?.configured === true);

const cfg = remoteServerConfig("verify-remote");
check("config carries the bearer header", cfg?.headers?.authorization === `Bearer ${TOKEN}`);

const mcp = await connectMcpServers([cfg]);
const names = mcp.tools.map((t) => t.name).sort();
check("tools discovered over HTTP", names.join(",") === "echo,whoami", names.join(", "));
check(
  "tool schemas survive the transport",
  mcp.tools.find((t) => t.name === "echo")?.input_schema?.properties?.message?.type === "string",
);

const echoed = await mcp.execute("echo", { message: "pm-tool" });
check("tool call round-trips", echoed === "echo: pm-tool", echoed);
await mcp.close();

// --- the credential must actually be enforced -------------------------------
process.env.VERIFY_REMOTE_TOKEN = "wrong-token";
let denied = "";
try {
  await connectMcpServers([remoteServerConfig("verify-remote")]);
  denied = "connected anyway";
} catch (e) {
  denied = e.message;
}
check(
  "bad credential is refused, error names the server",
  denied.includes('"verify-remote"') && !denied.includes("connected anyway"),
  denied,
);

http.close();

const failed = checks.filter((c) => !c.ok);
console.log(
  failed.length === 0
    ? `\nRemote MCP transport OK (${checks.length} checks)`
    : `\nRemote MCP transport FAILED (${failed.length}/${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
