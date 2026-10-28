"use server";

import { revalidatePath } from "next/cache";
import type { Proposal } from "@ai-hub/db";
import { waitingOnCount } from "@ai-hub/db";
import { approve, reject, sendOn } from "@/lib/approvals";
import { sessionPrincipal } from "@/lib/sessionPrincipal";

// The verbs of the gate, as the signed-in person. Who may decide, and who a
// proposal may be sent to, is settled in lib/approvals.ts (an admin, the
// person whose reach the run had, or the person it was sent to; never an
// agent), so these only carry the identity across.

export type Outcome = { id: string; proposal: Proposal } | { id: string; error: string };

/**
 * Decide or send several at once. Each one goes through the same single-item
 * path, one after another: a batch is a convenience for the person, never a
 * different rule, and approving executes each held call in turn so a failure
 * is recorded on that proposal and the rest still run.
 */
async function each(ids: string[], fn: (id: string) => Promise<{ ok: true; proposal: Proposal } | { error: string }>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const id of ids.slice(0, 100)) {
    const res = await fn(id);
    out.push("error" in res ? { id, error: res.error } : { id, proposal: res.proposal });
  }
  revalidatePath("/approvals");
  return out;
}

export async function approveProposalsAction(ids: string[]): Promise<Outcome[] | { error: string }> {
  const principal = await sessionPrincipal();
  if (!principal) return { error: "You are not signed in." };
  return each(ids, (id) => approve(id, principal));
}

export async function rejectProposalsAction(ids: string[], note: string): Promise<Outcome[] | { error: string }> {
  const principal = await sessionPrincipal();
  if (!principal) return { error: "You are not signed in." };
  return each(ids, (id) => reject(id, principal, note));
}

/** Send to a colleague to decide, or take back (`to` null). */
export async function sendProposalsAction(ids: string[], to: string | null, note: string): Promise<Outcome[] | { error: string }> {
  const principal = await sessionPrincipal();
  if (!principal) return { error: "You are not signed in." };
  return each(ids, (id) => sendOn(id, principal, to, note));
}

/** The count on the rail: what is waiting on the person looking at it. */
export async function waitingOnMeAction(): Promise<number> {
  try {
    const principal = await sessionPrincipal();
    return principal ? await waitingOnCount(principal.id) : 0;
  } catch {
    return 0;
  }
}
