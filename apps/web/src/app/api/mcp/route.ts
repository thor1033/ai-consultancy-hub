import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticate } from "@ai-hub/authz";
import { wwwAuthenticate } from "@/lib/authz";
import { buildHubMcpServer } from "@/lib/mcp/hubServer";
import { appBaseUrl } from "@/lib/baseUrl";

/*
 * The hub as an MCP server: the endpoint Claude Code connects to.
 *
 * Stateless, one server + transport per request. The hub is a long-running
 * container and *could* hold a session, but a session buys nothing here — every
 * tool returns a single result, nothing streams, and a stateless endpoint
 * re-authenticates on every call instead of trusting a session id issued to a
 * token that may since have been revoked.
 *
 * Auth is OAuth 2.1: this endpoint is a protected resource, AuthKit is the
 * authorization server, and an unauthenticated caller is told where to get a
 * token via the `resource_metadata` challenge below (RFC 9728). Credentials
 * issued from /admin also work, for clients that cannot do OAuth.
 * middleware.ts lists /api/* as unauthenticated for AuthKit precisely so this
 * can answer its own 401 in JSON rather than redirecting a machine to a
 * sign-in page it cannot follow.
 */

// postgres.js holds a TCP pool and the RAG path is Node-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return Response.json(
    { error: "Unauthorized: missing or invalid bearer token." },
    {
      status: 401,
      // Points a spec-compliant MCP client at this server's resource metadata,
      // which is how it discovers the authorization server and begins the flow
      // — rather than leaving it to guess at a bare 401.
      headers: { "WWW-Authenticate": wwwAuthenticate() },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  const principal = await authenticate(request.headers);
  if (!principal) return unauthorized();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = await buildHubMcpServer(principal, { baseUrl: appBaseUrl(request.headers) });
  await server.connect(transport);

  try {
    return await transport.handleRequest(request);
  } finally {
    // The server is bound to this token's principal; nothing outlives the request.
    await server.close().catch(() => {});
  }
}

// A stateless endpoint offers neither a server-initiated SSE stream (GET) nor
// session teardown (DELETE). Saying so beats Next's generic 405.
export async function GET(): Promise<Response> {
  return Response.json(
    { error: "This MCP endpoint is stateless: use POST for JSON-RPC requests." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const DELETE = GET;
