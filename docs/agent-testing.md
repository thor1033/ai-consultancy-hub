# Testing the agents: together, on the clock, and one by one

Status: **layer 1 built**. Layers 2 and 3 are proposals that need the
founders' decisions (below).

## The questions

1. **Do the agents work together?** When one finishes, does the next one start,
   as the right person, with the right material?
2. **Can they call each other?**
3. **Are they triggered at the right times?** By the clock, by a hand-off, by a
   Claude Code session ending.
4. **Does each one do its job well?** The Secretary proposes the right tasks
   from a meeting; the Steward proposes few, good documents; the Project
   Manager's standup names what is really late.

Questions 1 and 3 are about the hub's wiring. They can be answered with no
model and no spend, and are, below. Question 4 is about the model's judgement
on real-looking material, and needs a real model and somewhere safe to run it.
Question 2 has an answer today, and a design choice behind it.

## Can agents call each other?

**Yes, two ways, both bounded** ([agent-patterns.md](agent-patterns.md)): an
agent may **ask** another while it runs (`agents_ask`, only the agents its
entry allows, one level deep, twelve per run), and the hub **hands** a
finished run to the agents its hand-off rows name. Both run the other agent
as the same person. What starts agents, in full:

| What starts an agent | How | As whom |
|---|---|---|
| A person or an outside client | `hub_agent_*` and `hub_skill_*` tools on `/api/mcp`, the agent's page, the chat | the caller |
| The clock | a schedule (`docs/schedules.md`) | the schedule's owner |
| **The hub, after a run** | a hand-off row on the finished agent (`lib/handoffs.ts`); the first two are the Secretary's meeting skills to the Context Steward | the same person as the run it follows |
| **Another agent, mid-run** | `agents_ask`, if the asker's entry lists the asked agent (`lib/askAgents.ts`) | the same person as the asker |
| A Claude Code session ending | the work-log hook sends the session's commits to the Project Manager's `pm-work-log` skill | the hook's credential |

The decisions behind the ask tool — not held for approval, one level deep, an
allow-list on the asker's row, twelve per run — are written down with their
reasons in [agent-patterns.md](agent-patterns.md), and `verify:asks` proves
each bound.

## Layer 1 — the wiring, with no model (built)

Each script drives the shipping code path against a real Postgres, with a
throwaway HTTP server standing in for the Messages API (it streams, as the real
one does), and creates and deletes its own fixtures. No API key, no spend.

| Question | Script | What it proves |
|---|---|---|
| Triggered at the right time | `verify:scheduler` (web) | a due schedule runs once, as its owner; a non-due one does not; an owner who may not run agents is refused and recorded; a revoked owner's schedule stops |
| | `verify:schedules` (db) | which schedules are due at a given minute, in their time zone; only one machine claims each |
| Agents in a chain | `verify:scheduler` (web) | **the clock fires a meeting skill → the Secretary runs as the owner → the hub hands the session to the Context Steward → the steward runs as the same owner**, pointed at that session; nobody asks either agent |
| | `verify:handoff` (web) | hand-off rows: only after the session is recorded; only for the skill named; a switched-off next agent is said; any-run hand-offs carry the answer; a loop stops at two deep |
| | `verify:asks` (web) | a coordinator asks a worker as the same person, one deep; the worker has no ask tool and no memory; its write is held; the budget stops a greedy run |
| | `verify:patterns` (db) | every pattern previews and creates what its design says: who remembers, who may ask whom, which hand-offs |
| | `verify:work-log` (web) | a Claude Code session that committed sends its work to the Project Manager; one that did not sends nothing |
| Writes wait for a person | `verify:approvals` (web) | every write is held, the right people decide, approving runs the exact call |
| Reachable from clients | `verify:agent-tools`, `verify:local-agents` (web) | the right agents appear as tools for the right person; a run id is not a bearer token |
| The seeded agents themselves | `seeds:check`, `verify:seeds` (db) | each seeded agent's brief, servers and skills; a release keeps what people changed |
| The steward's reach | `verify:knowledge` (mcp) | it reads only allowed people's chats; its writes are held; it files only where the source may be read |

Run them all locally:

```bash
docker compose up -d db && npm run migrate -w @ai-hub/db
npm run seed:context-steward -w @ai-hub/db       # the chain sections need the steward seeded
for s in verify:scheduler verify:handoff verify:approvals verify:agent-tools verify:local-agents verify:hub-memory; do npm run $s -w web || break; done
npm run verify:schedules -w @ai-hub/db && npm run verify:seeds -w @ai-hub/db && npm run verify:knowledge -w @ai-hub/mcp
```

**What layer 1 cannot prove:** anything the model decides. The stand-in answers
"Noted" to every prompt, so whether the Secretary picks the right tasks, or the
steward proposes the right documents, is not tested here.

## Layer 2 — a test hub (proposal)

A second deployment where agents run with the real model against material that
is not the firm's own. This is the Tier 3 of the PM-tool task *Set up a test
environment for all IT implementations*; what follows is the part of it the
agents need.

| Piece | Proposal | Why |
|---|---|---|
| App | `teqneo-ai-hub-test` on Fly, deployed from a `test` branch | production deploys from `master` on every push; the test hub must not |
| Database | a Neon branch of production's project, migrated and seeded by the same `release.mjs` | same schema and same seeded agents, separate rows |
| PM-tool | a **test org** in the PM-tool, with a synthetic project | the hub has no tenancy: one hub talks to one org, and agents testing against the real Teqneo board would propose real changes |
| Teams | off at first (`M365_*` unset, so `teams` refuses to start and says why); later a test team with recorded sample meetings | the M365 app registration reaches the real tenant |
| Scheduler | `HUB_SCHEDULER=1`, with schedules at test intervals | the clock is one of the things under test |
| Steward | its own `HUB_STEWARD_TOKEN`, `HUB_STEWARD_READERS` = the test users | the same fences as production, exercised |
| Model spend | a separate Anthropic key with a monthly limit | so a loop in a test cannot spend production's budget |

**Decisions it needs from the founders:** a monthly cost ceiling (a second Fly
machine, a Neon branch, model spend); whether a test PM-tool org is safe to
create (the PM-tool can reset `orgId` on login); and who owns keeping the
synthetic material realistic.

## Layer 3 — scenario checks on the test hub (proposal)

Scripted scenarios run against layer 2 with the real model, each with an
expected outcome a person wrote in advance, read from the hub's own records
(`agent_sessions`, `proposals`) rather than from the model's prose:

| Scenario | Input | Expected |
|---|---|---|
| Secretary, meeting to PM-tool | a synthetic transcript where two tasks are agreed and one is moved | `pm_create_task` ×2 and `pm_update_task` ×1 held on /approvals, each with a quote and a time in its reason |
| Hand-off | the same run | one steward run follows; it proposes the decision made in the meeting and not the tasks |
| Steward, nothing to keep | a transcript of small talk | no proposals |
| Project Manager, standup | a board with one overdue task blocking another | the overdue task named first, with what it blocks |
| Clock | `meeting-followup` scheduled every 10 minutes | one run per due slot, none twice, each as the owner |

Model output varies, so each scenario runs three times and is scored as a
pass rate, not a single pass. A scenario that drops below its rate after a
brief or model change is the signal. This is where "do they do their job well"
gets an answer, and it costs model spend on every run, which is why it is
proposed for the test hub and run by hand or nightly, not on every push.

## Prompt speed

Two tools, for two questions.

**"Why was that run slow?" — the run's page.** Every run now records where
its time went, turn by turn (`@ai-hub/agent` `RunTimeline`, stored in
`agent_sessions.timeline`). Click a run in an agent's *Recent runs* to open
`/agents/<slug>/runs/<id>`:

- **Where the time went:** one bar split into reading the prompt (the wait for
  the first token), thinking, writing the answer, writing tool calls, and
  waiting on tools, with a sentence naming the biggest part and what makes it
  faster — and the second part too when it is nearly as big.
- **Notes:** how many model calls the run took (each rereads everything before
  it), the largest tool result and how many later turns reread it, how much
  the prompt grew, the largest part of the first request, and how much came
  from the prompt cache.
- **Turn by turn**, to scale, with each tool call's time and result size.
- **What the first request carried:** the brief, retrieved knowledge, tool
  definitions, earlier chat turns and the request, approximately.

It shows numbers and tool names only — never the answer or a tool's result —
so it is visible to whoever can see the run in the agent's list. Runs from
before this change say so.

**"Which part of this prompt makes it slow?" — the bench.** The run page
shows one run; the bench compares variants of a prompt, several times each,
with the real model:

```bash
npm run bench:prompt -w @ai-hub/agent -- bench/secretary-meeting.json --out /tmp/bench.json
```

The example spec runs the Secretary's *Meeting → PM-tool change set* skill on
a short test transcript, three ways (as is, effort low, no thinking), plus
one variant per `##` section of the brief and the skill's template with that
section removed (`"ablate": true`). It prints, per variant: median time,
first run (cold, writing the prompt cache) and the median of the rest (warm),
wait for the first token, thinking, writing, tokens in and out, and the change
against the first variant. Then the exact token count of each part of the
prompt (counted by the API's free token counter). The spec format is at the
top of `packages/agent/bench-prompt.mjs`.

It **spends money**: every run is a real call. It prints the number of calls
before starting, refuses more than `--max-calls` (default 40), and prints what
it spent. The example is 21 calls. It measures one model turn of the prompt and
connects no tools; a slow tool shows on the run's page instead.

**How to read the two together:** output tokens drive most of a turn's time,
so a faster variant usually wrote or thought less — check its answer is still
the one you want. A smaller prompt mostly shortens the wait for the first
token, and on a run with several turns that wait repeats on every turn: the
run page's "largest tool result" note is usually the bigger saving than
trimming the brief.

| Script | What it proves |
|---|---|
| `verify:loop` (agent) | the timeline puts a delay the fixture chose — before the first token, inside thinking, inside writing, inside a tool — where it happened, and holds no content |
| `verify:run-timing` (web) | the verdicts for each kind of slowness; a real run stores its timeline; the run page renders it, shows the prompt's first line, never the answer, and 404s for another agent's run |
| `verify:bench` (agent) | the real CLI against a stand-in API: refusals before spending, one variant per section, interleaving, a removed section really removed and faster, exact counts adding up, a skill spec sending the brief plus the filled template |

## Order

1. **Now:** layer 1, run before every merge. Done.
2. **Next:** decide the three layer-2 questions above, then stand the test hub
   up. A few hours of setup once the decisions are made.
3. **Then:** the five scenarios in layer 3, and `ask_agent` only if the
   scenarios show an agent that needed another's answer and could not get it.
