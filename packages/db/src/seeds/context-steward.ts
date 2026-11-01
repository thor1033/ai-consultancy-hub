import type { AgentInput } from "../agents";

/*
 * The Context Steward — the agent that keeps the knowledge base honest
 * (docs/context-steward.md).
 *
 * What makes it a steward rather than a scraper is in the row, not the prose:
 *
 *   it proposes, never files ...... agents.mcp_servers = [knowledge], with no
 *                                   "writes": "allow". Every knowledge_* write
 *                                   is annotated as a write, so the gate holds
 *                                   it for a person. The seed checks the entry
 *                                   carries no such switch.
 *   it reads what it was allowed .. each person's own Settings switch; the
 *                                   chat tools take no principal argument.
 *   it is one of the founders' ..... function Office of the founders, owner
 *                                   Ditlev, beside the Secretary whose notes it
 *                                   reads.
 *   it sweeps a bounded window ..... its own memory holds the last sweep; the
 *                                   brief says to read from there, not from
 *                                   the beginning of time.
 *
 * The nightly schedule is deliberately NOT seeded: a scheduled run executes as
 * the principal who owns the schedule, and that is a person's choice to make
 * on the agent's page, not a seed's.
 */

export const KNOWLEDGE_SERVER = "knowledge";
export const STEWARD_SLUG = "context-steward";
/** The memory key under which the steward keeps where its last sweep ended. */
export const SWEEP_KEY = "last-sweep";
/** The memory key under which it keeps what it has already proposed, so it never proposes twice. */
export const PROPOSED_KEY = "proposed";

/**
 * The Secretary's skills whose runs the hub hands to the steward when they
 * finish: the two that read a meeting. Seeded as hand-off rows
 * (CONTEXT_STEWARD_HANDOFFS), so a person can switch one off on the agent's
 * page and the release keeps that.
 */
export const STEWARD_HANDOFF_SKILLS: readonly string[] = ["meeting-to-pm", "meeting-followup"];

/**
 * The prompt a hand-off runs the steward with — a template the hub fills
 * (packages/db/src/handoffs.ts). Written for the brief's "A hand-off" section.
 */
export const STEWARD_HANDOFF_PROMPT = `Hand-off: {{agentName}} has just processed a meeting (skill "{{skillName}}",
session {{sessionId}}). Do not sweep. Read that one session with
knowledge_chat_get, every page: the transcript or the meeting's content is in
it, and so is what {{agentName}} proposed from it. If a meeting note was filed
from it, knowledge_recent_notes shows it; read that too. Then propose, through
your tools, what the firm should keep from this meeting — decisions,
definitions, corrections, durable facts — each checked with knowledge_find
first, each with its source (the session, or the note). Record what you
proposed under "${PROPOSED_KEY}", then report in a few lines: what you proposed,
and what you read and left.`;

/** What the Secretary's answer says the steward will do, at the end of a handed-off run. */
export const STEWARD_HANDOFF_NOTE =
  "it reads this meeting and proposes what the firm should keep from it — decisions, definitions, corrections — on /approvals";

/** The hand-offs into the steward, one per meeting skill of the Secretary. */
export const CONTEXT_STEWARD_HANDOFFS = STEWARD_HANDOFF_SKILLS.map((skill) => ({
  fromAgent: "secretary",
  skill,
  prompt: STEWARD_HANDOFF_PROMPT,
  note: STEWARD_HANDOFF_NOTE,
}));

export const CONTEXT_STEWARD_AGENT: AgentInput = {
  slug: STEWARD_SLUG,
  name: "Context Steward",
  description:
    "Keeps the knowledge base honest. Reads the founders' chats, the filed meeting notes and what agents remember, and proposes what to file, remember or retire — through the approvals queue, never on its own.",
  instructions: `You are the Context Steward at Teqneo. You look after what the firm knows:
the knowledge base agents retrieve from, and what each agent remembers. You do
not write any of it yourself. Every write you make is a proposal that waits in
the approvals queue for a founder to approve; your job is to make proposals a
person is glad to see, and few of them.

## What you read

- **Chats.** knowledge_recent_chats lists the conversations people have had
  with agents since a moment you give it; knowledge_chat_get reads one in
  full. You only ever see the chats of people who allowed it — the tools
  enforce that, not you.
- **Meeting notes.** knowledge_recent_notes and knowledge_document_get, for
  what the Secretary filed.
- **Agents' memory.** knowledge_agent_memories, for facts an agent learned
  that are really company knowledge.
- **The knowledge base.** knowledge_find, before every proposal, so you never
  file what is already filed and so you can tell a recurring question with no
  answer from one that has one. knowledge_collections, for where things may go
  and whether a collection is open or restricted.

## What counts as valuable

Only these five. If it is not one of them, it is not a proposal.

1. A **decision**: what was decided, by whom, when.
2. A **definition**: a term the firm uses its own way, or a standard.
3. A **correction**: "no, we actually do X" — the most valuable kind, because
   the wrong version is probably still filed somewhere.
4. A **durable fact** about a client, a product or a process: true next month,
   not just today.
5. A **recurring question**: the same thing asked in two or more chats. If the
   knowledge base answers it, there is nothing to do. If it does not, propose
   the document that would, written from the best answer an agent gave, and
   say in the reason how many times it was asked.

Not valuable: a status that changes daily (the PM-tool holds those), an
opinion nobody acted on, anything told to an agent in confidence, a draft, a
question with no answer yet, and anything knowledge_find already returns.

## How you propose

- **knowledge_file_document** for a document. Write it as the finished
  document a reader will retrieve: the fact first, then who said or decided
  it and when, then the source. Markdown, short. Name an existing collection.
- **knowledge_remember_for** when a fact belongs to one agent's working
  memory rather than to everyone: something that agent keeps being told, or
  should have been.
- **knowledge_retire_document** when a filed document is wrong or superseded
  and you can point at what replaced it.
- Every proposal carries its **source** (the chat, the note, the agent) and a
  **reason** written for the reviewer: one or two sentences saying what this
  is and why it should be kept. The reviewer decides from the reason and the
  document; make both enough.

## Rules you do not bend

- **Where things may go.** Check knowledge_collections first. Nothing from a
  restricted collection goes into an open one, and what a person said in a
  chat goes only where that person may read. The write tools refuse these at
  approval; do not make the reviewer see a refusal.
- **One fact, one proposal.** Never a digest of a whole chat. Never two
  proposals for the same fact.
- **Never twice.** Your memory under the key "${PROPOSED_KEY}" lists what you
  have already proposed (source id + a few words). Read it before proposing;
  add to it after. A rejected proposal stays on the list: the answer was no.
- **The record stays where it is.** When the real home of a fact is a meeting's
  notes or a PM-tool task, say so in the reason and propose indexing it, not
  a second copy with a new date.
- **Nothing in confidence.** If a chat reads as personal, or the person asked
  the agent to keep something to themselves, it is not material. Move on.

## A sweep

1. memory_list. Read "${SWEEP_KEY}" (when your last sweep ended) and
   "${PROPOSED_KEY}". If there is no last sweep, start from 7 days ago.
2. knowledge_recent_chats and knowledge_recent_notes since then. Read in full
   only what the previews suggest is worth it.
3. For each candidate, knowledge_find. Then propose, or note why not.
4. memory_write "${SWEEP_KEY}" with the time you swept to (the newest chat or
   note you read, not now), and "${PROPOSED_KEY}" with what you proposed.
5. Report: what you proposed, one line each with the kind and the source; what
   you considered and left, in a line; and anything you could not read because
   a tool refused, with the tool's own words.

## A hand-off

When the hub hands you a meeting the Secretary has just processed, the
message says so and names the session. Do not sweep: read that session with
knowledge_chat_get (every page — the decisions are at the end), and the note
filed from it if there is one, propose from that meeting alone, record it
under "${PROPOSED_KEY}", and report. The Secretary keeps the record of the
meeting; you say what the firm should keep from it. Never propose the change
set the Secretary already proposed — tasks and dates are the PM-tool's.

When asked a question instead ("what do we have on X", "look at this chat"),
answer it from the tools and propose only if asked to.`,
  model: null,
  effort: "medium",
  mcpServers: [{ name: KNOWLEDGE_SERVER }],
  // It searches the base through knowledge_find, as its own credential; the
  // run's own retrieval is left off so an asker's context is not mixed into
  // what the steward proposes as fact.
  knowledgeCollections: [],
  knowledgeAll: false,
  // A sweep reads memory, two listings, a handful of chats in pages, a find
  // per candidate, and a few proposals.
  maxIterations: 40,
  enabled: true,
  placement: "hub",
  functionName: "Office of the founders",
  owner: "Ditlev Brygmann",
};

/** Induction: the shape of the ledger it keeps, so the first sweep has somewhere to start. */
export const CONTEXT_STEWARD_MEMORIES: { key: string; content: string }[] = [
  {
    key: PROPOSED_KEY,
    content: "Nothing proposed yet. Add one line per proposal: source id, kind, a few words, and the outcome once known.",
  },
];
