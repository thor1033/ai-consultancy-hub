import { oauthConfig } from "@ai-hub/authz";

/**
 * Authorization Server Metadata, proxied from AuthKit.
 *
 * Strictly a backwards-compatibility shim. A client that implements RFC 9728
 * reads our protected-resource document, finds AuthKit's issuer and fetches
 * this from AuthKit directly. Older MCP clients skip that step and assume the
 * resource server *is* the authorization server, so they ask us — and get
 * AuthKit's real document rather than a 404 they cannot recover from.
 *
 * It is a proxy, never a copy: mirroring the fields by hand would make this the
 * place that goes stale when WorkOS adds an endpoint or rotates a URL.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = oauthConfig();
  if (!config) {
    return Response.json(
      { error: "OAuth is not configured on this deployment." },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  try {
    const upstream = await fetch(`${config.issuer}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      // Discovery on the hot path of a client's first connection: a hung
      // AuthKit must not hold our request open indefinitely.
      signal: AbortSignal.timeout(5000),
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Authorization server metadata unavailable (${upstream.status}).` },
        { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const metadata = await upstream.json();
    return Response.json(metadata, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return Response.json(
      { error: "Could not reach the authorization server." },
      { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    },
  });
}
