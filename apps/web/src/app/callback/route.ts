import { handleAuth } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";
import { appBaseUrl } from "@/lib/baseUrl";

// WorkOS redirects here after authentication. handleAuth exchanges the code,
// seals the session cookie, and redirects into the app. The hub's front door is
// the dashboard, so that is where a fresh sign-in lands.
//
// `baseURL` is required behind Fly's proxy: without it handleAuth builds the
// post-login redirect from the request URL, which is the container's bind
// address, and sign-in ends at https://0.0.0.0:3000/. It is resolved per
// request rather than once at module load, because the origin comes from the
// request's own forwarded headers.
export function GET(req: NextRequest) {
  return handleAuth({ returnPathname: "/", baseURL: appBaseUrl(req.headers) })(req);
}
