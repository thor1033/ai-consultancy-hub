import { signOut } from "@workos-inc/authkit-nextjs";

// Clears the session cookie and bounces through WorkOS logout.
export async function GET() {
  await signOut();
}
