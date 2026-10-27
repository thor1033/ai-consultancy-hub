# The Project Manager

The agent that owns the plan: what is late, who owns it, what it blocks, and
what has to happen next for the nearest milestone to be met. It existed as a
row typed into `/agents`; it now lives in code
(`packages/db/src/seeds/project-manager.ts`) because three things were added
that a textarea cannot hold: where it runs, what it knows how to do, and how
the work reaches it.

## Where it runs

Placement **both**. On the hub it is `hub_agent_project_manager` and the
`/agents` console; in Claude Code it is the `hub-project-manager` sub-agent and
four skills, synced by the SessionStart hook
([local-agents.md](local-agents.md)). The point is the second half: "what
should I do first?" is asked where the code is, and the board is told what was
built from where it was built.

## What it may do

It holds the **read+write** PM-tool entry (`pm-tool`): `pm_create_task`,
`pm_update_task`, `pm_add_note`, and the reads. Every write it attempts is
**held for a person on `/approvals`** unless an admin switches the gate off for
it ([approvals.md](approvals.md)). So the PM proposes, a founder approves, and
the row changes with the PM's label in the audit trail. Its brief says
"proposed" for a held call and "changed" for one that ran, because the tool's
answer says which.

What it cannot do is also in the brief, so it reports rather than
approximates: no tool moves a milestone's date, creates a milestone or a
track, moves a task between tracks, sets a task's kind, or touches a risk.

## The skills

| Skill | Takes | Gives | Writes? |
|---|---|---|---|
| `pm-standup` | `for` (a person, or blank for both), `horizonDays` | Do this first; late and what it blocks; due next; in progress; needs a decision. Short, for a phone. | No |
| `pm-plan-this` | `work`, `track`, `milestone`, `owner`, `apply` | Three to eight tasks grounded against the board, each marked new or already there. With `apply=create`, calls `pm_create_task` for the new ones. | Only with `apply=create`, each call held |
| `pm-weekly-status` | `audience` (founders / client) | The one thing; moved; slipped; milestones and whether the dates hold; decisions needed; next week. Fills with nothing given, for a schedule. | No |
| `pm-work-log` | `log`, `repo`, `branch` | Maps a session's commits to the board and proposes: done, in progress, a new task for an unplanned deliverable, or a note. | Yes, each call held |

In Claude Code: `/hub-pm-standup for="Thor Bøje Simonsen"`,
`/hub-pm-plan-this work="…" apply=create`. From any MCP client:
`hub_skill_pm_standup` and friends.

**The Monday report.** `/agents` → Project Manager → Schedules → New: the
skill *Weekly status*, `audience` blank, daily at a Monday-morning time in
`Europe/Copenhagen`, only Monday ticked. It runs as whoever set it up.

## The work log

`scripts/hub-work-log.mjs` runs as two hooks, installed in this repository's
`.claude/settings.json` and, for a colleague, by
[`setup-claude-code.mjs`](claude-code-setup.md) at user level:

- **SessionStart** `--start` records when the session began (in
  `~/.claude/hub/sessions/`, never inside the project).
- **SessionEnd** `--hook` collects what git can vouch for since then — the
  repository and branch, every commit's subject and body, how many files are
  still uncommitted, and the assistant's last message from the transcript —
  and sends it as one `tools/call` of `hub_skill_pm_work_log` to the hub's
  `/api/mcp`, with `HUB_TOKEN` as the bearer.

The PM then reads the board and proposes what the work implies. Done only when
a commit says it merged, shipped or was verified; in progress for a branch;
a new task only for an unplanned deliverable; otherwise one note with the
shas. Everything lands on `/approvals`.

What the hook deliberately does:

- **Sends nothing for a session that committed nothing.** A work log is a
  model run; a session that only read code should not cost one.
- **Sends nothing it cannot attribute.** Without a recorded start it does not
  guess which commits were this session's; it says so once and the next
  session records its start.
- **Never fails or blocks the session.** A refusal, a 401, an unreachable hub,
  a slow run: one line on stderr, exit 0. A long run answers with a run id and
  is not waited for.
- **Keeps the token in the header.** The body is the log and the names of
  the repository and branch; nothing else.
- **Cuts at 18,000 characters.** The hub's MCP server takes an inline string
  up to 20,000; a log that long is a transcript, not a log.

Configuration, from the environment: `HUB_URL`, `HUB_TOKEN` (as for the
sync), `HUB_WORK_LOG_SKILL` (default `pm-work-log`; a second product's
manager would take `atlas-work-log`), `HUB_WORK_LOG=off` to switch a machine
off.

## Provisioning

```bash
node packages/db/seed-project-manager.mjs --check                        # no DB
node --env-file=apps/web/.env.local packages/db/seed-project-manager.mjs
node --env-file=apps/web/.env.local packages/db/seed-project-manager.mjs --skills-only
```

The full seed rewrites the existing row from the definition — instructions,
servers (`pm-tool` only), knowledge scope (`meetings`), placement (`both`) —
and adds three memories beside the ones the agent already has, which it
leaves alone and lists. A deployment that has tuned the row by hand runs
`--skills-only`.

The checks refuse to provision when: a skill marks done on a mention or a
branch; the standup or the weekly status names a write tool; `plan-this`
creates without `apply=create`; the agent holds anything but `pm-tool`; the
brief does not say its writes are held.

## Verify

```bash
npm run verify:work-log -w web            # the hook, against a throwaway repo and hub
node packages/db/seed-project-manager.mjs --check
```

`verify:work-log` (no database, no token): no start recorded ⇒ nothing sent
and why; a start then no commits ⇒ nothing, silently; two commits ⇒ exactly
one call to `/api/mcp`, `tools/call` of `hub_skill_pm_work_log`, token only in
the header, the log carrying this session's commits (not the earlier one),
the uncommitted count and the assistant's last text message; a 40KB commit
body cut at 18,000; a refusal, a 401 and an unreachable hub each one stderr
line and exit 0; `HUB_WORK_LOG=off`; `HUB_WORK_LOG_SKILL`; a directory that is
not a repository; no leftover session records. 21 checks.

What it cannot prove: that Claude Code fires `SessionEnd` with the fields the
script reads (`session_id`, `transcript_path`, `cwd`), which only a real
session shows; and the quality of the PM's matching, which is a model's work.

## Deliberately not done

- **Writing without a person.** The gate stays on for the PM. When a founder
  has approved enough work logs to trust it, switching the gate off for
  `pm-tool` on the PM's page is one click, and reversible.
- **A work log per turn.** `Stop` fires on every assistant turn; `SessionEnd`
  once. One log per session is the right grain for a board.
- **Reading the diff.** The hook sends what git says, not the code. The PM
  maps work to tasks by what the commits say they did; a session whose commits
  say nothing gets a note, not a guess.
- **A second manager per product.** One PM, one board, two tracks. If Atlas
  gets its own board, it gets `atlas-work-log` and its own PM from the same
  shape.
