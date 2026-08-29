import Link from "next/link";

// A terminal page, and public on purpose. Someone with a valid WorkOS session
// whose email is not on the allowlist cannot be sent to /sign-in — their
// identity provider would re-authenticate them instantly and bounce them
// straight back here, forever. This page is where that loop stops.
export default function AccessDenied() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="text-sm text-muted-foreground">
        You signed in successfully, but this account is not on the hub&apos;s
        allowlist. If it should be, add it to <code>ALLOWED_EMAILS</code>.
      </p>
      <Link href="/sign-out" className="text-sm underline underline-offset-4">
        Sign out and try another account
      </Link>
    </main>
  );
}
