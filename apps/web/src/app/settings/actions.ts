"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { setPrincipalPreference } from "@ai-hub/db";
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
