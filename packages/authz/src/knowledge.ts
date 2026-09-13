import { restrictedCollectionNames, grantedCollectionNames } from "@ai-hub/db";
import type { Principal } from "./principal";

/**
 * Which of the company's knowledge a principal may read.
 *
 * In the org-chart terms we explain the hub with, this is the answer to "which
 * shared drives may this employee open". Retrieval, listing and document reads
 * all narrow through it, so there is one rule rather than four.
 *
 * It is a plain value, not a callback, so the decision is made once per request
 * — in the layer that knows who is asking — and then travels as data into the
 * SQL. A filter that re-derived itself inside the query layer would be a filter
 * the query layer could forget to apply.
 *
 * Three shapes, because the two default policies really are different queries
 * and collapsing them into one would mean carrying a flag that changes what the
 * other fields mean:
 *
 *   all    no filtering
 *   allow  only these collections (restricted-by-default)
 *   deny   everything except these collections (open-by-default)
 */
export type KnowledgeAccess =
  | { kind: "all" }
  | { kind: "allow"; collections: string[]; unfiled: boolean }
  | { kind: "deny"; collections: string[] };

/**
 * The unrestricted filter, named so every unrestricted call site says so.
 *
 * Reach for this only where there is genuinely no principal to narrow by: an
 * ingest job, a migration, a verification harness. If a *request* is using it,
 * that is a bug — the point of increment 02 is that requests carry an asker.
 */
export const ALL_KNOWLEDGE: KnowledgeAccess = { kind: "all" };

/**
 * How an unclassified collection is treated.
 *
 * `open` (the default) keeps the existing corpus readable the moment this
 * deploys — the hub is running with 27 documents in three collections that
 * predate the concept of visibility, and failing closed on deploy would empty
 * every answer the terminal gives. That is an outage, not a security posture.
 *
 * Set HUB_DEFAULT_COLLECTION_VISIBILITY=restricted once everything is
 * classified. Same shape as the legacy-token migration: the safe end state is
 * one variable away, and /admin names every collection still relying on the
 * default so it cannot be quietly forgotten.
 */
export function defaultVisibility(): "open" | "restricted" {
  return process.env.HUB_DEFAULT_COLLECTION_VISIBILITY === "restricted"
    ? "restricted"
    : "open";
}

/**
 * Compute what this principal may read.
 *
 * Admins are not filtered. That is a deliberate call rather than an oversight:
 * an admin can grant themselves any collection from /admin in two clicks, so
 * filtering them would be theatre that costs a query per request and makes the
 * audit trail read as though the hub enforced something it did not. The people
 * this protects are the ones who *cannot* edit grants.
 */
export async function knowledgeAccessFor(
  principal: Principal,
): Promise<KnowledgeAccess> {
  if (principal.roles.includes("admin")) return ALL_KNOWLEDGE;

  const [restricted, granted] = await Promise.all([
    restrictedCollectionNames(),
    grantedCollectionNames(principal.id),
  ]);

  const grantedSet = new Set(granted);

  if (defaultVisibility() === "restricted") {
    // Only what has been granted. Unfiled documents are readable by nobody —
    // they are in no drawer, so there is nothing to grant access on, and
    // "everything I forgot to classify" is the wrong thing to hand out.
    return { kind: "allow", collections: [...grantedSet], unfiled: false };
  }

  // Open by default: everything except collections explicitly marked
  // restricted, minus the ones this principal has been granted back.
  return {
    kind: "deny",
    collections: restricted.filter((name) => !grantedSet.has(name)),
  };
}
