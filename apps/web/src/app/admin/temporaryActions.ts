"use server";

import { revalidatePath } from "next/cache";
import { endTemporaryAccess, grantTemporaryAccess, listTemporaryAccess, recordAuthEvent, type TemporaryAccessRow } from "@ai-hub/db";
import { isVendorEmail } from "@ai-hub/authz";
import { isAllowedEmail } from "@/lib/allowlist";
import { sessionCan, standingAdmin } from "@/lib/sessionPrincipal";

/*
 * Break-glass access (docs/client-deployment.md): an admin of this hub gives
 * someone — the vendor, usually — access for a number of hours, with a
 * reason. It ends by itself; every door checks the end (@ai-hub/authz,
 * access.ts). The grant, its end and what was done with it are on the audit
 * trail and on the Admin page, where the client's admins read them.
 */

/** The longest a grant may run. Longer work is a series of grants, each decided. */
const MAX_TEMPORARY_HOURS = 72;
const ROLES = new Set(["admin", "analyst", "viewer"]);

export async function grantTemporaryAccessAction(input: {
  email: string;
  name?: string;
  role: string;
  hours: number;
  reason: string;
}): Promise<{ ok: true; until: string; note?: string } | { error: string }> {
  // Only a standing admin grants, and never the vendor: access that could
  // extend itself would not be temporary.
  const actor = await standingAdmin();
  if (!actor) return { error: "Only an admin with standing access can grant temporary access." };
  if (isVendorEmail(actor.email)) return { error: "The vendor cannot grant access on this hub." };
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "That does not look like an email address." };
  if (email === actor.email?.toLowerCase()) return { error: "You cannot grant access to yourself." };
  if (!ROLES.has(input.role)) return { error: "Choose admin, analyst or viewer." };
  const hours = Math.trunc(Number(input.hours));
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_TEMPORARY_HOURS) {
    return { error: `Between 1 and ${MAX_TEMPORARY_HOURS} hours.` };
  }
  const reason = input.reason.trim();
  if (reason.length < 5) return { error: "Say why — it goes on the record with the grant." };

  const until = new Date(Date.now() + hours * 3_600_000);
  const out = await grantTemporaryAccess({
    email,
    displayName: input.name?.trim(),
    roles: [input.role],
    until,
    reason: reason.slice(0, 500),
    grantedBy: actor.email ?? actor.id,
  });
  if ("error" in out) return out;
  await recordAuthEvent({
    event: "access.temporary.granted",
    source: "hub",
    actor: actor.email ?? actor.id,
    principalId: out.row.id,
    detail: { email, role: input.role, until: until.toISOString(), hours, reason: reason.slice(0, 500), vendor: isVendorEmail(email) },
  });
  revalidatePath("/admin");
  return {
    ok: true,
    until: until.toISOString(),
    // Signing in also needs the allowlist, which is the deployment's.
    ...(isAllowedEmail(email) ? {} : { note: `${email} is not in ALLOWED_EMAILS, so they cannot sign in to the web app until it is added. Their credentials and Claude Code sign-in work now.` }),
  };
}

export async function endTemporaryAccessAction(principalId: string): Promise<{ ok: true } | { error: string }> {
  // Any admin may end it early, the person themselves included.
  const actor = await sessionCan("admin:manage");
  if (!actor) return { error: "Only an admin can end temporary access." };
  if (!(await endTemporaryAccess(principalId))) return { error: "That access had already ended." };
  await recordAuthEvent({ event: "access.temporary.ended", source: "hub", actor: actor.email ?? actor.id, principalId, detail: { early: true } });
  revalidatePath("/admin");
  return { ok: true };
}

export async function listTemporaryAccessAction(): Promise<TemporaryAccessRow[] | { error: string }> {
  if (!(await sessionCan("admin:manage"))) return { error: "Admins only." };
  return listTemporaryAccess();
}
