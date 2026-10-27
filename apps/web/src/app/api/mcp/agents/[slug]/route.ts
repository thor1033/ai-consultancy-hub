import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticate } from "@ai-hub/authz";
import { wwwAuthenticate } from "@/lib/authz";
import { buildAgentMcpServer, resolveLocalAgent } from "@/lib/mcp/agentServer";

/*
 * One agent's MCP endpoint, for the Claude Code sub-agent synced from it.
 *
 * Stateless and re-authenticated on every request, exactly like /api/mcp — see
 * that route for why. The agent comes from the path, and is only served when
 * the caller may run agents, the agent is placed "local" or "both", and a
 * credential bound to an agent is bound to this one (agentServer.ts).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const principal = await authenticate(request.headers);
  if (!principal) {
    return Response.json(
      { error: "Unauthorized: missing or invalid bearer token." },
      { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate() } },
    );
  }

  const { slug } = await params;
  const resolved = await resolveLocalAgent(principal, slug);
  if ("status" in resolved) {
    return Response.json({ error: resolved.message }, { status: resolved.status });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = await buildAgentMcpServer(principal, resolved.agent);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => {});
  }
}

export async function GET(): Promise<Response> {
  return Response.json(
    { error: "This MCP endpoint is stateless: use POST for JSON-RPC requests." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const DELETE = GET;
