# Memory scopes

Before this change, what an agent remembered belonged to the **agent**. Any
person's run could write to it, and every later run, by anyone, loaded it.
So memory went around the hub's main protection, restricted collections.
Suppose Maria may read the HR collection and Jonas may not. Maria's run read
an HR document and remembered "Client X lets three people go in December",
and Jonas's next run of the same agent had it
(docs/data-protection-review.md, F1).

Now every memory has a **scope**. A run loads only the memories its person may
have.

| Scope | Kept for | `scope_ref` |
|---|---|---|
| `agent` | Everyone who uses the agent | `''` |
| `collection` | People who may read that knowledge collection, by the same rule as its documents | the collection's name |
| `personal` | The one person whose run wrote it | their principal id |

Admins' runs, like their document reads, see every collection. They do **not**
load other people's personal memories: those are someone's own context, not
the admin's.

## Where a run's memory goes

The hub decides, from what the run touched (`apps/web/src/lib/memoryScope.ts`).
The model never does. A run's scope starts at the first row that applies below,
and during the run it can only get narrower.

| The run… | Its memory is kept for |
|---|---|
| was started by another run (an ask, a hand-off) | its person: it carries what the parent read |
| continues a conversation (earlier turns in its prompt) | its person: those turns may have quoted what this one cannot see |
| retrieved unfiled documents, or from more than one collection that is not open | its person |
| retrieved from exactly one collection that is not open | readers of that collection |
| retrieved nothing that is not open | everyone (shared) |
| **then** reads anything from outside the hub, or asks another agent | its person, from that moment |

"Its person" needs a person. A run with nobody behind it that touched
anything restricted does not remember at all, and the model is told why.

A collection labelled confidential or special (docs/sensitivity.md) is never
"open", whatever its visibility says. A run that touched special material has
no memory at all, and neither does any run it started.

A memory write after an outside read is also **held for approval** (F10). The
place it would be kept in is part of the proposal, so approving it does not
widen it.

Memory written through the hub's own MCP tools (`hub_memory_*`) is always the
writer's own. That covers local agents in Claude Code and a token bound to an
agent. The hub cannot see what a model on someone's machine read before it
remembered, so it assumes the narrowest.

## How it is enforced

**The memory server**, `packages/mcp/servers/memory`, is spawned per run with
three values from the hub's environment, never from a tool argument:

| Variable | What it carries |
|---|---|
| `HUB_MEMORY_PRINCIPAL` | the run's person |
| `HUB_MEMORY_COLLECTIONS` | which collections they may read, in the shape of `KnowledgeAccess` |
| `HUB_MEMORY_RUN_ID` | the run |

From these:
- `memory_list` and `memory_search` return only what that person may have.
- `memory_set_active` and `memory_forget` act on the narrowest memory visible
  under the key.
- `memory_write` takes its place from `__place`.

**The gate** (`apps/web/src/lib/approvals.ts`) sets `__place` on every
`memory_write`:
- It removes any `__place` the model sent.
- It removes the argument from the schema the model is shown.
- It narrows the run to personal on its first outside read.

**The server checks the place anyway.** A personal place must be the run's
person. A collection place must be a collection they may read. A forged place
is refused, not obeyed.

**Keys are unique within a scope** (`agent_id, key, scope, scope_ref`). Ana and
Bo can each keep their own `next-steps`. A run that writes a key replaces its
own memory under that key, never someone else's.

Each memory also records `written_by` and `source_run_id`.

## Who sees what on the pages

- **The Memory tab and the Context page** show each person what their own runs
  would load. Admins see every memory, each labelled with who it is kept for:
  *Shared*, *Readers of hr*, *Only Maria*. A viewer sees none.
- **Forget and Set aside** are open to the memory's own person (for a personal
  memory), and to anyone who manages agents.
- **Share with everyone** widens a personal or collection memory to the whole
  agent. It is **admin-only** and recorded as `memory.shared` on the audit
  trail, because it can put what one person's run read in front of everyone.
- **The Context Steward** reads only shared memories
  (`knowledge_agent_memories`). Its `knowledge_remember_for` proposals are
  kept for everyone. That is what approving one means, and its description
  tells the steward not to propose anything personal or restricted.
- **Seeds** manage shared memories only. A person's own memory under a seeded
  key is theirs.

## What existing memories became

Every memory written before scopes is `agent` (shared), which is what it
always was. An admin should look through each agent's Memory tab once for
anything that should not be shared, and forget it. A forgotten memory is gone
from every run at once.

## Verifying

`npm run verify:memory-scopes -w web` runs 29 checks through the real run path,
memory server, gate, hub MCP tools, pages and actions:
- where each kind of run's memory goes;
- who loads it;
- that a forged place is overwritten, and refused at the server;
- that two people keep their own memory under one key;
- the labels on the Memory tab;
- that sharing is admin-only and audited;
- who may forget what.

`verify:knowledge` (mcp) checks that the steward reads shared memories only.
