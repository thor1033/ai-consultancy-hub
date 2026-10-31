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

**Not from inside a run, by design.** An agent on the hub holds the MCP servers
on its row (PM-tool, Teams, knowledge, its memory) and nothing that starts
another agent. Three things do start agents:

| What starts an agent | How | As whom |
|---|---|---|
| A person or an outside client | `hub_agent_*` and `hub_skill_*` tools on `/api/mcp`, the agent's page, the chat | the caller |
| The clock | a schedule (`docs/schedules.md`) | the schedule's owner |
| **The hub, after a run** | the hand-off: a finished `meeting-to-pm` or `meeting-followup` run starts the Context Steward (`lib/stewardHandoff.ts`) | the same person as the run it follows |
| A Claude Code session ending | the work-log hook sends the session's commits to the Project Manager's `pm-work-log` skill | the hook's credential |

So "agents working together" today means **hand-offs the hub drives**, written
in code, each tested. That is deliberate: a chain in code says who runs, as
whom, and when, and an approval gate sits on every write either way.

**If agents should ask each other directly** (the Secretary asking the Product
Owner "is this task already done?" mid-run), the shape that fits the hub is a
bundled `agents` server with one read tool, `ask_agent(slug, question)`, that
runs the other agent as the same principal and returns its answer. The
decisions it needs, before it is built:

- **Read-only asks only?** The asked agent's writes are held for approval
  regardless, but an ask that triggers proposals is harder to review than one
  that returns an answer.
- **Depth.** One level (A asks B; B cannot ask C) keeps cost and loops bounded.
- **Which pairs.** An allow-list on the asking agent's row, like its servers,
  rather than every agent asking every other.

## Layer 1 — the wiring, with no model (built)

Each script drives the shipping code path against a real Postgres, with a
throwaway HTTP server standing in for the Messages API (it streams, as the real
one does), and creates and deletes its own fixtures. No API key, no spend.

| Question | Script | What it proves |
|---|---|---|
| Triggered at the right time | `verify:scheduler` (web) | a due schedule runs once, as its owner; a non-due one does not; an owner who may not run agents is refused and recorded; a revoked owner's schedule stops |
| | `verify:schedules` (db) | which schedules are due at a given minute, in their time zone; only one machine claims each |
| Agents in a chain | `verify:scheduler` (web) | **the clock fires a meeting skill → the Secretary runs as the owner → the hub hands the session to the Context Steward → the steward runs as the same owner**, pointed at that session; nobody asks either agent |
| | `verify:handoff` (web) | the hand-off itself: only after the session is recorded; only for the listed skills; a switched-off steward is said in the answer |
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

## Order

1. **Now:** layer 1, run before every merge. Done.
2. **Next:** decide the three layer-2 questions above, then stand the test hub
   up. A few hours of setup once the decisions are made.
3. **Then:** the five scenarios in layer 3, and `ask_agent` only if the
   scenarios show an agent that needed another's answer and could not get it.
