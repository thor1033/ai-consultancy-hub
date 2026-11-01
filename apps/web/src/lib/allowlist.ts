/**
 * Email allowlist. A valid WorkOS session is not enough to reach the hub — the
 * signed-in email must appear here, and then have a principal row (or be
 * provisioned one; lib/sessionPrincipal.ts) before it can do anything.
 *
 * Configure via `ALLOWED_EMAILS` (comma-separated). Unset or empty means
 * NOBODY: there is no built-in list. There used to be — the two founders'
 * accounts — which meant a client's hub deployed with the variable forgotten
 * let Teqneo in as admin without anyone deciding it (docs/data-protection-review.md,
 * F4). The hub belongs to whoever runs it; who may enter is theirs to write
 * down. Mirrors PM-tool's lib/auth/allowlist.ts in shape.
 */
function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.toLowerCase());
}

/** Whether the deployment has written down anyone at all — for the page that explains an empty list. */
export function allowlistConfigured(): boolean {
  return allowedEmails().length > 0;
}
