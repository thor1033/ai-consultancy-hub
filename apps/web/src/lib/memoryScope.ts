import { collectionSensitivities, getPrincipal, openCollectionNames, restrictedCollectionNames, type MemoryPlace, type MemoryReach } from "@ai-hub/db";
import { defaultVisibility, knowledgeAccessFor, type Principal } from "@ai-hub/authz";

/*
 * Memory scopes (docs/memory-scopes.md): who a run's memory is kept for, and
 * whose memory a run may have.
 *
 * READING. A run loads the agent's shared memory, its person's own, and the
 * memory of collections that person may read — the same rule that decides
 * which documents they may read (memoryReachFor).
 *
 * WRITING. Where a memory goes is derived from what the run touched, never
 * chosen by the model, and only ever narrows during a run:
 *
 *   started by another run (an ask, a hand-off)   personal — it carries what
 *                                                  the parent read
 *   continues a conversation                       personal — earlier turns may
 *                                                  have quoted what this one
 *                                                  cannot see
 *   retrieved from more than one non-open place,  personal
 *     or from unfiled documents
 *   retrieved from exactly one non-open collection collection:<that one>
 *   retrieved nothing that is not open            agent (shared)
 *   then: read anything outside the hub mid-run   personal (lib/approvals.ts)
 *
 * "Personal" needs a person. A run with nobody behind it that touched
 * anything restricted may not remember at all (place: null) — there is nobody
 * it could safely be kept for.
 */

export interface RunMemoryScope {
  /** Where this run's memory writes go; null: it may not remember. */
  place: MemoryPlace | null;
  /** Why, in a line — shown with a held memory write, and in the run's answer. */
  why: string;
  /** The run's person, for narrowing to personal later in the run. */
  principalId: string | null;
}

/** Whose memory a principal's runs may load. Nobody ⇒ shared memory only. */
export async function memoryReachFor(principal: Pick<Principal, "id" | "roles"> | null): Promise<MemoryReach> {
  if (!principal) return { principalId: null, collections: { kind: "allow", collections: [] } };
  const access = await knowledgeAccessFor({ ...principal, source: "credential" } as Principal);
  return {
    principalId: principal.id,
    collections: access.kind === "all" ? { kind: "all" } : { kind: access.kind, collections: [...access.collections] },
  };
}

/** The same, when only an id is known (a run started by id; an approval replaying one). */
export async function memoryReachForId(principalId: string | null | undefined): Promise<MemoryReach> {
  if (!principalId) return memoryReachFor(null);
  const row = await getPrincipal(principalId).catch(() => null);
  // An id with no row (an old env token) reads as a person with no grants:
  // their own memory and the shared one, no collection's.
  return memoryReachFor({ id: principalId, roles: row?.enabled ? row.roles : [] });
}

/**
 * Which of these collections are open to everyone signed in. Unfiled (null)
 * never is, and neither is a labelled one (docs/sensitivity.md): a
 * confidential collection's memory stays with its readers even if someone
 * made the collection itself open.
 */
async function openOf(collections: (string | null)[]): Promise<Set<string>> {
  const names = [...new Set(collections.filter((c): c is string => Boolean(c)))];
  if (!names.length) return new Set();
  const [open, restricted, labelled] = await Promise.all([openCollectionNames(), restrictedCollectionNames(), collectionSensitivities()]);
  const openSet = new Set(open);
  const restrictedSet = new Set(restricted);
  const unclassifiedOpen = defaultVisibility() === "open";
  return new Set(names.filter((n) => !labelled.has(n) && (openSet.has(n) || (unclassifiedOpen && !restrictedSet.has(n)))));
}

/** The scope a run starts with. */
export async function initialMemoryScope(input: {
  principalId: string | null;
  /** The collection of every passage retrieval gave the run (null: unfiled). */
  retrieved: (string | null)[];
  /** 0 for a run a person or the clock started; more for an ask or a hand-off. */
  depth: number;
  /** Whether the run continues a conversation (earlier turns in its prompt). */
  continues?: boolean;
}): Promise<RunMemoryScope> {
  const { principalId } = input;
  const personal = (why: string): RunMemoryScope =>
    principalId ? { place: { scope: "personal", ref: principalId }, why, principalId } : { place: null, why: `${why}, and nobody is behind this run`, principalId };

  if (input.depth > 0) return personal("it was started by another run, and carries what that run read");
  if (input.continues) return personal("it continues a conversation whose earlier turns may have quoted restricted material");
  const open = await openOf(input.retrieved);
  const closed = [...new Set(input.retrieved.filter((c) => c === null || !open.has(c)))];
  if (closed.length === 0) return { place: { scope: "agent", ref: "" }, why: "it read nothing restricted", principalId };
  if (closed.length === 1 && closed[0] !== null) {
    return { place: { scope: "collection", ref: closed[0] }, why: `it read from "${closed[0]}"`, principalId };
  }
  return personal(closed.includes(null) ? "it read unfiled documents" : `it read from ${closed.length} restricted collections`);
}

/** Narrow to personal: the run read something from outside the hub. Never widens. */
export function narrowToPersonal(scope: RunMemoryScope, why: string): void {
  if (scope.place?.scope === "personal") return;
  if (!scope.principalId) {
    scope.place = null;
    scope.why = `${why}, and nobody is behind this run`;
    return;
  }
  scope.place = { scope: "personal", ref: scope.principalId };
  scope.why = why;
}

/** How a place reads to a person. */
export function placeLabel(place: MemoryPlace | { scope: string; scopeRef?: string; ref?: string }, names?: Map<string, string>): string {
  const ref = "ref" in place && place.ref !== undefined ? place.ref : "scopeRef" in place ? (place.scopeRef ?? "") : "";
  if (place.scope === "agent") return "Shared";
  if (place.scope === "collection") return `Readers of ${ref}`;
  return `Only ${names?.get(ref) ?? ref}`;
}
