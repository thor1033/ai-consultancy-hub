# Data protection review: sensitive data, context and memory

*November 2026. A read of the whole hub for one question: what happens to a
client's sensitive data, and who ends up responsible for it. Findings first,
then a proposed model. This is an engineering review, not legal advice; the
GDPR points at the end are for a lawyer to confirm.*

## The position we want

Teqneo owns the product — the code, the patterns, the MCP servers we write.
**The client owns their data**, and we would rather not hold it at all: every
copy we keep makes us a processor with obligations (GDPR Art. 28, breach
duties, deletion requests), and every copy is something to lose.

Measured against that, the hub today is the opposite: it keeps **everything,
forever, in one database we operate**, and it sends full copies to up to three
outside services. Nothing in the code knows that some data is more sensitive
than other data.

## Where client data lives today

| Store | What it holds | Who can read it in the hub | Kept for |
|---|---|---|---|
| `agent_sessions.prompt`, `.output` | What each person asked and every answer | Prompts: everyone on Home and on each agent's page (see F3). Answers: the person ("Your answers") | Forever |
| `agent_sessions.transcript` | The full conversation of every run, **including every tool result**: emails read from a mailbox, Teams transcripts, CRM records, PM-tool data | No page shows it; the Context Steward reads it (condensed, tool results left out) for people listed in `HUB_STEWARD_READERS` | Forever, even after the agent or the person is deleted |
| `agent_memories` | What each agent decided to remember | **Everyone who uses that agent**, in every run; anyone in Standard view on the agent's Memory tab (F1, F3) | Forever |
| `documents`, `document_chunks` | Every document's full text, plus embeddings | Filtered per person by collection (restricted collections work) | Until deleted |
| `proposals.args`, `.result` | Every write an agent proposed (email drafts, task text) and what came back | The person, the assignee, admins | Forever |
| `decks.slides` | Presentation content | Fenced by the deck's collection | Until deleted |
| `principals`, `auth_events` | Names, emails, roles; failed sign-ins | Admins | Forever |
| `mcp_servers.token_sealed` | Connection tokens | Nobody (encrypted, AES-256-GCM) | Until removed |
| Neon backups (point-in-time restore) | All of the above | Whoever has the Neon account | The Neon project's restore window, after any deletion |

**What leaves the hub:**

| To | What | Under whose account |
|---|---|---|
| **Anthropic** (Messages API) | Every prompt, brief, retrieved passage, tool result and answer | The hub's `ANTHROPIC_API_KEY` — today Teqneo's |
| **Voyage AI** (embeddings) | The full text of every document, and every search query | The hub's `VOYAGE_API_KEY` — today Teqneo's |
| **Langfuse** (tracing, when its keys are set) | **A complete copy of every run**: all messages, every tool's input and output, the answer | The hub's Langfuse project |
| **WorkOS** | Who signs in | Teqneo's WorkOS account |
| **Neon** (Postgres) and **Fly.io** (`ams`) | Everything stored | Teqneo's accounts |
| **People's own Claude accounts** | Whatever the hub's MCP tools return to Claude Code or Claude.ai: search results, documents, agent answers; local agents run entirely there | Each person's own Claude plan (F8) |

## Findings

**High** — sensitive data can reach someone who should not see it, or we hold
it without needing to. **Medium** — a gap that becomes a problem with the
first sensitive client. **Gray zone** — defensible, but should be a decision,
not an accident.

### F1 · Memory is shared by everyone who uses an agent, and bypasses document access — High

Memory belongs to the **agent**, not to a person or a collection
(`agent_memories` has `agent_id` and nothing else). Any person's run can write
to it, and every later run, by anyone, reads it.

So restricted collections, the hub's main protection, leak through memory.
Maria may read the restricted `client-x-hr` collection; Jonas may not. Maria
asks the HR agent about a dismissal; it reads the documents and remembers
"Client X is letting three people go in December". Jonas asks the same agent
anything, and that memory is in his run. Nothing checks, because a memory
does not know where it came from.

The same applies to anything read through a mailbox or a connection: an email
only the Secretary's mailbox owner should see becomes a memory every user of
the Secretary loads. The Steward's `knowledge_remember_for` proposals do the
same on purpose, approved by a person, but without any notion of who may read
the result.

### F2 · Everything is kept forever, in full — High

Every run's transcript is stored with every tool result: email bodies,
meeting transcripts, CRM records. None of it is shown back to anyone; it is
kept because it was there.

- There is no retention period anywhere: transcripts, prompts, answers,
  proposals, memories.
- Deleting an agent leaves its runs (`on delete set null`).
- Deleting a person leaves their runs (`principal_id` has no foreign key) and
  everything they caused an agent to remember (memories record no author).

So there is no way to answer "delete everything about Maria" or "what do you
hold about Maria" (GDPR Articles 15 and 17) short of searching text by hand.
Backups keep deleted rows for Neon's restore window on top of that.

### F3 · The Standard view shows other people's prompts and every memory, to anyone — Medium

- **Home's "Latest runs"** shows the last eight prompts, from anyone.
- **Each agent's page** shows its recent prompts, from anyone.
- **The Memory tab** shows everything the agent remembers.

None of these check a permission. A **viewer** — the read-only role — can
switch to Standard in Settings and read them. That breaks the hub's own rule
that a view hides and never grants (docs/views.md). Before the views existed,
everyone saw them anyway.

A prompt is often the most sensitive line in a run ("draft the warning letter
to Peter about his absences").

### F4 · Teqneo has admin on every hub by default — High for the "we don't want access" position

- With `ALLOWED_EMAILS` unset, the allowlist **falls back to two founders'
  personal Gmail addresses** (`lib/allowlist.ts`).
- An allowlisted email with no `principals` row **is treated as admin**
  (`lib/sessionPrincipal.ts`).

A client hub deployed from this repo with that variable forgotten gives
Teqneo full admin access to the client's data, without anyone deciding it,
and with no trace in the audit log because the fallback creates no row.

### F5 · Full copies of everything go to Langfuse — High when enabled

Tracing sends the **whole message history, each tool's input and output, and
the answer** to Langfuse (`packages/agent/src/runAgent.ts`). It was added for
the ROI numbers, which need tokens, cost and latency. Those don't need any
content.

If Langfuse is configured on a client deployment, that is a second full copy
of all client data, in a third party's cloud, under our account.

### F6 · Our API keys make us the customer of record for client data — Medium

Anthropic and Voyage receive everything under **Teqneo's** keys. Commercially
that makes Teqneo the party Anthropic and Voyage contract with, and the
processor in between, whatever the hub's database arrangement is. It also
means a client cannot see or control those terms. Two settings need checking
on the accounts themselves:
- the retention terms on the Anthropic account (a zero-data-retention
  arrangement exists for this kind of use);
- whether the Voyage account is opted out of data use.

### F7 · Nothing knows what is sensitive — Medium

- There are no sensitivity labels on collections, documents, memories or
  connections.
- No detection: a CPR number, a health note or an account number is stored,
  embedded, remembered and traced like a lunch order.
- Special categories (GDPR Art. 9: health, union membership, etc.) get no
  different treatment.
- Collections default to **open** unless `HUB_DEFAULT_COLLECTION_VISIBILITY=restricted`
  is set. A file uploaded without a folder is readable by everyone.

### F8 · Hub data flows into personal Claude accounts — Gray zone

Through the hub's MCP server, search results, documents and agent answers
reach whatever Claude account the person connected: Claude Code or Claude.ai,
possibly a **personal** plan. Local agents run entirely there. What happens to
that data then depends on that account's plan and its settings, not on the
hub. There is no way to say "this collection may not leave the hub", and no
record of what was sent out.

### F9 · The Steward's consent is the deployment's, not the person's — Gray zone

The people whose chats the Context Steward may read are listed in an
environment variable (`HUB_STEWARD_READERS`). A person cannot see that they are
on it, or take themselves off it. The Steward also reads every agent's memory
(`knowledge_agent_memories`).

### F10 · Memory can be poisoned through what agents read — Gray zone

Writes to other systems wait for approval; **writes to memory do not**. An
email or a connected system's data can carry instructions, and an agent that
reads it can be talked into remembering something false or something
sensitive. Because memory is shared (F1), that then reaches everyone's runs.

### F11 · No record of who read what — Medium

`auth_events` records sign-in failures and credential changes. Reads are not
recorded: who opened which document, which collection a run retrieved from,
or what the hub's MCP server returned to an outside client. For a client with
confidential material, "who saw this" has no answer.

### What is already right

- **Access by role and by collection.** Retrieval narrows by person on every
  path, including the MCP server.
- **Writes wait for a person.** Writes to other systems are held for approval,
  and the approver sees exactly what will run.
- **Credentials.** API credentials are stored as hashes. Connection tokens are
  sealed, bound to their purpose, and never shown again.
- **Reach is fixed in code.** The Secretary's mailbox access is read-only by
  construction. Agents ask other agents as the same person, one level deep.
- **Narrow records.** Uploads keep only the extracted text. Run timelines
  record sizes and times, never content.
- **No content in the logs.** I found no logging of prompts, documents or tool
  results.

## Recommendation 1 · The operating model: client-owned, Teqneo-operated

The cleanest way not to own client data is not to hold it. The hub has no
tenancy (no `org_id` anywhere), so every client already needs their own
deployment. The proposal is to make that deployment **theirs**:

| | Client-owned (recommended) | Teqneo-hosted, isolated (fallback) |
|---|---|---|
| Database | Client's own Postgres (their Neon, Azure or AWS account, EU region) | A separate Neon project per client, EU region |
| App hosting | Client's cloud account; we deploy through CI with a deploy-only credential | Our Fly organisation, one app per client |
| Model | Client's own Anthropic key, or Claude through their AWS Bedrock or Google Vertex in an EU region | Client's own key, if at all possible |
| Embeddings | Client's own Voyage key, or a model run inside the deployment | Client's key |
| Tracing | Off, or metadata only (Recommendation 2.6) | Metadata only |
| Sign-in | Their identity provider (Entra ID) through WorkOS | Same |
| Encryption keys | Theirs (`HUB_SECRET_KEY` from their secret store) | Theirs, given to the deployment |
| Our access | **None standing**: time-limited break-glass access the client grants, logged where they can see it | Same, written into the DPA |
| What we are | A software vendor and an operator on request | A processor (Art. 28 DPA, list of subprocessors) |

What Teqneo owns either way:
- the product, released to every deployment from this repo;
- the patterns, seeds and our own MCP servers;
- the PM-tool, if a client uses it.

**Nothing in the hub needs to call home.** That stays a rule.

## Recommendation 2 · How context and memory should be stored

### 2.1 Memory gets a scope, and the scope is enforced

Every memory row gets the fields below. They are loaded and listed only for
people the scope allows: in runs, on the Memory tab, on the Context page and in
the Steward's reads.

| Field | Meaning |
|---|---|
| `scope` | `personal` (only its author), `collection:<name>` (only people who may read that collection), or `agent` (everyone who uses the agent) |
| `written_by` | The person whose run wrote it |
| `source_run_id` | The run it came from |
| `sensitivity` | See 2.3 |

The default scope is **derived, not chosen**. A run records what it touched:
- the collections it retrieved from;
- whether it read a mailbox or a connection.

A memory written by that run gets the **narrowest** scope it touched. It is
`personal` if the run read anything person-specific, like a mailbox, a
restricted collection or a connection. It is `collection:x` if it read only
from collection x. It is `agent` only if it read nothing restricted at all.

That is taint tracking, and it is simple, because the run already knows all of
this. Widening a memory's scope (personal → agent) is a write, so it goes
through the approval gate like any other. The Steward's
`knowledge_remember_for` proposals carry a scope, which the approver sees.

### 2.2 Transcripts: keep the outcome, drop the evidence

A run keeps three things:
- **What was asked and the answer**, for "Your answers". These expire after
  a retention period, 90 days by default and set per deployment.
- **Metadata**: which tools, which collections, the cost, the timeline. This
  is kept for the ROI numbers and contains no content.
- **The transcript**: kept only while the run is in flight, plus a short
  debug window (7 days by default). After that, tool results are replaced by
  their size and a hash. A client that needs full transcripts for audit can
  switch that on, knowingly.

Proposals keep their arguments until decided, then follow the same retention.
A nightly job does the expiry. The scheduler is already there to run it.

### 2.3 Sensitivity labels, set once on the source

| Label | Meaning |
|---|---|
| `internal` | The default |
| `confidential` | Restricted collection; never in memory scoped wider than the collection; never returned to outside clients (2.5) |
| `special` | GDPR Art. 9 material; **never** written to memory, transcripts kept for 0 days, never traced, never leaves the hub |

Labels go on collections and on connections. Documents, runs and memories
inherit them, so nobody labels individual items.

### 2.4 Detect and redact the obvious before storing

A small detector runs on memory writes and on stored prompts and answers:
- Danish CPR numbers, with the date check, not a bare regex;
- card numbers (Luhn) and IBANs;
- and, configurable, names from the principal list.

What it does with a match:
- **Memory:** the write is refused, and the agent is told why.
- **Stored prompts and answers:** the match is masked at rest. The live answer
  the person sees is not changed.

### 2.5 What may leave the hub

- **A per-collection switch: "may be returned to outside clients".** It is off
  for `confidential` and `special`. The hub's MCP server and local agents
  respect it.
- **Settings shows each person where their answers go**, with a note to use an
  organisation Claude account rather than a personal one.
- **Admins can require organisation accounts.** That check belongs with
  WorkOS and the identity provider, not here.

### 2.6 Tracing without content

Langfuse gets the trace shape only:
- turns and tools;
- tokens, cost and latency.

It gets no message text, tool inputs or tool outputs. This is a masking
function in `runAgent.ts`. Content tracing becomes an explicit
`HUB_TRACE_CONTENT=1` for a deployment that wants it.

### 2.7 A person's rights, built in

| Action | Who can run it | What it does |
|---|---|---|
| **Export** | The person, or an admin | Their runs, answers, proposals, and memories they wrote |
| **Erase** | An admin | The same set, plus their name masked in other people's stored prompts and answers where the detector finds it |
| **Find a subject** | An admin | Search memories, documents and stored answers for a name, to answer an access or erasure request about someone who is not a user |

Each of these writes an `auth_events` row, so it is on record.

### 2.8 Close the gaps found above

| Fix | For |
|---|---|
| Remove the founders' default allowlist: unset `ALLOWED_EMAILS` means nobody gets in. Remove the "no row means admin" fallback, except a one-time bootstrap for the first admin, which creates a row and is logged | F4 |
| Gate Home's "Latest runs", the agent page's recent prompts and the Memory tab on a permission. Other people's prompts show as "a run by Maria", the text visible to admins only, then not at all once 2.2 is in | F3 |
| Steward consent moves to the person's own row: a switch in Settings, "Let the Context Steward read my conversations" | F9 |
| Memory writes from a run that read a mailbox or a connection are held for approval (or marked unverified) until the scope work in 2.1 lands | F10 |
| A read log for `confidential` collections: who retrieved what, through which door | F11 |
| `HUB_DEFAULT_COLLECTION_VISIBILITY=restricted` as the shipped default | F7 |

## Suggested order

| Phase | What | Why first |
|---|---|---|
| **1 · Close the gaps** (days) | The fixes in 2.8 except the read log, and content-free tracing (2.6) | Small, and each closes a real leak |
| **2 · Memory scopes** (a week) | 2.1, with the run recording what it touched, and the Steward and Context page respecting scope | F1 is the biggest risk in the hub |
| **3 · Retention and rights** (a week) | 2.2, 2.7, the nightly expiry | Makes "how long do you keep it" and "delete Maria" answerable |
| **4 · Labels, detection, egress** | 2.3, 2.4, 2.5, the read log | Needed before the first client with health, HR or financial data |
| **5 · Client-owned deployment** | A deployment guide for a client's own account, keys and models configurable per deployment (mostly already env), a break-glass access procedure | The commercial position; partly paperwork |

Each phase gets a verify script in the existing style. The checks are of the
kind "Jonas's run does not load Maria's memory written from a restricted
collection".

## Progress

**Phase 1 is done.** It is on branch `claude/available-mcps-wurs52` and not yet
deployed.

| Finding | What changed | Proven by |
|---|---|---|
| F4 | No built-in allowlist; no row ⇒ no access; first admin of an empty hub bootstrapped once, logged; the access console needs the admin role (it needed only the allowlist, so any viewer could have made themselves admin — found while fixing F4) | `verify:data-protection` (web) |
| F3 | Other people's prompts and errors are removed on the server before Home, the agent page, the connection page and the run page render ("a run by …"); the person and admins see them. Memory is shown only to people who may run agents | `verify:data-protection` |
| F9 | Steward consent is a switch in each person's Settings, on the audit trail; `HUB_STEWARD_READERS` is no longer read | `verify:data-protection`, `verify:knowledge` (mcp) |
| F10 | Once a run reads anything outside (any tool but memory, or another agent's answer), its memory writes are held for approval with the hub's reason | `verify:data-protection`, `verify:approvals` |
| F7 | Unclassified collections and unfiled documents are restricted by default; `HUB_DEFAULT_COLLECTION_VISIBILITY=open` keeps the old behaviour | `verify:access` (rag) |
| F5 / 2.6 | Traces carry names, sizes, tokens and timings, never content, unless `HUB_TRACE_CONTENT=1` | `verify:tracing` (agent) |

Not in phase 1: the read log (F11), and everything in phases 2–5.

**Phase 2 is done** (docs/memory-scopes.md). It is on the same branch and not
deployed.

| | What changed | Proven by |
|---|---|---|
| F1 · scopes | Every memory is `agent`, `collection` or `personal`. A run loads only what its person may have. Admins' runs see every collection but nobody's personal memory | `verify:memory-scopes` (web), 29 checks |
| Writing | The place is derived from what the run touched: retrieved collections, a continued conversation, a parent run, an outside read. It only ever narrows. The model cannot set it: the argument is removed from its schema, a forged one is overwritten, and the memory server refuses a place that is not the run's person's or a collection they may read | the same |
| Pages | The Memory tab and Context page show each person what their runs would load. Admins see all, labelled with who each is for. Sharing a memory with everyone is admin-only and audited | the same |
| Steward | Reads shared memories only; what it proposes to remember is shared, and its description says so | `verify:knowledge` (mcp) |
| Also fixed | Collections an admin classified as **open** were unreadable to non-admins under the restricted default from phase 1 | `verify:access` (rag) |

Existing memories became `agent` (shared), which is what they were. Read
through each agent's Memory tab once for anything that should not be shared.

**Before deploying:**
- **Set `ALLOWED_EMAILS` on Fly first.** Without it nobody can sign in.
- **Admins need a row.** Anyone who used to get in as admin without a row now
  gets nothing until an admin adds them. On a hub with no admin row at all,
  the first person to sign in becomes admin.
- **Analysts lose unclassified collections.** They no longer see collections
  nobody has classified. Classify them on `/admin`, or set
  `HUB_DEFAULT_COLLECTION_VISIBILITY=open` while you do.
- **The Secretary's memory writes will wait for approval.** That happens
  whenever it has read the mailbox in the same run.

## Questions for a lawyer, and for us

1. In the client-owned model, with break-glass access only, are we a
   processor at all, or only when we access the system? What does the support
   agreement need to say?
2. If we host (the fallback), the DPA needs a list of subprocessors: Fly,
   Neon, WorkOS, Anthropic, Voyage, Langfuse. Which do we keep?
3. Agents reading a mailbox process data about people who never agreed to
   the hub (the senders). Is the client's legitimate interest enough, and
   should the Secretary's mailbox be one the client designates for it rather
   than a person's own?
4. What retention periods do we offer as defaults: 90 days for answers and 7
   for transcripts as proposed, or shorter?
5. Is special-category data (health, union membership) something we refuse
   outright, or support with the `special` label?
