# Approvals — the gate

## Why there has to be one

An agent run is an autonomous tool loop. Whatever tools the agent holds, it
calls, and nobody is watching while it does. That is fine while every tool only
reads, and it is why every capability the hub had until now was a reading one.

The pattern for keeping it that way has been to **withhold the tool**, never to
forbid its use in prose:

| Where | How |
| --- | --- |
| PM-tool | the secretary's credential is read-scoped, so `pm_create_task` is absent from its tool list ([secretary-agent.md](secretary-agent.md)) |
| Microsoft 365 | there is no tool that sends ([secretary-agent.md](secretary-agent.md)) |

That is why nothing here can do damage. It is also why the secretary cannot do a
secretary's job: answering a mail is the work, and the one thing it could not
do. This table is the other half — an action the agent has **fully specified**,
parked, until a named person decides on it.

```
agent run ──▶ m365_mail_draft ──▶ draft in Outlook, not sent
                                   │
                                   ▼
                              approvals row (pending)
                                   │
                        a person decides ──▶ approved ──▶ the HUB sends it
                                   └────────▶ rejected ──▶ nothing happens
```

The agent proposes and never applies — the same shape as the change set it
already produces for the PM tool, with the hub's own gate in place of Claude
Code's borrowed one.

## The three properties that make it a gate

**The decision is a claim, not an update.** Two people pressing Approve on the
same Teams card in the same second is the normal case, not the edge one.
`decideApproval` is a single conditional `UPDATE … where state = 'pending'`, so
exactly one caller wins and the loser is told *who* got there first — rather
than the mail being sent twice.

**The action is literal.** `action` holds the resolved arguments — the draft id,
the recipients, the subject, a preview. Same discipline as `call.args` in a
change set: what the approver reads is what gets carried out, and nothing is
re-derived afterwards.

**A decision expires.** Default 24 hours. A reply approved on Thursday by
someone scrolling back through a channel answers a question that was settled on
Tuesday. Expiry is enforced *in the UPDATE*, not by a sweeper, so an unrun
sweeper cannot make a stale action decidable; `expireStaleApprovals()` only
tidies the pending list.

## The decision and the delivery are different facts

| Columns | What they record |
| --- | --- |
| `state`, `decided_by`, `decided_at`, `decision_note` | what a **person** decided |
| `carried_out_at`, `result`, `failure` | what then **happened** |

An approved send that failed is not a rejection, and collapsing both into one
status would lose the fact that someone said yes. `state` never leaves
`approved` because a send failed — the reason goes in `failure`, which is
deliberately not called `error`: `createApproval` returns `{ error }` when it
refuses its input, and one field name for both would make `"error" in outcome`
quietly true for every successful row.

`result` holds what the outside world actually did, not what was proposed. For a
send that means the recipients and subject **as they stood at send time**, which
is how a draft someone edited in Outlook after approving it stays visible
afterwards instead of silently differing from the row.

## Who may decide

The decider must be an **enabled principal**, checked inside the same UPDATE.

That check lives in the store rather than in the caller on purpose. The caller
will be a Teams endpoint, where the set of people who can press a button is
"everyone in the channel" and not "everyone the hub knows". Disabling a
principal has to stop them approving for the same reason it stops their
schedules firing ([schedules.md](schedules.md)).

Self-approval is allowed: the person who asked the secretary to draft a reply is
the obvious person to approve it. Four-eyes would be a different product.

## Using it

```ts
import { createApproval, decideApproval, recordApprovalOutcome } from "@ai-hub/db";

const parked = await createApproval({
  kind: "mail.send",
  agentId, sessionId,
  requestedBy: principal.id,          // whose reach the run had
  summary: "Reply to Anna Holm: Friday 10:00 instead of Thursday",
  action: { draftId, to, subject, preview },
  origin: { kind: "teams", conversationId, activityId },
});

const outcome = await decideApproval({ id: parked.id, decision: "approved", decidedBy });
if (!outcome.ok) {
  // "not-found" | "already-decided" | "expired" | "not-permitted"
  // Four reasons, because a card has to say something different for each.
}
```

`origin` is where the request came from and where the answer belongs. It is null
until something inbound exists.

## Verify

```bash
node --experimental-transform-types --env-file=apps/web/.env.local \
  packages/db/verify-approvals.mjs        # or: npm run verify:approvals -w @ai-hub/db
```

No API key, no Microsoft tenant. Needs `DATABASE_URL` and a migrated database;
everything happens under a throwaway agent and two throwaway principals it
creates and deletes. 30 checks, and the four that matter are the four properties
above: two simultaneous decisions produce exactly one winner, an expired action
cannot be approved even though nothing swept it, a disabled principal cannot
approve, and a failed send stays approved.

## Where it is decided

In a Teams channel ([teams.md](teams.md)). A run that writes a draft parks
an approval and posts a card into the thread; Approve calls
`apps/web/src/lib/mail/send.ts`, which holds the only `Mail.Send` credential in
the hub and is reachable from nowhere else. `origin` carries the thread and the
card's activity id, which is what lets a decision replace that card rather than
leave live buttons on a settled row.

## What this deliberately does not do yet

- **No page on the hub.** Approvals are decided in the channel they were raised
  in, or through `@ai-hub/db`. Somebody who was not in that channel has nowhere
  to see what is waiting.
- **Nothing expires them on a clock.** `expireStaleApprovals()` exists and
  nothing calls it yet, so a pending list grows stale even though a stale row
  cannot be approved. A line in the scheduler tick is the obvious home.
- **One kind.** `kind` is unconstrained text and only `mail.send` exists. A
  second gated action — booking a meeting, writing to a client's system — needs
  no schema change, but it does need its own carrying-out path in
  `handler.ts`'s `carryOut`.
