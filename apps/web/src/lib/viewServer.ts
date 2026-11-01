import { cache } from "react";
import { cookies } from "next/headers";
import { authorize, type Principal } from "@ai-hub/authz";
import { getPrincipal } from "@ai-hub/db";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { sessionPrincipal } from "@/lib/sessionPrincipal";
import { isAllowedEmail } from "@/lib/allowlist";
import { CAN_NOTHING, VIEW_COOKIE, resolveView, type Can, type View, type ViewSource } from "@/lib/views";

/*
 * The signed-in person's view and permissions, once per request
 * (docs/views.md). Read by the root layout for the navigation and by each
 * page for what it shows. Cached per request with React's cache, so the
 * layout and the page share one lookup.
 */

export interface ViewContext {
  view: View;
  from: ViewSource;
  can: Can;
  principal: Principal | null;
  /** Whether the person has a row the choice can be saved on, so it follows them. */
  saves: boolean;
  /**
   * Signed in and on the allowlist, but nobody has given them access yet (no
   * principal row). The layout says so, rather than showing an empty hub.
   */
  waitingForAccess: boolean;
}

export const viewContext = cache(async (): Promise<ViewContext> => {
  let cookie: string | undefined;
  try {
    cookie = (await cookies()).get(VIEW_COOKIE)?.value;
  } catch {
    // Outside a request (a build step): no cookie, defaults apply.
  }
  const principal = await sessionPrincipal().catch(() => null);
  let waitingForAccess = false;
  if (!principal) {
    try {
      const email = (await withAuth()).user?.email;
      waitingForAccess = isAllowedEmail(email);
    } catch {
      /* not signed in, or outside a request */
    }
  }
  let saved: unknown;
  let saves = false;
  if (principal) {
    try {
      const row = await getPrincipal(principal.id);
      saved = row?.preferences?.view;
      saves = Boolean(row);
    } catch {
      /* the database being down must not take the shell with it */
    }
  }
  const { view, from } = resolveView({ cookie, saved, deployment: process.env.HUB_DEFAULT_VIEW, roles: principal?.roles ?? [] });
  const can: Can = principal
    ? {
        run: await authorize(principal, "agent:run"),
        manage: await authorize(principal, "agent:manage"),
        admin: await authorize(principal, "admin:manage"),
        write: await authorize(principal, "document:write"),
      }
    : CAN_NOTHING;
  return { view, from, can, principal, saves, waitingForAccess };
});
