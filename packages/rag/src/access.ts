import { getSql } from "@ai-hub/db";
import type { KnowledgeAccess } from "@ai-hub/authz";

/**
 * Turns a KnowledgeAccess into a SQL predicate over `documents d`.
 *
 * One function, used by every read path — retrieval, listing, document reads
 * and the collection list. Four hand-written variants of the same rule is how
 * three of them end up correct and the fourth quietly returns the HR file.
 *
 * Every caller passes the filter explicitly and none of them may omit it: the
 * parameter is required in each signature, so a new read path that forgets to
 * narrow does not compile. That is the only enforcement mechanism here that
 * does not depend on somebody remembering.
 */
export function accessPredicate(access: KnowledgeAccess) {
  const sql = getSql();

  if (access.kind === "all") return sql`true`;

  if (access.kind === "allow") {
    // Nothing granted and no unfiled access ⇒ nothing is readable. Spelled out
    // rather than left to `collection in ()`, which is a SQL syntax error.
    if (!access.collections.length) {
      return access.unfiled ? sql`d.collection is null` : sql`false`;
    }
    return access.unfiled
      ? sql`(d.collection is null or d.collection in ${sql(access.collections)})`
      : sql`(d.collection is not null and d.collection in ${sql(access.collections)})`;
  }

  // deny: everything except these. Unfiled documents are readable — a document
  // in no collection cannot be in a denied one.
  if (!access.collections.length) return sql`true`;
  return sql`(d.collection is null or d.collection not in ${sql(access.collections)})`;
}

/** Whether a named collection is readable under this filter. */
export function collectionReadable(access: KnowledgeAccess, name: string): boolean {
  if (access.kind === "all") return true;
  if (access.kind === "allow") return access.collections.includes(name);
  return !access.collections.includes(name);
}
