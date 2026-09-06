import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { authkitProxy, authkit } from "@workos-inc/authkit-nextjs";
import { isAllowedEmail } from "@/lib/allowlist";
import { appBaseUrl } from "@/lib/baseUrl";

// The door on the browser UI: WorkOS AuthKit, against the same client as
// PM-tool, so one sign-in identity covers both apps.
//
// API routes are covered by the matcher but listed as unauthenticated, which
// looks contradictory and isn't: AuthKit has to run on them for a session to be
// readable inside a route handler, while a machine calling /api/skills with a
// bearer token must get a JSON 401 from `guard()` rather than an HTML redirect
// to a sign-in page it cannot follow. Fly's health check on /api/health depends
// on the same thing.

const PUBLIC_PATHS = ["/callback", "/sign-in", "/sign-out", "/access-denied"];

const authProxy = authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [...PUBLIC_PATHS, "/api/:path*"],
  },
});

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  // A valid WorkOS session is not authorization. Check the allowlist before
  // handing off, and send a signed-in stranger to /access-denied rather than to
  // /sign-in — their identity provider would re-authenticate them immediately
  // and bounce them back here in a loop that never terminates.
  if (!isPublic(pathname) && !pathname.startsWith("/api/")) {
    const { session } = await authkit(req);
    if ("user" in session && session.user && !isAllowedEmail(session.user.email)) {
      // Same proxy hazard as the callback route: req.url is the container's
      // bind address behind Fly, so resolve against the public origin.
      return NextResponse.redirect(new URL("/access-denied", appBaseUrl(req.headers) ?? req.url));
    }
  }

  return authProxy(req, event);
}

export const config = {
  // `/api` is deliberately NOT excluded here — see the note above. Build assets
  // are, so the sign-in page renders with its styles.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?|ico)$).*)",
  ],
};
