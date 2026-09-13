import { createRemoteJWKSet, jwtVerify, decodeJwt, type JWTPayload } from "jose";

/**
 * The hub as an OAuth 2.1 protected resource, with WorkOS AuthKit as the
 * authorization server.
 *
 * The division of labour is the whole reason this is short: AuthKit runs the
 * OAuth machinery the MCP clients need — discovery, dynamic client
 * registration, PKCE, consent, token issuance — and the hub does exactly two
 * things. It publishes its resource metadata (see the /.well-known routes) and
 * it verifies the access tokens that come back. Nothing here mints a token or
 * holds a client secret.
 *
 * Configuration:
 *   WORKOS_AUTHKIT_DOMAIN  the AuthKit origin, which is also the token issuer
 *                          (e.g. https://your-app.authkit.app)
 *   HUB_MCP_RESOURCE       this server's resource indicator — the RFC 8707
 *                          value clients ask for and the `aud` we require.
 *                          Defaults to <HUB_BASE_URL>/api/mcp.
 *
 * Unset domain ⇒ OAuth is simply off and `verifyAccessToken` returns null, so a
 * deployment that has not configured it keeps working on credentials rather
 * than failing every request. Fails closed either way: an unverifiable token is
 * never trusted.
 */

export interface OAuthConfig {
  issuer: string;
  jwksUrl: string;
  resource: string;
}

export function oauthConfig(): OAuthConfig | null {
  const domain = process.env.WORKOS_AUTHKIT_DOMAIN?.trim().replace(/\/+$/, "");
  if (!domain) return null;

  const resource = mcpResource();
  if (!resource) return null;

  try {
    const issuer = new URL(domain).origin;
    return { issuer, jwksUrl: `${issuer}/oauth2/jwks`, resource };
  } catch {
    return null;
  }
}

/**
 * This server's resource indicator.
 *
 * It must be the exact string a client asks for and the exact `aud` AuthKit
 * stamps, or verification fails — which is why it is explicit configuration
 * with a derived default rather than something reconstructed per request from
 * whatever Host header arrived. Behind Fly that header is the container's own
 * bind address (the hazard lib/baseUrl.ts documents), and a resource indicator
 * of `https://0.0.0.0:3000/api/mcp` would match nothing.
 */
export function mcpResource(): string | null {
  const explicit = process.env.HUB_MCP_RESOURCE?.trim();
  if (explicit) {
    try {
      return new URL(explicit).href.replace(/\/+$/, "");
    } catch {
      return null;
    }
  }
  const base = process.env.HUB_BASE_URL?.trim();
  if (!base) return null;
  try {
    return `${new URL(base).origin}/api/mcp`;
  } catch {
    return null;
  }
}

// createRemoteJWKSet caches the key set and refreshes it on an unknown `kid`,
// so this must be built once per process rather than per request — otherwise
// every call is a fresh fetch of the JWKS and a rotation storm on AuthKit.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrl: string | undefined;

function keySet(url: string) {
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrl = url;
  }
  return jwks;
}

/** True for anything shaped like a JWS compact serialization. */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0) && token.startsWith("ey");
}

export interface OAuthIdentity {
  /** The WorkOS user id (`sub`). */
  workosUserId: string;
  email: string | null;
  /** Scopes the token carries, if any. Narrowing only — never a grant. */
  scopes: string[];
  organizationId: string | null;
  expiresAt: number | null;
  claims: JWTPayload;
}

/**
 * Verify an AuthKit access token and pull the identity out of it.
 *
 * Returns null for anything that does not verify. The caller must treat that as
 * "no identity" and not as "try the next thing with elevated trust" — the token
 * proves who the holder is, and nothing about what they may do here. Roles are
 * looked up against the `principals` table by the caller, deliberately: an
 * access token that could carry its own authorization would make every scope
 * WorkOS ever adds a potential privilege escalation into the hub.
 */
export async function verifyAccessToken(token: string): Promise<OAuthIdentity | null> {
  const config = oauthConfig();
  if (!config) return null;

  try {
    const { payload } = await jwtVerify(token, keySet(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.resource,
    });

    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!sub) return null;

    const rawEmail = payload.email;
    const scope = payload.scope;

    return {
      workosUserId: sub,
      email: typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null,
      scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [],
      organizationId: typeof payload.org_id === "string" ? payload.org_id : null,
      expiresAt: typeof payload.exp === "number" ? payload.exp : null,
      claims: payload,
    };
  } catch {
    return null;
  }
}

/**
 * The reason a token failed, for the audit trail only.
 *
 * Decoding without verifying is safe here because nothing is trusted from the
 * result — it exists so "expired" and "wrong audience" are distinguishable in
 * /admin, which is the difference between a client that needs to refresh and a
 * resource indicator that is misconfigured. The distinction is never returned
 * to the caller of the endpoint.
 */
export function describeTokenFailure(token: string): string {
  const config = oauthConfig();
  if (!config) return "oauth_not_configured";
  try {
    const claims = decodeJwt(token);
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return "expired";
    if (claims.iss !== config.issuer) return `issuer_mismatch:${String(claims.iss ?? "none")}`;
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
    if (!audiences.includes(config.resource)) {
      return `audience_mismatch:${audiences.join(",") || "none"}`;
    }
    return "signature_or_claims_invalid";
  } catch {
    return "malformed";
  }
}
