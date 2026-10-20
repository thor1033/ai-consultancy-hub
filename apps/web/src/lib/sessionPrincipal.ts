import { withAuth } from "@workos-inc/authkit-nextjs";
import { findPrincipalByIdentity } from "@ai-hub/db";
import {
  authorize,
  knowledgeAccessFor,
  type Action,
  type KnowledgeAccess,
  type Principal,
} from "@ai-hub/authz";
import { isAllowedEmail } from "@/lib/allowlist";

/**
 * The signed-in browser user, as a Principal.
 *
 * The browser and the MCP endpoint reach the same data through different doors
 * — a WorkOS session cookie here, a bearer token there — and before increment
 * 02 that did not matter, because neither was filtered. Now it does: the
 * knowledge console and `/api/mcp` must narrow by the same rule, or the console
 * becomes the way around it.
 *
 * Resolution order:
 *   1. A `principals` row matching the session's WorkOS user id or email. This
 *      is the real answer, and the one that carries grants.
 *   2. An allowlisted email with no row yet ⇒ treated as an operator.
 *
 * Step 2 is the same bootstrap /admin runs on: the email allowlist is the root
 * of trust for the browser door, it defaults to the two owner accounts, and
 * adding anyone to it is a deliberate act. Without it, the owners would open
 * their own knowledge console on the day this deploys and find it empty —
 * before they have had any chance to create the rows that would fix it. A real
 * row always wins, so the fallback disappears the moment one exists.
 */
export async function sessionPrincipal(): Promise<Principal | null> {
  let email: string | undefined;
  let workosUserId: string | undefined;

  try {
    const { user } = await withAuth();
    email = user?.email?.trim().toLowerCase();
    workosUserId = user?.id;
  } catch {
    return null;
  }

  if (!email || !isAllowedEmail(email)) return null;

  try {
    const row = await findPrincipalByIdentity({ workosUserId, email });
    // A disabled row must refuse, not fall through: the fallback below grants
    // admin, so falling through would turn "disable this person" into a promotion.
    if (row && !row.enabled) return null;
    if (row) {
      return {
        id: row.id,
        roles: row.roles,
        ...(row.agentId ? { agentId: row.agentId } : {}),
        source: "oauth",
        email: row.email ?? email,
      };
    }
  } catch {
    // A database outage must not lock an operator out of the console they would
    // use to diagnose it. The fallback below is allowlist-gated either way.
  }

  return { id: email, roles: ["admin"], source: "oauth", email };
}

/**
 * The signed-in user if their roles permit `action`, otherwise null.
 *
 * Server actions are public HTTP endpoints and middleware only checks the
 * allowlist, so each one that changes or runs something checks the role here.
 */
export async function sessionCan(action: Action): Promise<Principal | null> {
  const principal = await sessionPrincipal();
  if (!principal) return null;
  return (await authorize(principal, action)) ? principal : null;
}

/**
 * What the signed-in user may read, for the browser's own read paths.
 *
 * Someone with no session gets nothing rather than everything — these run in
 * server components and server actions that middleware already guards, so this
 * should be unreachable, and "unreachable" is exactly the code path worth
 * failing closed.
 */
export async function sessionKnowledgeAccess(): Promise<KnowledgeAccess> {
  const principal = await sessionPrincipal();
  if (!principal) return { kind: "allow", collections: [], unfiled: false };
  return knowledgeAccessFor(principal);
}
