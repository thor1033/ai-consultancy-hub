# The Context Steward — direction and plan

Status: **proposal**. Nothing is built. Decisions taken so far are in bold.

## The idea

Knowledge arrives in the hub sideways: in a chat with the Secretary, in a
meeting that was written up, in a correction someone typed to the Project
Manager. Today it stays where it landed. The steward is the agent whose job is
to notice it, say where it belongs, and keep the knowledge base honest.

## The decision

A standing agent, **Context Steward**, in the **Office of the founders**,
reporting to **Ditlev**, that **proposes and never files**.

It is a librarian, not a scraper. Its output is proposals in the approvals
queue that already exists, one of five kinds:

| Proposal | Example |
|---|---|
| **File** a document in a collection | "The liability-cap answer the Legal agent gave on 21 Oct, as *Standard contract terms* in `legal`." |
| **Remember** something for an agent | "The Project Manager was told twice that Friday standups moved to Thursday. Add it to its memory." |
| **Write** a document that is missing | "Four chats this month asked what our onboarding steps are. No document answers it. Draft attached." |
| **Reconcile** two sources that disagree | "*Pricing 2026* says 12 months of fees; the 14 Oct check-in decided 18. Which is right?" |
| **Retire** a document | "*Roadmap Q3* is superseded by the notes of 21 Oct and nothing cites it." |

A person approves, rejects, or ignores. Approving files the document, writes
the memory, or retires the row. Nothing changes in the knowledge base until
then.

Why no exceptions to "never files": a half-decision in a chat ("let's say 18
months for now") is one approval away from becoming a fact every agent
retrieves. The gate the hub already has (`docs/approvals.md`) is the right
place for that judgement, and the steward is the agent where it matters most.

## What it reads

- **Chats.** `agent_sessions` carries the full transcript and the principal
  who ran it. **Only the founders' chats, to start.** A person is added one at
  a time, by saying so. A chat with the Legal agent about a client is not
  steward material because it was useful; it is steward material because its
  owner said the steward may read it.
- **Meeting notes.** The `meetings` collection the Secretary files into. Notes
  are already summaries, so the steward reads them for decisions and facts
  that belong in a longer-lived document.
- **Agent memory.** What agents have learned that is really company knowledge
  ("the client's fiscal year ends in March") and should be a document other
  agents can retrieve.
- **The knowledge base itself**, to find what is missing (recurring questions
  with no answer) and what contradicts.

## What counts as valuable

A short list, in the brief, because "valuable" left to the model means
everything:

1. A **decision**, with who made it and when.
2. A **definition** or a term the firm uses its own way.
3. A **correction**: "no, we actually do X."
4. A **fact about a client, a product or a process** that will be true next
   month.
5. A **recurring question**: the same thing asked in three chats is a missing
   document, whatever the answers said.

Not valuable: a status that changes daily (that is what the PM-tool is for),
an opinion nobody acted on, anything the asker was told in confidence, and
anything already in a document the steward can find.

**The record stays where it is.** When the real home is somewhere else (a
meeting's notes, a PM-tool task, the design record), the steward proposes
recording it there and indexing it, so the knowledge base stays an index and
not a second source of truth.

## Where it may file

- A proposal that would move text **from a restricted collection into an open
  one is refused** before it is made. Retrieval filters by who is asking; a
  steward that copies across that line defeats the filter.
- It files into collections that exist. A new collection is a decision for a
  person, proposed as such.
- Every filed document names its source: the chat (id and date), the meeting,
  or the memory it came from.

## How it is built

```
agents.mcp_servers = ["knowledge"]
  └── servers/knowledge/server.mjs             stdio, bundled
        reads   knowledge_recent_chats          founders' sessions since the last sweep
                knowledge_recent_notes          new notes in `meetings`
                knowledge_agent_memories        another agent's memory, read-only
                knowledge_find                  what the base says about X, and gaps
        writes  knowledge_file_document         held → approve() → ingest
                knowledge_remember_for          held → approve() → agent_memories
                knowledge_retire_document       held → approve() → delete
```

- **The write tools are MCP tools on a bundled server**, annotated as writes.
  That is the whole reason: the gate holds any tool not proven read-only, and
  `approve()` replays a held call through the same server. No new gate code;
  the steward's writes are held like the Secretary's.
- **Filing goes through the hub's own ingest** (`POST /api/documents`, with a
  credential the deployment holds for the steward), so there is one chunking
  and embedding path, not a second one in a child process.
- **The sweep is a schedule** on the agent (`docs/schedules.md`): **nightly**,
  over what is new since the last sweep, recorded in its memory. **On request**
  too: "steward, look at this chat", "what do we have on X".
- **The queue shows the text.** A file proposal's argument is the document;
  the approvals page renders it as prose, with its source, so the reviewer reads
  what will be retrievable, not a JSON blob.

## Hard constraints to respect

- **Never files.** No `"writes": "allow"` on the steward's server entry, and
  the seed does not set one.
- **Reads only what it was allowed.** The chat tool takes no principal
  argument; the allowed set is the deployment's configuration.
- **Never crosses a collection's visibility.** Checked in the write tool, not
  in the prompt.
- **A proposal with no source is refused.** The reviewer must be able to open
  the chat or note it came from.
- **The sweep is bounded.** One night's worth; a steward that re-reads the
  whole history on every run proposes the same thing every night.

## Phased plan

### Step 1 — Capture and gaps

The `knowledge` server with the four read tools and the three write tools;
the steward's seed (brief, function, owner, schedule off); the approvals page
rendering a file proposal as prose; a verify script that fakes a month of
founders' chats and meeting notes and checks that it proposes the decisions
and the recurring question, proposes nothing from a restricted collection, and
proposes nothing twice.

Needs first: the org-chart branch merged (the seed sets function and owner),
and a steward credential on the deployment.

Done when: a nightly sweep over a week of real chats leaves fewer than ten
proposals, each one a person is glad to see.

### Step 2 — Curation

Reconcile and retire: contradictions between documents, documents nothing
cites, memory that should be shared knowledge.

### Step 3 — More readers

Adding people beyond the founders, each by their own say-so, with the
visibility rule holding per person.

## What this deliberately does not do

- **File on its own**, in any phase, for any kind of proposal.
- **Read every chat.** Breadth is the easy part and the wrong part.
- **Replace the Secretary.** The Secretary writes the record of a meeting; the
  steward reads it. Two jobs, two agents.
- **Watch chats as they happen.** A sweep over finished chats sees the whole
  conversation, including the correction at the end.
