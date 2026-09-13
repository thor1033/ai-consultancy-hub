import { NextResponse } from "next/server";
import { authenticate, authorize, mcpResource, type Action, type Principal } from "@ai-hub/authz";

/**
 * The OAuth 2.1 challenge a protected resource owes an unauthenticated client.
 *
 * The `resource_metadata` parameter is the part that matters: it is how an MCP
 * client discovers, from a bare 401, which authorization server to go get a
 * token from (RFC 9728). Without it a client that has never seen this hub has
 * nowhere to start, and both ChatGPT's connector flow and Copilot's federated
 * connectors begin with exactly this response.
 *
 * Falls back to a plain `Bearer realm` when no resource indicator is configured,
 * which is the honest answer: there is no authorization server to point at yet.
 */
export function wwwAuthenticate(baseUrl?: string): string {
  const resource = mcpResource();
  const origin = baseUrl ?? (resource ? new URL(resource).origin : null);
  if (!resource || !origin) return 'Bearer realm="ai-hub"';
  return [
    'Bearer error="unauthorized"',
    'error_description="Authorization needed"',
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  ].join(", ");
}

export function unauthorizedResponse(message = "Unauthorized: missing or invalid bearer token.") {
  return NextResponse.json(
    { error: message },
    { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate() } },
  );
}

// Verify a raw bearer token for a server action and authorize it for an action.
// Still used by the admin console's token field; the console's own gate is the
// WorkOS session (see admin/actions.ts), and this is what a machine caller
// presenting a credential goes through.
export async function authorizeToken(
  token: string,
  action: Action,
  resource?: string,
): Promise<Principal | null> {
  const principal = await authenticate(new Headers({ authorization: `Bearer ${token}` }));
  if (!principal) return null;
  return (await authorize(principal, action, resource)) ? principal : null;
}

type Gate =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse };

// Route guard: authenticate the bearer token, then authorize the action (and
// optional resource). 401 if unauthenticated, 403 if denied.
export async function guard(
  req: Request,
  action: Action,
  resource?: string,
): Promise<Gate> {
  const principal = await authenticate(req.headers);
  if (!principal) {
    return { ok: false, response: unauthorizedResponse() };
  }
  if (!(await authorize(principal, action, resource))) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Forbidden: '${principal.id}' may not ${action}${
            resource ? ` on ${resource}` : ""
          }.`,
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true, principal };
}
