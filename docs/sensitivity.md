# Sensitivity: labels, detection, what leaves the hub, and the read log

Phase 4 of docs/data-protection-review.md (2.3, 2.4, 2.5 and F11). Until now
the hub treated a CPR number, a health note and a lunch order the same way.
Now:
- an admin can say how sensitive a source is, once;
- the obvious identifiers are caught wherever they would be stored;
- material marked confidential stays inside the hub;
- every read of it is on record.

## Labels

A label goes on a **collection** (Admin → People and access) or a
**connection** (its page under MCP servers). Documents and runs inherit it, so
nobody labels single items. Only admins set labels, and each change is on the
audit trail (`collection.sensitivity`, `connection.sensitivity`).

| | Internal (default) | Confidential | Special category |
|---|---|---|---|
| Memory | by scope (docs/memory-scopes.md) | never wider than its collection | none at all |
| Transcript | 7 days | 7 days | not kept |
| Tracing | shape only | shape only | nothing, not even the shape |
| Context Steward reads the conversation | if the person allows it | no | no |
| Returned to Claude Code / Claude.ai | yes | no: a link to read it in the hub | no |
| Reads logged | no | yes | yes |

"Special category" is GDPR art. 9 material: health, union membership and the
like.

**A labelled collection must be restricted.** Labelling an open one is
refused, and so is opening a labelled one. Confidential means someone decided
who may read it.

**A run's label** is the highest of:
- what it retrieved;
- the connections it had;
- what started it: a hand-off, an ask, or the earlier turns of a chat.

It is stored on the run (`agent_sessions.sensitivity`). It only ever goes up:
- An agent that asks another agent takes on that agent's label when the
  answer comes back.
- A follow-up in a chat takes on the label of the answers it continues. The
  page sends each answer's run id with it. Run ids that belong to someone
  else count for nothing.

**What a special run is told.** Its system prompt says it has no memory and
why, so it does not offer to remember anything.

A label applies from the next run, search or connection. Nothing already
remembered or sent out changes when a label is set later. Read the
collection's Memory tab and decide what to keep.

## Detection

`packages/mcp/servers/detect.mjs` finds three kinds of identifier:

| Kind | Checked by | Masked as |
|---|---|---|
| Danish CPR numbers | the date has to exist, using the CPR century rule (so 29 February is right) | `[CPR number removed]` |
| Payment card numbers | Luhn, a network's first digit, and a card's grouping | `[card number removed]` |
| IBANs | mod-97 and the country's length | `[IBAN removed]` |

Each detector checks the number itself, not just its shape. A bare regex
would mask every ten-digit order number and teach people to ignore the hub.
The cost runs the other way: a CPR number with an impossible date is not
caught. Names are not detected. For those, use "find everything about a name"
under People's data.

What happens to a match:
- **Memory writes are refused, and the agent is told why**, so it can write
  the fact without the number. This is checked:
  - in the gate, before a proposal could carry the number to an approver who
    would not notice it;
  - in the memory server;
  - in the Steward's `knowledge_remember_for`;
  - in the store itself (`rememberMemory`);
  - in the hub's memory tools for Claude Code.
- **What is stored about a run is masked**: the question, the answer, the
  error and every string in the transcript (`packages/db/src/sessions.ts`).
  The answer the person sees as the run finishes is not changed. The masking
  applies to what is kept, not to what was said.

Documents are not masked. A contract is allowed to contain an account number.
Label the collection instead.

## What leaves the hub

Whatever the hub's MCP server returns lands in the Claude account the person
connected, possibly a personal one, on that account's terms (F8). So:

- **Knowledge.** The hub's MCP server, local agents and the REST routes
  (`/api/rag/search`, `/api/documents`) do not search, list or open labelled
  collections (`outsideAccess` in `lib/sensitivity.ts`). Admins are included:
  the rule is about where the material goes, not who is asking.
- **Answers.** An agent or skill answer from a labelled run is replaced by a
  link to the run in the hub. This covers `hub_agent_*`, `hub_skill_*`,
  `hub_run_agent`, `hub_run_status` and `POST /api/agent/run`. A labelled
  run's held writes are listed without their arguments. The person reads the
  answer under "Your answers", where retention applies.
- **Connections.** A labelled connection is not proxied through the hub's MCP
  server. It is not dialled for a local agent either, and that agent's model
  is told why.
- **Settings → Where your answers go** tells each person this, and asks them
  to use the organisation's Claude account.

Requiring organisation accounts is a WorkOS / identity provider setting, not
the hub's.

## The read log

`knowledge_reads` records each read of a confidential or special collection:
who, which document, which run, when, and through which door. The doors are:
- `run`: an agent's retrieval;
- `chat`: a conversation on an agent's page;
- `page`: opening it or testing retrieval on the Documents page;
- `mcp`: reserved. Nothing labelled leaves through MCP, so nothing is logged
  there.

What was asked is never recorded, because that would make the log sensitive
itself. A refused read is not a read.

Admins read it under Admin → People's data → "Who read confidential
material". It is kept for the audit period and swept with the audit trail.
It is part of a person's export, and is deleted when they are erased.

## Verifying

`npm run verify:sensitivity -w web` runs 70 checks through the shipping code.
It covers:
- the detector;
- the five memory refusals;
- masking at rest, with the live answer unchanged;
- who may set labels;
- special runs: no memory, no transcript, no trace (counted at a stand-in
  Langfuse);
- confidential memory scope, including a collection opened behind the hub's
  back;
- the label carried by hand-offs, asks and chat follow-ups;
- the hub's MCP server, a local agent and the REST routes;
- the Steward;
- the read log end to end.

The log's expiry is proven by a sweep, which is global, as in
`verify:retention`. Not proven: dropping a labelled connection the hub's MCP
server would have proxied with a person's own token, which needs an OAuth
sign-in.
