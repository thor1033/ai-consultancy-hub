import { restrictedCollectionNames, grantedCollectionNames, openCollectionNames } from "@ai-hub/db";
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
 * How an unclassified collection — and an unfiled document — is treated.
 *
 * `restricted` by default: something nobody has classified is private until
 * an admin grants it, which is what a client handing the hub sensitive
 * material should be able to assume (docs/data-protection-review.md, F7).
 * Admins still read everything, so the people classifying are not locked out.
 *
 * It was `open` by default, as a migration affordance when visibility was
 * introduced over an existing corpus. A deployment that relies on that can set
 * HUB_DEFAULT_COLLECTION_VISIBILITY=open while it classifies; /admin names
 * every collection still relying on the default. The knowledge server
 * (packages/mcp/servers/knowledge) already read the default this way.
 */
export function defaultVisibility(): "open" | "restricted" {
  return process.env.HUB_DEFAULT_COLLECTION_VISIBILITY === "open"
    ? "open"
    : "restricted";
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

  const [restricted, granted, open] = await Promise.all([
    restrictedCollectionNames(),
    grantedCollectionNames(principal.id),
    openCollectionNames(),
  ]);

  const grantedSet = new Set(granted);

  if (defaultVisibility() === "restricted") {
    // What has been granted, and what an admin classified as open — "open"
    // means any signed-in person may read it, whatever the default for the
    // unclassified is. (Before restricted became the default, open rows were
    // ignored here, which made "classify it as open" do nothing.) Unfiled
    // documents are readable by nobody — they are in no drawer, so there is
    // nothing to grant access on, and "everything I forgot to classify" is the
    // wrong thing to hand out.
    return { kind: "allow", collections: [...new Set([...grantedSet, ...open])], unfiled: false };
  }

  // Open by default: everything except collections explicitly marked
  // restricted, minus the ones this principal has been granted back.
  return {
    kind: "deny",
    collections: restricted.filter((name) => !grantedSet.has(name)),
  };
}
