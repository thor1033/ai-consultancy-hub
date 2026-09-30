# Schedules — the clock

## What this is

Until this existed, every agent run in the hub began with a person: a chat turn,
an API call, a tool call from Claude Code. That makes an agent a window you open,
not a worker. A **schedule** is a standing instruction to run one agent, with one
prompt, on a clock.

```
agent_schedules                       agent, prompt, when, owner
  └── runDueSchedules()               @ai-hub/db — which are due, who claims one
        └── tick()                    apps/web/lib/scheduler.ts — runs it
              └── runAgentForPrincipal(… as the OWNER …)
                    └── agent_sessions   the run, like any other
```

## Whose reach a scheduled run has

A schedule belongs to a **principal**, and its runs execute as that principal.

This is the design decision everything else follows from. Retrieval is scoped to
the caller's grants — an agent never has a reach of its own (see
`docs/knowledge-access.md`) — and an unattended run has no caller to scope it to.
The alternatives were both worse: a service identity with standing access to
everything would make "schedule it" a way around the grants, and an unscoped run
would quietly read whatever it liked.

So a scheduled briefing reads exactly what the person who scheduled it may read.
It also means revocation works the way people expect:

| Disable | And the schedule |
| --- | --- |
| the owning principal | stops — it is not even considered |
| the agent | stops |
| the schedule | stops |
| delete the principal or agent | the schedule goes with it (FK cascade) |

## When it fires

Two shapes, neither needing a cron parser:

- **`every N minutes`** — fires when `N` minutes have passed since the last run.
  For polling something that changes.
- **`daily at HH:MM`**, on chosen weekdays, in a named IANA timezone. For the
  07:30 briefing.

`daily` is compared as **local wall-clock time**, and "have I run today?" as a
**local calendar date**. That is what makes the clock changes behave:

- In autumn, when 02:30 happens twice, the second one is the same local date and
  does not fire again.
- In spring, a time that does not exist that day (02:30 in most of Europe) simply
  does not fire. A known gap — pick a time outside 02:00–03:00 for anything that
  must run every day.
- An ordinary 07:30 briefing stays at 07:30 through both.

A `daily` schedule will still fire up to `DAILY_CATCH_UP_MINUTES` (10) late, so a
slow tick, a restart or a deploy at 07:30 does not lose the day. It deliberately
will not fire hours late: a briefing delivered at lunchtime reads as current.

**Missed runs are not made up.** If the container is down from 07:00 to 08:00,
that day's 07:30 run does not happen.

## Running it

The ticker lives in `apps/web/src/instrumentation.ts`, Next's server-start hook —
the one place the hub can run something that is not a request. It ticks every 60
seconds, and it is **off unless `HUB_SCHEDULER=1`**. The default is off because
the consequence of being wrong is an agent acting unbidden: a dev container
pointed at production's database should not start reading a mailbox every minute.

It is safe on more than one Fly machine. All of them tick; `claimSchedule` stamps
`last_run_at` in a conditional UPDATE, so exactly one wins and the rest move on.
The stamp goes on before the run rather than after, because a run takes minutes
and a schedule still holding its old timestamp would look due to every tick in
between.

A tick never blocks on a run: it waits 5 seconds for a run id and moves on, and
the run finishes in the container afterwards — the same racing-a-deadline shape
`runAgentForPrincipal` already uses for MCP clients.

## Verification

| Command | Covers |
| --- | --- |
| `npm run verify:schedules -w @ai-hub/db` | the whole truth table of `isDue` against a fixed clock — both clock changes included — plus the store, validation, and that two simultaneous claims produce exactly one run |
| `npm run verify:scheduler -w web` | the real `tick()`: that a run lands in `agent_sessions` as the *owner*, that an owner who may not run agents is refused and the refusal recorded, and that revoking the owner stops it |

Neither spends anything. The scheduler one stands up a throwaway HTTP server in
place of the Messages API and switches remote MCP servers off, so it cannot
reach the live PM-tool; both need `DATABASE_URL` and clean up after themselves.

## What this deliberately does not do yet

- **No UI.** Schedules are created through `@ai-hub/db` (or SQL); there is no
  panel on `/agents/[slug]` yet. Nothing about the shape below the UI changes
  when one arrives.
- **Nothing to gate — done, 2026-09-28.** The natural next step for a secretary
  was *drafting* a reply, and that was the point where an approval step had to
  exist. It does now: `m365_mail_draft` writes into Drafts and an `approvals`
  row parks the send for a person ([approvals.md](approvals.md)). The gate
  landed with the first write tool rather than after it, which was the whole
  point. What a scheduled run still cannot do is *send* — nothing carries an
  approved action out yet.
- **No webhook.** A schedule is a clock, not a subscription. Reacting to mail as
  it arrives means a Graph change notification endpoint, which is its own
  increment.
