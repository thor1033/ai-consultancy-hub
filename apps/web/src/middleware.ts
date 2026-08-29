import { NextResponse, type NextRequest } from "next/server";

// A door on the browser UI.
//
// The API routes have always been guarded — `guard()` verifies a bearer token
// against HUB_API_TOKENS. The *pages* had nothing: /knowledge, /agents, /chat
// and /roi rendered to anyone who knew the hostname, which is fine on a private
// network and not fine on a public domain holding a client's documents. Real
// sessions arrive with WorkOS SSO in Phase 2 (see lib/authz.ts); until then one
// shared password over HTTPS is the honest stopgap, and Basic auth is the form
// of it that needs no login page, no cookie, and no session store to get wrong.
//
// API routes are deliberately NOT gated here. They authenticate machines with
// bearer tokens, and demanding a browser credential as well would break every
// programmatic caller — including Fly's health check on /api/health.

const REALM = 'Basic realm="AI Hub", charset="UTF-8"';

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": REALM },
  });
}

// Constant-time-ish comparison. Middleware runs on the edge runtime where
// node:crypto's timingSafeEqual is unavailable, so compare every byte rather
// than returning early on the first mismatch.
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const expected = process.env.HUB_WEB_PASSWORD;

  if (!expected) {
    // Unset in production means someone deployed without configuring the door,
    // so refuse to serve rather than serve openly — the same fail-closed rule
    // HUB_API_TOKENS follows. Local dev stays usable without ceremony; that is
    // a deliberate asymmetry, and the reason the production branch is a hard
    // stop instead of a warning.
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "HUB_WEB_PASSWORD is not set — refusing to serve the UI unauthenticated.",
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized();
  }

  // Everything after the first colon is the password, so a password containing
  // a colon still works. The username is ignored — there is only one door.
  const password = decoded.slice(decoded.indexOf(":") + 1);
  if (!secretsMatch(password, expected)) return unauthorized();

  return NextResponse.next();
}

export const config = {
  // Pages only. `api` keeps its bearer-token guard, and the Next build assets
  // are excluded so a 401 page still renders with its styles.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
