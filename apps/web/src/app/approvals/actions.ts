"use server";

import { revalidatePath } from "next/cache";
import type { Proposal } from "@ai-hub/db";
import { approve, reject } from "@/lib/approvals";
import { sessionPrincipal } from "@/lib/sessionPrincipal";

// The two verbs of the gate, as the signed-in person. Who may decide is
// settled in lib/approvals.ts (an admin, or the person whose reach the run
// had; never an agent), so these only carry the identity across.

export async function approveProposalAction(id: string): Promise<{ proposal: Proposal } | { error: string }> {
  const principal = await sessionPrincipal();
  if (!principal) return { error: "You are not signed in." };
  const res = await approve(id, principal);
  if ("error" in res) return res;
  revalidatePath("/approvals");
  return { proposal: res.proposal };
}

export async function rejectProposalAction(id: string, note: string): Promise<{ proposal: Proposal } | { error: string }> {
  const principal = await sessionPrincipal();
  if (!principal) return { error: "You are not signed in." };
  const res = await reject(id, principal, note);
  if ("error" in res) return res;
  revalidatePath("/approvals");
  return { proposal: res.proposal };
}
