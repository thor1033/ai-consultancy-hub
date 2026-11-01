# Retention, and a person's rights over their data

The hub keeps the **outcome** of a run and drops the **evidence**. Every run
used to be kept forever, in full: every message, plus every tool result, such
as the emails a mailbox read and the records a connected system returned
(docs/data-protection-review.md, F2). Now each kind of content has a lifetime,
and a person's right to a copy of their data, or to have it erased, is a
button.

## How long things are kept

| What | Kept for | Setting |
|---|---|---|
| A run's **transcript**: every message and everything its tools read | 7 days | `HUB_RETAIN_TRANSCRIPTS_DAYS` |
| A run's **question, answer and error** | 90 days | `HUB_RETAIN_ANSWERS_DAYS` |
| A **decided** proposal's arguments, result, reason and notes | 90 days after the decision | the same |
| The **audit trail** | 365 days, except records of erasure, which are kept | `HUB_RETAIN_AUDIT_DAYS` |
| Documents, memories, decks, schedules | until someone removes them | none |

The settings have guard rails:
- **Whole numbers of days only, from 0 to 3650.** Anything else falls back to
  the default, so a typo can never mean "forever" or "now".
- **A transcript is never kept longer than the answer it holds.**

**What stays after the words go** is the numbers: which agent and skill, which
tools and servers, status, cost, tokens and the timeline. The ROI report needs
those and nothing else. "Your answers" says an answer has expired rather than
showing a blank. A decided proposal says its details were removed, and keeps
what it was, by whom and when.

Two things are never touched: **a run still running and a pending proposal.**

The transcript window is short on purpose. Nothing a person reads uses the
transcript; it is there for debugging and for the Context Steward, which reads
recent conversations. After 7 days the Steward reads the question and answer
instead.

## The clean-up

`sweepRetention` (`packages/db/src/personalData.ts`) applies the policy.

- **Safe to repeat.** What it clears is stamped (`content_expired_at`,
  `transcript_dropped_at`), so a second run changes nothing.
- **Every six hours.** The scheduler runs it on its own track beside the
  schedules.
- **Paced by the record.** It checks the last sweep on the audit trail
  (`retention.sweep`), so several machines still sweep about once per
  window.
- **By hand.** An admin can run it from Admin → People's data.

It runs where the scheduler runs (`HUB_SCHEDULER=1`).

A sweep applies to the whole database, as it should. **Backups** are a
separate matter: Neon's point-in-time restore keeps old states for the
project's restore window, so set that window to match what you promise.

## A person's rights

| | Who | Where |
|---|---|---|
| **Download your data** | Anyone signed in, for themselves | Settings → Your data (`/settings/export`) |
| **Download someone's data** | Admins | Admin → People's data |
| **Erase a person** | Admins, never themselves, after typing the person's email | Admin → People's data |
| **Find everything about a name** | Admins | Admin → People's data |

**An export** is a JSON file of everything the hub holds about a person as a
user, as retention has left it:
- their runs' questions and answers;
- proposals;
- memories kept for them, and memories they added to shared ones;
- schedules and decks;
- the collections they were granted;
- credentials, by name and prefix (never secrets);
- their audit trail.

**An erasure** is one transaction:
- It deletes their runs, their personal memories, their local-agent call log,
  their audit entries and their row.
- Through the schema's cascades, that also takes their credentials, collection
  grants, schedules and proposals.
- Decks they owned stay with the organisation, unowned.
- Shared memories they added keep their content, since it is the
  organisation's knowledge now, but are no longer linked to them.
- The erasure itself is recorded (`data.erased`, with counts and no content)
  and kept: it is the proof the request was carried out.
- The person can no longer sign in.

**Find everything about a name** is for a request about someone who may never
have used the hub, such as a client's employee named in a meeting. It searches
questions, answers and transcripts, memories, documents, proposals, decks and
people. The person reading the results decides what to remove. Automatic
masking of names in other people's content is phase 4, which covers
detection.

Exports, erasures and searches are all on the audit trail (`data.exported`,
`data.erased`, `data.searched`), with who did them. A search reveals what the
hub holds, so it is recorded too.

## Verifying

`npm run verify:retention -w web` runs 38 checks:
- that the policy is read, and nonsense falls back to the default;
- what the sweep clears, keeps and never touches, and that it is safe to
  repeat;
- the scheduler's pacing;
- an expired answer under "Your answers";
- export permissions and contents;
- erasure permissions, what it removes and keeps, and that the person cannot
  sign in afterwards;
- the subject search.

It notes that a sweep is global: it is meant for a development database.
