import { handleAuth } from "@workos-inc/authkit-nextjs";

// WorkOS redirects here after authentication. handleAuth exchanges the code,
// seals the session cookie, and redirects into the app. The hub's front door is
// the dashboard, so that is where a fresh sign-in lands.
export const GET = handleAuth({ returnPathname: "/" });
