/**
 * Email allowlist. A valid WorkOS session is not enough to reach the hub — the
 * signed-in email must appear here. The hub has no tenancy of its own (no
 * org_id anywhere in its schema), so anyone who gets in sees everything in it;
 * until that changes, the guest list is the whole authorization model.
 *
 * Configure via `ALLOWED_EMAILS` (comma-separated). Unset falls back to the two
 * owner accounts, so a deployment that forgets the variable is locked down
 * rather than open. Mirrors PM-tool's lib/auth/allowlist.ts deliberately —
 * both apps sign in against the same WorkOS client, and a person allowed into
 * one and not the other would be a confusing accident rather than a decision.
 */
const DEFAULT_ALLOWED = [
  "thoralexanderbjesimonsen@gmail.com",
  "ditlevbj@gmail.com",
];

function allowedEmails(): string[] {
  const raw = process.env.ALLOWED_EMAILS;
  const list = raw
    ? raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED;
  return list.length ? list : DEFAULT_ALLOWED;
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.toLowerCase());
}
