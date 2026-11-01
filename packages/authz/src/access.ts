/*
 * Whether a person's row lets them in right now (docs/client-deployment.md).
 *
 * Every door asks this one function — browser sign-in, an OAuth bearer token,
 * a credential, a schedule running as its owner — so temporary access ends
 * everywhere at the same moment, with nothing left that still works.
 *
 *   disabled                                   no
 *   temporary access that has ended            no
 *   temporary access still running             yes
 *   standing access, not the vendor            yes
 *   standing access, the vendor                no — on a client's own hub
 *                                              the vendor gets in only
 *                                              through a grant with an end
 *
 * The vendor is whoever HUB_VENDOR_ACCESS names: email addresses, or domains
 * (teqneo.co, @teqneo.co). Unset on the vendor's own hub, where its people
 * are the client. Set on every client deployment.
 */

function vendorEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.HUB_VENDOR_ACCESS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** Whether this deployment names a vendor at all. */
export function vendorConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return vendorEntries(env).length > 0;
}

/** Whether an email belongs to the vendor, by address or domain. */
export function isVendorEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const e = email?.trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  const domain = e.split("@")[1];
  return vendorEntries(env).some((v) => (v.includes("@") ? v === e : v === domain));
}

export interface AccessFacts {
  enabled: boolean;
  email?: string | null;
  accessExpiresAt?: string | Date | null;
}

/** Why this row does not let its person in now; null when it does. */
export function accessProblem(row: AccessFacts | null | undefined, email?: string | null, now = new Date()): string | null {
  if (!row) return "no_principal";
  if (!row.enabled) return "principal_disabled";
  if (row.accessExpiresAt) {
    return new Date(row.accessExpiresAt).getTime() > now.getTime() ? null : "temporary_access_ended";
  }
  if (isVendorEmail(row.email) || isVendorEmail(email)) return "vendor_without_grant";
  return null;
}

/** Whether temporary access is running for this row. */
export function isTemporary(row: AccessFacts | null | undefined): boolean {
  return Boolean(row?.accessExpiresAt);
}
