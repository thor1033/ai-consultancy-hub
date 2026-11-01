"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { recordAuthEvent, setPrincipalPreference } from "@ai-hub/db";
import { sessionPrincipal } from "@/lib/sessionPrincipal";
import { VIEW_COOKIE, isView, type View } from "@/lib/views";

/**
 * Choose how much of the hub you see (docs/views.md). Kept in a cookie for
 * this browser and on your row, when you have one, so it follows you to
 * another device. Not a permission: anyone signed in may choose any view;
 * the roles still decide what they may do in it. Null goes back to the
 * default (the deployment's, else your role's).
 */
export async function setViewAction(view: View | null): Promise<{ ok: true } | { error: string }> {
  if (view !== null && !isView(view)) return { error: "No such view." };
  const principal = await sessionPrincipal();
  if (!principal) return { error: "Sign in first." };
  const jar = await cookies();
  if (view === null) jar.delete(VIEW_COOKIE);
  else jar.set(VIEW_COOKIE, view, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  await setPrincipalPreference(principal.id, "view", view).catch(() => false);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Whether the Context Steward may read your conversations with agents
 * (docs/context-steward.md). Your decision, on your row: the steward's server
 * reads only the people who said yes, and stops the moment you say no. It
 * used to be a list in the deployment's settings that nobody on it could see
 * (docs/data-protection-review.md, F9). Each change is on the audit trail.
 */
export async function setStewardConsentAction(allow: boolean): Promise<{ ok: true } | { error: string }> {
  const principal = await sessionPrincipal();
  if (!principal) return { error: "Sign in first." };
  const saved = await setPrincipalPreference(principal.id, "stewardMayRead", allow === true ? true : null).catch(() => false);
  if (!saved) return { error: "Your account has no row to keep this on yet. Ask an admin to add you." };
  await recordAuthEvent({
    event: allow ? "consent.steward.given" : "consent.steward.withdrawn",
    source: "oauth",
    principalId: principal.id,
    actor: principal.email ?? principal.id,
    detail: {},
  });
  revalidatePath("/settings");
  return { ok: true };
}
