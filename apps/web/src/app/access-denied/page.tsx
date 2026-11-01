import Link from "next/link";

// A terminal page, and public on purpose. Someone with a valid WorkOS session
// whose email is not on the allowlist cannot be sent to /sign-in — their
// identity provider would re-authenticate them instantly and bounce them
// straight back here, forever. This page is where that loop stops.
//
// Written for the person who lands here, not the one who runs the hub: most
// visitors are a colleague who has not been invited yet. The setting's name is
// kept, small, for whoever they forward it to.
export default function AccessDenied() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">You are not invited yet</h1>
      <p className="text-sm text-[var(--text-soft)]">
        You signed in, but this hub is invite-only and your email is not on its list. Ask the person who runs the hub to add you, then sign in
        again.
      </p>
      <p className="text-xs text-[var(--muted)]">
        For whoever runs the hub: add the email to <code>ALLOWED_EMAILS</code>, or give it a role on the Admin page.
      </p>
      <Link href="/sign-out" className="text-sm underline underline-offset-4">
        Sign out and try another account
      </Link>
    </main>
  );
}
