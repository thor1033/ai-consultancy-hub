import { redirect } from "next/navigation";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

// A route handler rather than a page, so AuthKit can set the PKCE cookie on the
// response before the browser leaves for WorkOS.
export async function GET() {
  redirect(await getSignInUrl());
}
