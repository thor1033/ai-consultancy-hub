"use server";

import { revalidatePath } from "next/cache";
import {
  erasePerson,
  findSubject,
  getPrincipal,
  recordAuthEvent,
  sweepRetentionAndRecord,
  type Erasure,
  type RetentionSweep,
  type SubjectHits,
} from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";

// People's data, from the Admin page (docs/retention.md). Every action is an
// admin's and is on the audit trail: running retention by hand, erasing a
// person, and searching for a name — the search reveals, so it is recorded too.

const NOT_ADMIN = "Only an admin can do this.";

export async function runRetentionNowAction(): Promise<{ sweep: RetentionSweep } | { error: string }> {
  const admin = await sessionCan("admin:manage");
  if (!admin) return { error: NOT_ADMIN };
  const sweep = await sweepRetentionAndRecord(admin.email ?? admin.id);
  revalidatePath("/admin");
  return { sweep };
}

/**
 * Erase a person, confirmed by typing their email (or id, for a row without
 * one). Not yourself: an admin erasing their own row could leave a hub with
 * nobody able to administer it — another admin does it.
 */
export async function erasePersonAction(principalId: string, confirm: string): Promise<{ erased: Erasure } | { error: string }> {
  const admin = await sessionCan("admin:manage");
  if (!admin) return { error: NOT_ADMIN };
  if (principalId === admin.id) return { error: "You cannot erase yourself. Ask another admin." };
  const row = await getPrincipal(principalId);
  if (!row) return { error: "No such person." };
  const expected = (row.email ?? row.id).trim().toLowerCase();
  if (confirm.trim().toLowerCase() !== expected) return { error: `Type ${expected} to confirm.` };
  const erased = await erasePerson(principalId, admin.email ?? admin.id);
  revalidatePath("/admin");
  return { erased };
}

export async function findSubjectAction(term: string): Promise<{ hits: SubjectHits } | { error: string }> {
  const admin = await sessionCan("admin:manage");
  if (!admin) return { error: NOT_ADMIN };
  const t = (term ?? "").trim();
  if (t.length < 3) return { error: "Search for at least three characters: a name, an email, a phone number." };
  const hits = await findSubject(t);
  await recordAuthEvent({
    event: "data.searched",
    source: "oauth",
    principalId: admin.id,
    actor: admin.email ?? admin.id,
    detail: {
      term: t,
      found: { runs: hits.runs.length, memories: hits.memories.length, documents: hits.documents.length, proposals: hits.proposals.length, decks: hits.decks.length, people: hits.people.length },
    },
  });
  return { hits };
}
