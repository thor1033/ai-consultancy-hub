// Stubbed authentication for the MVP. Principals are bearer tokens configured
// in HUB_API_TOKENS (a JSON map). This is the WorkOS SSO seam — Phase 2 swaps
// this for real SSO/SCIM, but callers keep using authenticate()/Principal.
//
// HUB_API_TOKENS example:
//   {"tok-admin":{"id":"admin","roles":["admin"]},
//    "tok-analyst":{"id":"analyst","roles":["analyst"]},
//    "tok-lead":{"id":"lead","roles":["analyst"],"agentId":"<uuid>"}}
//
// Fails closed: no configured tokens ⇒ every request is unauthenticated.

export interface Principal {
  id: string;
  roles: string[];
  /**
   * The agent whose memory this token opens, if any.
   *
   * Bound to the token and never accepted as a tool argument, for the same
   * reason the stdio memory server takes HUB_AGENT_ID from its environment: a
   * model that can name another agent's id could otherwise read that agent's
   * memory. With several clients on one hub that is a cross-client leak.
   *
   * A token without this simply has no memory tools — there is no id to fall
   * back to, and guessing one would be the leak.
   */
  agentId?: string;
}

let tokenMap: Record<string, Principal> | undefined;

function loadTokens(): Record<string, Principal> {
  if (tokenMap) return tokenMap;
  tokenMap = {};
  const raw = process.env.HUB_API_TOKENS;
  if (!raw) return tokenMap;
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      { id: string; roles?: string[]; agentId?: unknown }
    >;
    for (const [token, p] of Object.entries(parsed)) {
      if (p && typeof p.id === "string") {
        // A non-string agentId is dropped rather than coerced: a malformed
        // binding must not silently become a binding to something else.
        const agentId = typeof p.agentId === "string" && p.agentId.trim() !== ""
          ? p.agentId.trim()
          : undefined;
        tokenMap[token] = { id: p.id, roles: p.roles ?? [], ...(agentId ? { agentId } : {}) };
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
