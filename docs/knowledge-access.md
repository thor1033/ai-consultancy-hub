# Knowledge access

Retrieval respects who is asking. A collection is a **shared drive**; a grant is
**who may open it**. Search, document reads and the collection list all narrow
through the same rule.

This is increment 02, and it is the other half of increment 01. Once people
arrive as themselves, retrieval that ignores who is asking is how an analyst's
Copilot answer ends up quoting the HR file. Identity without a filter is worse
than neither, because it looks like access control.

## The model

In the org-chart terms we explain the hub with — Agent = employee, Tool = what
they operate, Knowledge = the company's files — this answers *which drawers may
this employee open*.

| Visibility | Who can read it |
|---|---|
| `open` | any authenticated principal |
| `restricted` | only principals with a row in `collection_grants` |
| unclassified | whatever `HUB_DEFAULT_COLLECTION_VISIBILITY` says |

Grants are **per principal, not per role**. A role says what kind of work
someone does; a grant says which of the company's drawers they may open. Two
analysts on different client engagements should not see each other's material,
and a role cannot express that.

**Admins are not filtered.** Deliberately: an admin can grant themselves any
collection from `/admin` in two clicks, so filtering them would be theatre that
costs a query per request and makes the audit trail read as though the hub
enforced something it did not. This protects against the people who *cannot*
edit grants.

## Curation is not permission

An agent's `knowledge_collection` and the `collection` argument on
`hub_search_knowledge` are **curation** — which drawer to work out of. They are
ANDed with the access filter, never substituted for it.

So naming a restricted collection you have not been granted returns nothing,
rather than unlocking it. And an agent scoped to a restricted collection does
not become a way to read that collection: it retrieves **as the person asking**,
not with a reach of its own. Otherwise the agent is a deputy you can point at
anything.

## Enforcement

Four read paths, one predicate (`packages/rag/src/access.ts`):

| Path | Why it has to be filtered |
|---|---|
| `retrieveChunks` | the obvious one |
| `getDocument` | search returns ids; this turns an id into the whole document |
| `listDocuments` | titles and previews are content |
| `listCollections` | a drawer you cannot open should not appear in the picker |

Filtering search but not `getDocument` would be a fake fix. The verification
harness tests exactly that bypass: it takes the id a granted principal can see,
hands it to one who cannot, and asserts a refusal.

**The filter is a required argument** on every one of those functions. It could
have defaulted to "everything" and saved some typing, and then the one new read
path that forgot to pass it would be the leak — silently, at runtime, in
production. Required means a forgotten filter does not compile. When increment
02 landed, that caught 15 call sites; two of them (the knowledge console and the
agent chat) were genuine holes nobody would have thought to look for.

A document you may not read is reported as **missing**, not forbidden. A 403
confirms the document exists, which is itself a disclosure.

## The default, and the migration

`HUB_DEFAULT_COLLECTION_VISIBILITY` decides what an unclassified collection
means. It defaults to `open`.

That default is a migration affordance, **not a policy**. The hub is running
with a corpus that predates the concept of visibility; failing closed on deploy
would empty every answer the terminal gives, which is an outage rather than a
security posture. `/admin` names every unclassified collection and every unfiled
document so the set cannot be quietly forgotten.

To finish:

1. Open `/admin` → Knowledge. Classify each collection as open or restricted.
2. Grant the restricted ones to the people who need them.
3. File the unfiled documents into a collection (under `restricted` they are
   readable by nobody — a document in no drawer has nothing to grant on).
4. Set `HUB_DEFAULT_COLLECTION_VISIBILITY=restricted`.
5. Confirm each person still sees what they should, from their own client.

Step 4 is one environment variable, reversible. Do it as its own deploy.

## The browser is the same door

`/knowledge` and the agent chat narrow by the signed-in user, resolved through
`apps/web/src/lib/sessionPrincipal.ts`. Before this, the console was
server-trusted and unfiltered — which would have made it the way around the
filter the moment retrieval started respecting the asker.

An allowlisted email with no `principals` row yet is treated as an operator, the
same bootstrap `/admin` runs on. A real row always wins, so the fallback
disappears the moment one exists.

## Verifying

```
npm run verify:access -w @ai-hub/rag
```

No API key — the dev hash embedder is enough, because what is under test is the
filter, not the ranking. 23 checks across all four read paths, the by-id bypass,
grant and revoke, curation-is-not-permission, and both default policies, under
throwaway collections it cleans up after itself.

## Still open

- **Chunk-level access.** A document is the unit; a mixed-sensitivity document
  has to be split to be partly shared.
- **The nested-credential seam.** When a hub agent calls out to PM-tool, it uses
  the hub's own token, so the caller inherits the hub's reach there, not their
  own. Knowledge is filtered; other MCP servers are not. That is the thing to
  fix before a second client shares a deployment.
