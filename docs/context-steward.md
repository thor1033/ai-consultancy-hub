# The Context Steward

Status: **step 1 built** (capture and gaps). Steps 2 and 3 are proposals.

## The idea

Knowledge arrives in the hub sideways: in a chat with the Secretary, in a
meeting that was written up, in a correction someone typed to the Project
Manager. Without a steward it stays where it landed. The steward is the agent
whose job is to notice it, say where it belongs, and keep the knowledge base
honest.

## The decision

A standing agent, **Context Steward**, in the Office of the founders,
reporting to Ditlev, that **proposes and never files**.

It is a librarian, not a scraper. Its output is proposals in the approvals
queue (`docs/approvals.md`), of three kinds in step 1:

| Proposal | Tool | Example |
|---|---|---|
| **File** a document | `knowledge_file_document` | "The liability-cap answer the Legal agent gave on 21 Oct, as *Standard contract terms* in `legal`." |
| **Remember** something for an agent | `knowledge_remember_for` | "The Project Manager was told twice that standups moved to Thursday. Add it to its memory." |
| **Retire** a document | `knowledge_retire_document` | "*Roadmap Q3* is superseded by the notes of 21 Oct." |

"Write a missing document" is the first kind with a reason that says how many
times the question was asked. "Reconcile" is step 2.

A person approves, rejects, or ignores. Nothing changes until then. Why no
exceptions: a half-decision in a chat ("let's say 18 months for now") is one
approval away from becoming a fact every agent retrieves, and the gate is the
right place for that judgement.

## What it reads

| Source | Tool | Boundary |
|---|---|---|
| Chats | `knowledge_recent_chats`, `knowledge_chat_get` | **Only people named in `HUB_STEWARD_READERS`** (by email). Never the steward's own chats, never a workbench run with nobody behind it. The tools take no principal argument, so a model cannot widen the set by asking. |
| Meeting notes | `knowledge_recent_notes`, `knowledge_document_get` | The one collection it reads in full: `HUB_STEWARD_NOTES_COLLECTION`, default `meetings`. |
| Agents' memory | `knowledge_agent_memories` | Any agent's active memories, read-only. |
| The knowledge base | `knowledge_find`, `knowledge_collections` | Search goes through the hub's own `/api/rag/search` **as the steward's credential**, so it sees what that credential is granted and nothing else. |

A chat is condensed to who said what, numbered, with the tools used named and
their results left out: the correction at the end of a conversation is as
often the point as the question at the start, so long chats come in pages
rather than truncated.

## What counts as valuable

Five things, in the brief, with a "not valuable" list beside them:

1. A **decision**, with who made it and when.
2. A **definition** or a term the firm uses its own way.
3. A **correction**: "no, we actually do X."
4. A **durable fact** about a client, a product or a process.
5. A **recurring question** asked in two or more chats that no document
   answers. The proposal is the document that would, with the count in the
   reason.

Not valuable: a status that changes daily, an opinion nobody acted on,
anything told in confidence, a draft, a question with no answer yet, and
anything `knowledge_find` already returns.

## The hand-off from the Secretary

A meeting is the richest source the steward has, and it has a moment: the
Secretary has just read the transcript, grounded it against the board and
proposed its change set. An agent in a hub run cannot call another agent, so
**the hub does the handing**: when a run of `meeting-to-pm` or
`meeting-followup` finishes, the hub starts a steward run **as the same
person**, pointed at that session, and the person's answer ends with a line
saying so:

```
Secretary run (meeting-to-pm) ──▶ recorded ──▶ steward run, same principal, "Hand-off: … session <id>"
                                                   knowledge_chat_get(session) · knowledge_recent_notes
                                                   ──▶ proposals on /approvals, beside the Secretary's
```

- **As the same person**, so a scheduled follow-up (which runs as the
  schedule's owner) hands to a steward that runs as them too, and the
  steward's chat tools see the Secretary's session only if that person is in
  `HUB_STEWARD_READERS`. The hand-off widens nothing: the steward is started
  the way any agent is, through every check on the way.
- **After the record.** The steward reads the session with
  `knowledge_chat_get`, so it is started only once the session is stored with
  its transcript; what the hand-off says is appended to the stored answer
  after.
- **Said, never silent.** The answer ends with *Handed to the Context Steward
  (run …)*, or *Not handed to the Context Steward: it is switched off* (or
  whatever refused it). A hand-off that fails never fails the run.
- **Which skills:** `STEWARD_HANDOFF_SKILLS` in the seed, the Secretary's two
  meeting skills; `HUB_STEWARD_HANDOFF_SKILLS` on the deployment overrides it,
  and an empty value turns the hand-off off. The steward's own runs are never
  handed to itself.
- **The steward is told not to sweep** on a hand-off: read that one session,
  every page, and the note filed from it if there is one; propose from that
  meeting alone; never re-propose the Secretary's change set, which is the
  PM-tool's.

The note itself is filed too: a `teams_notes_save` that waited for approval
is filed in the knowledge base the moment it is approved (`approve()` runs
the notes sync after the save), as an unheld save is filed in its own run.
So an approved meeting is searchable, and the steward's proposals from it
carry the note as their source.

## Where it may file — the rule in code

`Sites.Selected` cannot fence a folder and a prompt cannot fence a collection,
so the write tool checks when it runs, which is at approval:

- **From a chat:** the person who had the chat must be able to read the target
  collection (admin, open, or granted), by the same rule retrieval uses. What
  someone said is never filed where they cannot see it.
- **From a note:** a restricted collection never feeds an open one.
- **From a memory:** no source side to compare; the reviewer is the check.
- **Into a collection that does not exist:** refused. A new collection is a
  person's decision.
- A collection that exists only as a label on documents, with no row, is
  treated as restricted.

The brief tells the steward the same rule and to check
`knowledge_collections` first, so a reviewer does not see a refusal. The check
is what holds.

## How it is built

```
agents.mcp_servers = [{"name":"knowledge"}]        no "writes":"allow", ever
  └── servers/knowledge/server.mjs                  stdio, bundled
        reads   annotated readOnlyHint: true         pass the gate
        writes  annotated readOnlyHint: false        held → approve() replays them here
        Postgres: sessions, documents, memory        HUB_STEWARD_READERS decides whose
        hub API: /api/documents, /api/rag/search     HUB_BASE_URL + HUB_STEWARD_TOKEN
```

- **Writes are MCP tools on a bundled server**, annotated as writes. The gate
  holds any tool not proven read-only and `approve()` replays a held call
  through the same server, so the steward's writes are held like the
  Secretary's with no new gate code.
- **Filing goes through the hub's own ingest** (`POST /api/documents`), so
  there is one chunking-and-embedding path. Filed documents carry
  `source_type = steward`, `source = steward:<kind>:<id>` and the source in
  their metadata.
- **The approvals page reads a filing as a filing**: "File document", the
  title as the headline, the collection and the source ("chat 1a2b3c4d, turn
  5") as the changes, and the document's text folded under the exact call,
  so the reviewer reads what will be retrievable before approving it.
- **The sweep is bounded by the steward's own memory**: `last-sweep` is where
  it read to, `proposed` is what it has proposed, so it never proposes twice
  and never re-reads the beginning of time.

## Setup

1. **A credential for the steward.** `/admin` → issue an API credential,
   name *Context Steward*, role **analyst** (it needs `document:write` to file
   and `rag:search` to search). Store the token as `HUB_STEWARD_TOKEN`. Grant
   that credential's principal the restricted collections the steward should
   be able to search; what it is not granted it cannot see.
2. **Who allows it:** `HUB_STEWARD_READERS=ditlev@teqneo.co,thor@teqneo.co`.
   A person is added by their email, by the deployment, one at a time.
3. `HUB_BASE_URL` (already set) and, if the notes collection is not
   `meetings`, `HUB_STEWARD_NOTES_COLLECTION`.

   ```bash
   flyctl secrets set -a teqneo-ai-hub HUB_STEWARD_TOKEN='…' HUB_STEWARD_READERS='ditlev@teqneo.co,thor@teqneo.co'
   ```

4. **The seed applies itself on the next release** (`src/seeds/all.ts` lists
   it; `release.mjs` applies it with the rules in `src/seeds/apply.ts`). By
   hand: `npm run seed:context-steward -w @ai-hub/db`. Either way a sweep
   ledger the steward has since written is kept.
5. **The nightly sweep** is a schedule on the agent's page, owned by a founder
   (a scheduled run executes as its owner, which is why the seed does not make
   one): *"Sweep what is new since your last sweep and propose what should be
   kept."* Until then, ask it: *"Look at this week's chats."*
6. **Watch `/approvals`.** The first week's proposals are the test of the brief:
   fewer than ten, each one a person is glad to see, is the target.

## The tools

| Tool | | Held? |
|---|---|---|
| `knowledge_recent_chats` | Allowed people's chats since a moment: who asked which agent what, the answer in short | no |
| `knowledge_chat_get` | One chat condensed, paged | no |
| `knowledge_recent_notes` | Meeting notes filed since a moment | no |
| `knowledge_document_get` | One note in full | no |
| `knowledge_agent_memories` | An agent's active memories | no |
| `knowledge_find` | Passages the base has on a query, with document and collection | no |
| `knowledge_collections` | Every collection, its visibility, its count | no |
| `knowledge_file_document` | File a new document, with its source | **yes** |
| `knowledge_remember_for` | Add to another agent's memory | **yes** |
| `knowledge_retire_document` | Delete a hand-filed, steward-filed or notes document | **yes** |

## Verify

```bash
npm run verify:knowledge -w @ai-hub/mcp          # needs DATABASE_URL + a migrated DB
npm run verify:handoff -w web                    # needs DATABASE_URL + the steward seeded
node --experimental-transform-types packages/db/seed-context-steward.mjs --check
```

A throwaway HTTP server stands in for the hub's API; every row (two people,
agents, five chats, collections, notes, memories) is created and deleted by
the script; the real server runs through `builtinServerConfig` →
`connectMcpServers`. 51 checks, including: only allowed people's chats come
back, never the steward's own or a workbench run; every write is annotated as
a write and no read is; the visibility rule refuses a chat into a collection
its person may not read, a chat of someone who did not allow it, a workbench
run, and a restricted note into an open collection — and the refused calls
post nothing. A mutation that disables the chat rule fails five checks.

`verify:handoff` drives the real run path (`runSkillForPrincipal`) with a
throwaway skill and a streaming stand-in for the Messages API: 28 checks,
among them that a run of a hand-off skill starts exactly one steward run, as
the same principal, pointed at that session by id, only once the session is
recorded with its transcript; that the answer says so, stored and returned;
that any other skill starts none; and that a switched-off steward is said in
the answer rather than skipped. What it cannot prove is what the steward
proposes from a real meeting.

**What it cannot prove:** the steward's judgement. Whether a month of real
chats yields the right ten proposals and not fifty is the model's doing, read
in the approvals queue. That is why the seed makes no schedule: the first
sweeps are asked for, and read.

## Known limits

- **Search is as the steward's credential, not the asker's.** Someone asking
  the steward "what do we have on X" in chat gets what the steward may read.
  Grant its credential only collections every reader may read, and keep the
  steward in the founders' office until step 3.
- **`knowledge_document_get` reads the notes collection directly**, not
  through the hub, so it does not check who is asking. The same remedy: the
  notes collection is the founders', and so is the steward.
- **One proposal per fact, decided one by one.** The queue has no batches
  (`docs/approvals.md`).

## Phased plan

### Step 1 — Capture and gaps ✅

Built as above.

### Step 2 — Curation

Reconcile and retire: contradictions between documents, documents nothing
cites, memory that should be shared knowledge. Needs `knowledge_document_get`
on any collection the credential may read, through the hub.

### Step 3 — More readers

Adding people beyond the founders, each by their own say-so, with search as
the asker rather than as the steward.

## What this deliberately does not do

- **File on its own**, in any phase, for any kind of proposal.
- **Read every chat.** Breadth is the easy part and the wrong part.
- **Replace the Secretary.** The Secretary writes the record of a meeting; the
  steward reads it — handed over when the Secretary is done, not in its run.
- **Watch chats as they happen.** A sweep over finished chats sees the whole
  conversation, including the correction at the end.
