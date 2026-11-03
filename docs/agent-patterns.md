# Agents working together: patterns, asks and hand-offs

Status: **built**. Five patterns, two ways agents connect, and the switches
behind them.

## The idea

One agent with one brief is the hub's unit of work, and it stays that way.
What this adds is the wiring between agents, as data the hub runs, and
premade sets of agents that come pre-wired: a **pattern**. A pattern is
picked on `/agents/patterns`, given a name and a few parameters, and becomes
ordinary agents on the org chart. They are the person's from then on; the
pattern is only where they came from.

Two reasons to do it this way rather than a "multi-agent engine":

- **The hub already runs agents well**: a run as a person, writes held for
  approval, memory, knowledge narrowed to the asker, a timeline on every run.
  Agents working together needs two more verbs, not a new runtime.
- **A design is reviewable when it is code.** Who remembers, who starts
  clean, who may ask whom and how deep are decisions. They are written in
  `packages/db/src/patterns/*.ts` and checked by `verify:patterns`, like a
  seeded agent's brief is.

## The two verbs

| | Hand-off | Ask |
|---|---|---|
| When | A run **finishes** | While a run is **going** |
| Who starts it | The hub, from a row on the finished agent | The running agent, through the tool `agents_ask` |
| As whom | The same person as the finished run | The same person as the asking run |
| What the next agent gets | The hand-off's prompt, filled with the finished run's answer, id, prompt, agent and skill | The task the asker sent, and nothing else |
| Waited for | No: the finished run's answer says it was started | Yes: the answer comes back as the tool's result |
| How deep | Fires only from a run less than **2** hand-offs deep | Offered only to a run less than **1** ask deep: an asked agent asks nobody |
| How many | One row, one next run | **12** asks per run, then the tool refuses |
| Where it shows | The finished run's answer; the next run's page says "started by" | The asker's run page: the ask is a tool call with its time; the asked run says "started by" |

Both widen nothing. The next agent runs with its own tools, memory and
knowledge, as the same person, and every write it proposes waits on
`/approvals` like any run's. Neither is itself held: starting a run changes
nothing outside the hub. An agent's chat, a client's tool call, a schedule
and a hand-off all cooperate the same way (`lib/agentRuns.ts`,
`cooperation()`).

### Hand-offs as rows

`agent_handoffs`: when a run of `from` finishes (any run, or a run of one
skill), start `to` with `prompt`. The prompt is a template:

| Placeholder | Filled with |
|---|---|
| `{{output}}` | the finished run's answer |
| `{{sessionId}}` | its id, for an agent that reads sessions (the steward) |
| `{{prompt}}` | what it was asked |
| `{{agentName}}`, `{{skillName}}` | who finished, and which skill |

`note` is what the finished run's answer says the next agent does:
*Handed to Context Steward (run …): it reads this meeting and proposes …*.
A hand-off whose next agent is off, or whose run is already two deep, is
said in the answer too: *Not handed to X: …*. A row a person switched off
fires nothing and says nothing.

The first hand-off — the Secretary's two meeting skills to the Context
Steward — was written in code. It is now two rows the steward's seed
declares (`CONTEXT_STEWARD_HANDOFFS`), applied on release with the same
rules as its skills: the prompt is the code's until a person changes it, the
switch is the page's. A person sees and edits every hand-off on the agent's
**Hand-offs** tab, from both sides.

### Asks: whom an agent may ask

An agent's entry `{"name": "agents", "agents": ["slug", …]}` is its
allow-list, set under *What it may use* on its page beside its tool servers.
At run time the hub offers `agents_ask` listing exactly the agents on that
list that exist, are on and run on the hub; the model cannot name any other.
The asked agent runs as the same person, under the asker's run, one deep —
and at one deep it is offered no `agents_ask`, whatever its own entry says.
So a coordinator asks workers and workers ask nobody: no fan-out of
fan-outs, no loops.

**An ask has four fields** (docs/effective-agents-review.md, C1): the
`objective`, the `context` the asked agent cannot see, the `format` the
answer should take, and optional `boundaries`. The hub joins them into the
asked run's prompt — the objective first, the rest under `## What you need
to know`, `## The answer`, `## Boundaries` — so the asked run's page shows
a weak delegation at a glance. The schema asks for them one by one, which
is the point: a single free-text task is where a model forgets the context.
The old single `task` field still works, as the objective.

**Asks that do not depend on each other run at once** (C2). When the model
makes several tool calls in one turn, the loop runs the parallel-safe ones
together: an ask, a tool the server marks read-only, the memory server's
reads. A write — held or allowed — runs after them, one at a time, in the
model's order, and the results go back in the model's order whatever
finished first. A cluster of four specialists takes one wait, not four.

**Decided, and why:**

- **An ask is not held for approval.** It starts a run; the run's own
  writes are held. Holding the ask would hold the coordinator for a person
  on every question, which is the one thing a pattern is for avoiding.
- **One deep.** Every pattern here needs one level. A second level is
  cost and loops with no pattern that wants it.
- **Allow-list on the asker's row.** Like its tool servers: visible on the
  page, kept by the release rules, never widened by a prompt.
- **Twelve per run.** Enough for a coordinator with a dozen specialists;
  a bound on a run that asks in a loop.
- **Ten minutes per ask.** After that the asker is told the run is still
  going and where its answer lands, and finishes without it.

### Memory off

`agents.keeps_memory`, on by default for every agent: the rule that an agent
that could forget everything is just a chat window still holds. Off is for
one role: a **worker briefed by an agent that remembers**. It starts every
run with nothing but the prompt — no memory server on the hub, no memory
tools in Claude Code — so nothing from one job colours the next, and its
prompt stays small. The switch is under *What it may use* on the agent's
page.

## The patterns

| Pattern | Nickname | Roles | Wiring | Use it when |
|---|---|---|---|---|
| Long memory, short hands | **Elephant & goldfish** | Archivist (remembers, reads everything), Worker (no memory, no knowledge) | Archivist asks Worker | the context for a recurring job has grown large; the job should be fast; one job must not colour the next |
| Coordinator and specialists | **Cluster** | Coordinator, one Specialist per area | Coordinator asks each Specialist | a question needs several kinds of expertise, and you want to see which expert said which part |
| Stages, one after another | **Assembly line** | one agent per stage, none remembering | each stage hands to the next; the first has a *Start* skill | the work has clear steps that different briefs do best, and nothing goes back a step |
| Writer and reviewer | **Critic loop** | Writer (remembers), Reviewer (no memory) | Writer asks Reviewer, up to three rounds | the output has a standard you can write down |
| One door, many specialists | **Front desk** | Front desk, one Specialist per area | Front desk asks ONE Specialist per question | people should not have to know which agent to ask |

**Which model.** The roles that do bounded work — a worker, a specialist, a
stage, the reviewer — are created on the cheaper model (`CHEAPER_MODEL`,
Sonnet); the roles that plan, delegate or reconcile — the archivist, the
coordinator, the writer, the front desk — stay on the deployment's default.
Anthropic's research system ran this way, lead on the largest model and
subagents one down. Any role's model is changed on its page.

**Which shape.** `/agents/choose` asks one question per pattern, the
`question` each carries in code, with "one agent" as the first row and the
answer for most jobs (docs/effective-agents-review.md, A1).

Every pattern takes a name for the set, an owner and a function (the org
chart's columns), then its own parameters. A `list` parameter is one line
per item, written `Name: what it covers`; each line becomes an agent. The
page previews everything a pattern would create — each agent, whether it
remembers, whom it may ask, its tools and skills, the hand-offs — before
anything is written, and creation is all-or-nothing: a slug already taken
refuses the whole set.

Why the elephant and goldfish is first: it is the answer to what the run
pages measure. Every model turn re-reads everything before it, so an agent
that carries months of memory and knowledge into every job is slow at the
moment it should be quick. The worker runs on a few hundred words; the
archivist decides what each job taught the firm.

## How it is built

```
packages/db/src/patterns/*.ts      the five designs: roles, briefs, wiring
packages/db/src/patterns/index.ts  previewPattern (pure) · instantiatePattern (rows, all or nothing)
packages/db/src/handoffs.ts        agent_handoffs rows · renderHandoffPrompt
packages/db/src/seeds/apply.ts     a seed may declare hand-offs into its agent
apps/web/src/lib/handoffs.ts       runHandoffs: fired after a run is recorded, depth-bounded
apps/web/src/lib/askAgents.ts      agents_ask: the tool, the executor, the bounds
apps/web/src/lib/agentRuns.ts      cooperation(): memory switch, asks, parent/depth, for every run path
apps/web/src/app/agents/patterns   the page and its two actions (preview, create)
apps/web/src/app/agents/[slug]     the Hand-offs tab; memory and asks in Settings
```

`agent_sessions.parent_session_id` and `depth` record the chain: a run's
page says what started it and what it started, and the depth limits read
from the row rather than from a counter in memory.

## Verify

```bash
npm run verify:patterns -w @ai-hub/db       # 80 checks: every pattern previewed and created, hand-off rows, seeded hand-offs
npm run verify:asks -w web                  # 21: a coordinator asks a worker through the real run path
npm run verify:handoff -w web               # 32: hand-off rows, the steward's, a loop that stops
npm run verify:scheduler -w web             # the clock → Secretary → Steward, as the owner
npm run verify:seeds -w @ai-hub/db          # the release rules
```

`verify:asks` proves, with a stand-in model playing both agents: the tool
lists exactly the allowed agents that are on; the asked run hangs off the
asker's, one deep, as the same person, with its own tools, no ask tool and
no memory tools (it keeps none); its write is held under its own run; the
answer comes back into the asker's run and timeline; an agent not on the
list is refused in words; twelve asks stop a greedy run. `verify:handoff`
proves the chain stops at two, each refusal said, and that a hand-off keyed
to any run carries the finished run's answer.

**What they cannot prove:** whether a real coordinator splits a question
well, or a real reviewer judges well. That is the model's doing, read on the
run pages, and the reason every pattern's page lists what to decide after
creating it.

## The scaffolding, and what is not

Every number below was chosen for a model the hub no longer runs, to
protect against something. Anthropic's advice is to question such
scaffolding on each model change and remove what is no longer load-bearing
(docs/effective-agents-review.md, F1). Revisit this table when the default
model changes.

| Number | Where | Protects against | Revisit when |
|---|---|---|---|
| 10 tool rounds per run, ceiling 100 | `DEFAULT_MAX_ITERATIONS`, `MAX_ITERATIONS_CEILING` (@ai-hub/agent) | a run that loops; a misconfigured agent's cost | the model needs fewer calls for the same work |
| 12 asks per run | `ASK_BUDGET` (lib/askAgents.ts) | a coordinator that asks in a loop | a client needs more specialists (asks in one turn already run at once) |
| 1 ask deep | `ASK_MAX_DEPTH` | fan-out of fan-outs, loops | a pattern wants a second level — none does |
| 2 hand-offs deep | `HANDOFF_MAX_DEPTH` (lib/handoffs.ts) | two agents handing to each other forever | a pipeline needs a fourth stage from one run |
| 10 minutes per ask | `ASK_TIMEOUT_MS` | an asker that waits on a hung run | runs get faster |
| 5 passages retrieved | `retrieveChunks(…, 5, …)` in agentRuns and the chat | context rot from retrieval | the window or the chunking changes |
| 3 rounds in the critic loop | the Writer's brief | a draft that never passes | the reviewer's verdicts say otherwise on the run pages |
| 400 words for a brief to the worker | the Archivist's brief | the archivist doing the worker's job | the worker's model reads more for the same money |
| 7 days of transcript | `HUB_RETAIN_TRANSCRIPTS_DAYS` | holding evidence longer than it is read | never for a longer default; shorter if nobody reads them |

What is **not** scaffolding, and never moves with the model: who a run runs
as (docs/schedules.md); memory scopes (docs/memory-scopes.md); sensitivity
labels and what leaves the hub (docs/sensitivity.md); every write held for
a person (docs/approvals.md); and that an agent's reach is the caller's
(docs/knowledge-access.md).

## Against Anthropic's own patterns

[effective-agents-review.md](effective-agents-review.md) sets these patterns
against everything Anthropic has published on building agents, and proposes
what the hub should add so a champion can choose a shape, write a brief,
delegate, verify and test without us.

## Known limits

- **Asks are hub-only.** An agent placed in Claude Code is served its tools,
  memory and knowledge through the hub, not other agents. A local agent that
  should ask another asks it through the hub's own `hub_agent_*` tools, as
  the person.
- **No fan-out in parallel.** A coordinator asks its specialists one after
  another. Enough for a dozen; a pattern that needs fifty at once is a
  different design.
- **A pipeline from a person's run is three stages.** The fourth would be a
  run three hand-offs deep. A longer line restarts from a schedule or a
  person, which is the right place for a checkpoint anyway.

## What this deliberately does not do

- **Run agents in a loop until a condition holds.** The critic loop's three
  rounds are the writer's brief, bounded by its stamina, not a controller.
- **Let a pattern bind its agents.** Once created they are rows like any
  other: edit one, switch one off, delete one. The tag says where they came
  from and nothing more.
- **Give an asked agent anything but the task.** No conversation, no memory
  of the asker, no knowledge the asker retrieved: it starts clean, by
  design, so what it is told is what it is told.
