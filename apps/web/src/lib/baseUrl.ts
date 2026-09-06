// The app's public origin, for building redirects.
//
// Behind Fly's proxy the Next.js standalone server sees the request as arriving
// at its own bind address (Dockerfile sets HOSTNAME=0.0.0.0, PORT=3000), so a
// redirect built from the request URL points at `https://0.0.0.0:3000` — a URL
// that resolves for nobody. AuthKit's callback route documents the same hazard
// ("the hostname can be different from the one in the request") and takes a
// `baseURL` option for it.
//
// Deliberately NOT derived from NEXT_PUBLIC_WORKOS_REDIRECT_URI: Next.js inlines
// every NEXT_PUBLIC_* read as a literal at BUILD time, server code included, so
// in the Docker image (built without that var) it would compile to `undefined`
// and silently restore the bug. Verified by grepping .next/server for the
// inlined value. `HUB_BASE_URL` has no such prefix and is read at runtime, so a
// Fly secret is enough; the header fallback means it is optional.
export function appBaseUrl(headers: Headers): string | undefined {
  const explicit = process.env.HUB_BASE_URL?.trim();
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      // fall through to the headers
    }
  }

  // Fly preserves the original Host and sets X-Forwarded-Proto.
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host || host.startsWith("0.0.0.0") || host.startsWith("127.0.0.1")) return undefined;
  const proto = headers.get("x-forwarded-proto") ?? "https";
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return undefined;
  }
}
