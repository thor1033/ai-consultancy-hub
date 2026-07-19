// Stubbed authentication for the MVP. Principals are bearer tokens configured
// in HUB_API_TOKENS (a JSON map). This is the WorkOS SSO seam — Phase 2 swaps
// this for real SSO/SCIM, but callers keep using authenticate()/Principal.
//
// HUB_API_TOKENS example:
//   {"tok-admin":{"id":"admin","roles":["admin"]},
//    "tok-analyst":{"id":"analyst","roles":["analyst"]}}
//
// Fails closed: no configured tokens ⇒ every request is unauthenticated.

export interface Principal {
  id: string;
  roles: string[];
}

let tokenMap: Record<string, Principal> | undefined;

function loadTokens(): Record<string, Principal> {
  if (tokenMap) return tokenMap;
  tokenMap = {};
  const raw = process.env.HUB_API_TOKENS;
  if (!raw) return tokenMap;
  try {
    const parsed = JSON.parse(raw) as Record<string, { id: string; roles?: string[] }>;
    for (const [token, p] of Object.entries(parsed)) {
      if (p && typeof p.id === "string") {
        tokenMap[token] = { id: p.id, roles: p.roles ?? [] };
      }
    }
  } catch {
    // Malformed config ⇒ no valid tokens (fail closed).
  }
  return tokenMap;
}

export function authenticate(headers: Headers): Principal | null {
  const match = (headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return loadTokens()[match[1].trim()] ?? null;
}
