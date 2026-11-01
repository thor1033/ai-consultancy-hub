import { withAuth } from "@workos-inc/authkit-nextjs";
import { findPrincipalByIdentity, hasEnabledAdmin, recordAuthEvent, upsertPrincipal } from "@ai-hub/db";
import {
  AUTO_PROVISION_ROLES,
  accessProblem,
  autoProvisionable,
  isVendorEmail,
  authorize,
  knowledgeAccessFor,
  type Action,
  type KnowledgeAccess,
  type Principal,
} from "@ai-hub/authz";
import { isAllowedEmail } from "@/lib/allowlist";

/**
 * The signed-in browser user, as a Principal, or null.
 *
 * The browser and the MCP endpoint reach the same data through different doors
 * — a WorkOS session cookie here, a bearer token there — and both now resolve
 * a person the same way: by a `principals` row. Roles come from that row and
 * nowhere else.
 *
 *   1. A row matching the session's WorkOS user id or email ⇒ that row's roles.
 *      A disabled row ⇒ null.
 *   2. No row, and the email's domain is in HUB_AUTO_PROVISION_DOMAINS ⇒ an
 *      analyst row is made, on the audit trail (as the bearer door does).
 *   3. No row, and the hub has no enabled admin at all ⇒ the first admin is
 *      made: a row, and a `principal.bootstrap` event. This is how a new
 *      deployment gets its first operator, and it happens once.
 *   4. Otherwise ⇒ null: signed in and allowlisted, but nobody has given them
 *      access yet. The layout says so.
 *
 * What is gone is the old step 2, "an allowlisted email with no row is an
 * admin": it made every allowlisted person an operator, created no row and
 * left no trace (docs/data-protection-review.md, F4). A database that cannot
 * be read now fails closed — the admin console cannot work without it anyway.
 *
 * The allowlist still gates every step: it is the deployment's list of who may
 * enter at all.
 */
export async function sessionPrincipal(): Promise<Principal | null> {
  let email: string | undefined;
  let workosUserId: string | undefined;
  let name = "";

  try {
    const { user } = await withAuth();
    email = user?.email?.trim().toLowerCase();
    workosUserId = user?.id;
    name = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  } catch {
    return null;
  }

  if (!email || !isAllowedEmail(email)) return null;

  try {
    let row = await findPrincipalByIdentity({ workosUserId, email });
    if (!row) {
      const provisioned = autoProvisionable(email);
      // Never the vendor (HUB_VENDOR_ACCESS): on a client's hub that the
      // vendor set up, the vendor signing in first must not become its admin.
      const bootstrap = !provisioned && !isVendorEmail(email) && !(await hasEnabledAdmin());
      if (provisioned || bootstrap) {
        const roles = provisioned ? AUTO_PROVISION_ROLES : ["admin"];
        row = await upsertPrincipal({ id: email, email, displayName: name, roles });
        await recordAuthEvent({
          event: provisioned ? "principal.provisioned" : "principal.bootstrap",
          source: "oauth",
          principalId: row.id,
          detail: { email, workosUserId, roles, rule: provisioned ? "HUB_AUTO_PROVISION_DOMAINS" : "first admin of an empty hub" },
        });
      }
    }
    // A disabled row must refuse: disabling a person takes them out at once.
    // So must temporary access that has ended, and the vendor without a
    // grant (@ai-hub/authz access.ts) — the same rule every door applies.
    if (!row || accessProblem(row, email)) return null;
    return {
      id: row.id,
      roles: row.roles,
      ...(row.agentId ? { agentId: row.agentId } : {}),
      source: "oauth",
      email: row.email ?? email,
      ...(row.accessExpiresAt ? { temporaryUntil: new Date(row.accessExpiresAt).toISOString() } : {}),
    };
  } catch {
    // Fail closed: no row could be read, so no roles can be known.
    return null;
  }
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
 * An admin with standing access: the signed-in user, if they are an admin and
 * their access is not temporary (docs/client-deployment.md). Temporary access
 * is for working in the hub — fixing an agent, a connection, a failed run —
 * not for changing who has access, relabelling what may leave, or taking
 * other people's data out. Those stay with the client's own admins, so a
 * break-glass grant cannot be used to make itself permanent.
 */
export async function standingAdmin(): Promise<Principal | null> {
  const principal = await sessionCan("admin:manage");
  return principal && !principal.temporaryUntil ? principal : null;
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
