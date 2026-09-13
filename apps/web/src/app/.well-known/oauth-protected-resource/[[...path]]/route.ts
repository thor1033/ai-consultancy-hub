import { mcpResource, oauthConfig } from "@ai-hub/authz";
import { appBaseUrl } from "@/lib/baseUrl";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * This one document is what makes the hub reachable from an enterprise AI
 * surface. A client gets a 401 carrying `resource_metadata`, fetches this, and
 * learns which authorization server to go to — no per-vendor integration, no
 * configuration pasted into a form. ChatGPT's connector scan and Copilot's
 * federated connectors both start here.
 *
 * Served from an optional catch-all because RFC 9728 locates the document by
 * inserting the well-known segment *before* the resource's path: the metadata
 * for `https://hub.example.com/api/mcp` lives at
 * `/.well-known/oauth-protected-resource/api/mcp`. Clients in the wild request
 * both that and the bare path, and answering only one of them strands half of
 * them on a 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cors(headers: Headers = new Headers()): Headers {
  // Browser-based clients fetch this cross-origin before they hold any
  // credential. It is a public discovery document — there is nothing here to
  // protect, and refusing the preflight just makes the hub undiscoverable.
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  return headers;
}

export async function GET(request: Request): Promise<Response> {
  const config = oauthConfig();
  const resource = mcpResource() ?? `${appBaseUrl(request.headers) ?? ""}/api/mcp`;

  if (!config || !resource.startsWith("http")) {
    // Saying so beats serving metadata that points nowhere: a client that
    // successfully fetches a document naming a bogus authorization server fails
    // later and more confusingly than one that gets a clean 404 here.
    return Response.json(
      {
        error: "OAuth is not configured on this deployment.",
        detail:
          "Set WORKOS_AUTHKIT_DOMAIN and HUB_MCP_RESOURCE (or HUB_BASE_URL) to publish resource metadata.",
      },
      { status: 404, headers: cors() },
    );
  }

  return Response.json(
    {
      resource: config.resource,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "profile", "email"],
      resource_documentation: `${new URL(config.resource).origin}/mcp`,
    },
    {
      headers: cors(
        new Headers({
          // Discovery is stable and fetched on every cold client. An hour of
          // caching keeps a popular surface from polling it, and is short enough
          // that moving the authorization server propagates the same day.
          "Cache-Control": "public, max-age=3600",
        }),
      ),
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: cors() });
}
