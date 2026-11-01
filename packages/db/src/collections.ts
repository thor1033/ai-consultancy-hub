import { getSql } from "./client";

// Collections and who may read them (see schema.sql).
//
// Pure storage. The rule that turns a principal into a set of readable
// collections lives in @ai-hub/authz; the filter that applies it to a query
// lives in @ai-hub/rag. This module only knows rows.

export type Visibility = "open" | "restricted";

export interface CollectionRow {
  name: string;
  label: string;
  description: string;
  visibility: Visibility;
  /** Its label (docs/sensitivity.md); internal until someone says otherwise. */
  sensitivity: "internal" | "confidential" | "special";
  /** Documents currently filed here. */
  documentCount: number;
  /** Principals explicitly granted access. Meaningless while `open`. */
  grantCount: number;
  /**
   * Whether this collection has a row of its own. False means nobody has
   * decided about it and it is running on the deployment default — which is
   * exactly the set an operator needs to see, since under the open default it
   * is the readable-by-everyone set.
   */
  classified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GrantRow {
  collection: string;
  principalId: string;
  grantedBy: string;
  grantedAt: string;
}

/**
 * Every collection, classified or not.
 *
 * Built from a union of the `collections` table and the distinct labels still
 * sitting on `documents`, because a collection that has never been classified
 * has no row yet and is exactly the one an operator needs to see. Listing only
 * classified collections would hide the unclassified ones — which is precisely
 * the set that is readable by everybody.
 */
export async function listCollectionRows(): Promise<CollectionRow[]> {
  const sql = getSql();
  return sql<CollectionRow[]>`
    with names as (
      select name from collections
      union
      select distinct collection as name from documents
       where collection is not null and collection <> ''
    )
    select n.name,
           coalesce(c.label, '')         as label,
           coalesce(c.description, '')   as description,
           coalesce(c.visibility, 'open') as visibility,
           coalesce(c.sensitivity, 'internal') as sensitivity,
           (select count(*)::int from documents d where d.collection = n.name)
             as "documentCount",
           (select count(*)::int from collection_grants g where g.collection = n.name)
             as "grantCount",
           (c.name is not null)         as classified,
           coalesce(c.created_at, now()) as "createdAt",
           coalesce(c.updated_at, now()) as "updatedAt"
      from names n
      left join collections c on c.name = n.name
     order by n.name
  `;
}

/** The names of every collection marked restricted. Everything else is open. */
export async function restrictedCollectionNames(): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ name: string }[]>`
    select name from collections where visibility = 'restricted'
  `;
  return rows.map((r) => r.name);
}

/** The collections an admin has classified as open: readable by everyone signed in, under either default. */
export async function openCollectionNames(): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ name: string }[]>`
    select name from collections where visibility = 'open'
  `;
  return rows.map((r) => r.name);
}

/** The restricted collections this principal has been granted. */
export async function grantedCollectionNames(principalId: string): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ collection: string }[]>`
    select g.collection
      from collection_grants g
      join collections c on c.name = g.collection
     where g.principal_id = ${principalId}
  `;
  return rows.map((r) => r.collection);
}

export interface CollectionInput {
  name: string;
  label?: string;
  description?: string;
  visibility?: Visibility;
}

export async function upsertCollection(input: CollectionInput): Promise<CollectionRow> {
  const sql = getSql();
  await sql`
    insert into collections (name, label, description, visibility)
    values (
      ${input.name},
      ${input.label ?? ""},
      ${input.description ?? ""},
      ${input.visibility ?? "open"}
    )
    on conflict (name) do update set
      label       = excluded.label,
      description = excluded.description,
      visibility  = excluded.visibility,
      updated_at  = now()
  `;
  const rows = await listCollectionRows();
  return rows.find((r) => r.name === input.name)!;
}

/**
 * Grant a principal access to a collection.
 *
 * Creates the collection row if it does not exist yet, because granting access
 * to an unclassified collection is a coherent thing to want and failing on a
 * missing row would be an implementation detail leaking into the console. The
 * created row is `restricted` — granting access to something explicitly open
 * would otherwise silently do nothing.
 */
export async function grantCollection(
  collection: string,
  principalId: string,
  grantedBy: string,
): Promise<void> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`
      insert into collections (name, visibility)
      values (${collection}, 'restricted')
      on conflict (name) do nothing
    `;
    await tx`
      insert into collection_grants (collection, principal_id, granted_by)
      values (${collection}, ${principalId}, ${grantedBy})
      on conflict (collection, principal_id) do nothing
    `;
  });
}

export async function revokeCollectionGrant(
  collection: string,
  principalId: string,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    delete from collection_grants
     where collection = ${collection} and principal_id = ${principalId}
  `;
  return rows.count > 0;
}

export async function listGrants(): Promise<GrantRow[]> {
  const sql = getSql();
  return sql<GrantRow[]>`
    select collection,
           principal_id as "principalId",
           granted_by   as "grantedBy",
           granted_at   as "grantedAt"
      from collection_grants
     order by collection, principal_id
  `;
}
