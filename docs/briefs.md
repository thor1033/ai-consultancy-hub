# Briefs — what an agent prepared for you to read

A **brief** is a skill whose output is published rather than returned: the
morning meeting prep, and whatever else is set up the same way. It is the first
thing the hub does *for* a person before they ask.

```
agent_skills.kind = 'brief'          the skill, e.g. meeting-prep
  └── agent_schedules.agent_skill_id  one person's morning clock for it
        └── tick()                    fills the template, runs it as the OWNER
              └── agent_sessions      the run; /briefs shows its output
```

## The page

`/briefs` lists runs of brief skills, newest first, rendered from Markdown. On
the right, one card per brief skill:

- **Run now, for today.** Runs the skill as you, with `day = today`. The page
  re-reads itself every ten seconds while a brief is being written.
- **Every morning, for me.** Creates a `daily` schedule **owned by you**, at the
  time you pick, weekdays unless you tick weekends. It runs as you, reads what
  you may read, and stops if you are disabled (see [schedules.md](schedules.md)).
  Switching it off disables the schedule and keeps its history; switch it off
  and on again to change the time. Two people can each have their own.

A brief is schedulable only when every required parameter is one the clock can
answer. Today that is `day`, answered with "today". A brief that needs anything
else is run from its agent's page or from Claude Code
(`hub_skill_<slug>`), and the card says so.

Briefs are not scoped to a person: they are about the shared record, such as the
Secretary's own calendar and mailbox, and the page requires `agent:run`. A brief
built from someone's private material would be a different feature.

## Meeting prep

The Secretary's `meeting-prep` skill (seeded by `seed-secretary.mjs`) prepares
whoever is walking into the meetings on the Secretary's calendar, so invite
`secretary@teqneo.co` to anything it should prepare for. For each meeting, in
calendar order:

| Section | Comes from |
|---|---|
| Who, where, status | `m365_calendar_get`, memory for roles |
| Since last time | `m365_mail_list` / `m365_mail_get` with the attendees and the title; `pm_get_project` when the meeting is about the delivery project; memory |
| We owe them | promises in that mail, quoted |
| Questions to settle, suggested shape | the agent's reading of the above |

Every bullet carries its source, dates are absolute, mails are quoted in their
original language, and the brief says plainly when it found nothing. It is
read-only by construction: the Microsoft 365 server has no tool that writes
([secretary-agent.md](secretary-agent.md)), so the brief can suggest that an
invitation needs answering but cannot answer it.

Arguments: `day` (`today`, `tomorrow` or `YYYY-MM-DD`) and an optional `focus`
to narrow to one meeting. From Claude Code: `hub_skill_meeting_prep`.

## Making another brief

On an agent's page, under Skills, set a skill's output to **A brief**. It then
appears on `/briefs`. Give it a `day` parameter if it should run on a clock, and
write the template so that it reads before it writes and never claims to have
acted.

## Verifying

| Command | Covers |
|---|---|
| `npm run verify:schedules -w @ai-hub/db` | a skill schedule needs no prompt, stores the skill and its arguments, hands both to the runner, and goes when the skill is deleted |
| `npm run verify:agents -w @ai-hub/db` | `listBriefs` returns brief runs with output and failures, and never a task's run |
| `node packages/db/seed-secretary.mjs --check` | the `meeting-prep` template: fills with only `day`, refuses without it, reads and does not act |

## Not done yet

- **Delivery.** The brief lives on the page and in Claude Code. Mailing it to
  the person would be the first write worth allowing, restricted in code to the
  company's own domain, and it should land together with the approval step.
- **Per-meeting timing.** One brief per morning, not thirty minutes before each
  meeting. A `daily` schedule is what exists; a schedule that follows the
  calendar is a different kind.
- **Transcripts.** Post-meeting notes still start from a transcript someone
  pastes into `meeting-to-pm`.
