# Effective agents: what Anthropic has learnt, and how the hub can help people organise their own

*November 2026. A read of everything Anthropic has published on building
agents, from "Building effective agents" (December 2024) to the Managed
Agents post (2026), set against what the hub has today. The question is not
"is the hub built the way Anthropic builds agents" — mostly it is — but "how
does the hub help the person at a client who sets agents up for their
colleagues do it well, without us". Findings first, then proposals, then an
order.*

## The short answer

The hub already has most of Anthropic's building blocks, often as rows a
person can see and switch off rather than as code: the augmented LLM is an
agent; prompt chaining is a hand-off; routing is the Front desk; the
orchestrator is the Cluster; the evaluator-optimiser is the Critic loop; the
human-in-the-loop checkpoint is the approvals queue. Where the hub is ahead
of the articles is on *who* an agent runs as, what it may read and what
leaves the building — the articles have little to say about that, and the
hub has five phases of it.

What the hub lacks is the part of every Anthropic post that comes **after**
the pattern: the loop that makes an agent good. Anthropic's advice, repeated
in nine posts over two years, comes down to six habits:

1. **Start with one model call and add a step only when it demonstrably
   helps.**
2. **Keep the context small and high-signal**: the brief at the right
   altitude, few tools, examples over rules.
3. **Delegate with an objective, a format, boundaries and the context
   copied in.**
4. **Verify the work before delivering it**, with rules, a second reading or
   a judge.
5. **Keep twenty to fifty test cases from real failures, and read the
   transcripts.**
6. **Question the scaffolding every time the model changes.**

The hub gives a champion the patterns (1, partly), one memory design (2,
partly) and a critic loop (4, for one shape). It gives them nothing for 3, 5
or 6, and it leads with "hire a team" where Anthropic leads with "one agent,
until it fails". So today a champion who wants a better agent has one
lever: edit the brief and hope. The proposals below give them the other
five, in the hub, in plain words, and make the choice of shape something the
hub explains rather than assumes.

## What Anthropic says

Nine posts, in order. Each is condensed to what bears on the hub; the quotes
are theirs.

### Building effective agents (December 2024)

The vocabulary everyone uses since. **Workflows** are "LLMs and tools
orchestrated through predefined code paths"; **agents** are systems where
"LLMs dynamically direct their own processes and tool usage". The advice:
"find the simplest solution possible, and only increasing complexity when
needed", because "agentic systems trade latency and cost for better task
performance". Often one call with retrieval and examples is enough.

The building blocks, each with a "when":

| Block | What it is | When |
|---|---|---|
| Augmented LLM | one model with retrieval, tools and memory | the foundation of everything |
| Prompt chaining | calls in sequence, each on the last one's output, with optional programmatic gates between | the task decomposes into fixed steps; latency for accuracy |
| Routing | classify, then send to a specialised path | distinct categories handled better apart; "sending easy queries to a smaller model" |
| Parallelisation | run calls at once and merge: **sectioning** (independent parts) or **voting** (the same task several times) | speed, or several perspectives for confidence; a guardrail beside the answer |
| Orchestrator-workers | a central model breaks the task down, delegates, synthesises | the sub-tasks "can't be predicted" from the input |
| Evaluator-optimiser | one generates, one evaluates, in a loop | "clear evaluation criteria exist and iteration measurably helps" |
| Agents | a model using tools in a loop, with "ground truth" from the environment and a stopping condition | open-ended problems where the steps can't be scripted, and you trust the model |

Three principles: **simplicity**, **transparency** ("explicitly showing the
agent's planning steps") and the **agent-computer interface**: "we suggest
putting as much effort into your tool descriptions as your prompts"; tool
design deserves "the same care as human-computer interface design"; and
poka-yoke, "change the arguments so that it is harder to make mistakes". The
SWE-bench team "spent more time optimising tools than the overall prompt".

### How we built our multi-agent research system (June 2025)

The orchestrator-workers pattern at scale: a lead agent plans, spawns
subagents that search in parallel in their own context windows, and
synthesises. Multi-agent beat single-agent by 90% on breadth-first research.
The reason is blunt: "multi-agent systems work mainly because they help
spend enough tokens to solve the problem" — token usage explained 80% of the
variance. Agents use about 4× a chat's tokens; multi-agent about 15×. It
pays only when "the value of the task is high enough".

The prompt engineering principles are the useful part for a hub:

- **Teach the orchestrator how to delegate.** "Each subagent needs an
  objective, an output format, guidance on the tools and sources to use, and
  clear task boundaries." Vague instructions produced duplicated work.
- **Scale effort to complexity.** Simple fact-finding: one agent, 3–10 tool
  calls. Complex research: more than ten subagents. Explicit rules stop
  overinvestment.
- **Start wide, then narrow.** Short broad queries first; long specific ones
  return little.
- **Let agents improve themselves.** Claude rewrote a flawed tool
  description and cut task time by 40%.
- **Parallel tool calls** cut research time by up to 90%.

On evaluation: start with "about 20 real-world queries"; judge "the outcome
and reasonable process", never a fixed sequence of steps; one LLM-as-judge
prompt scoring accuracy, citations, completeness, source quality and tool
efficiency aligned best with humans; and "even in a world of automated
evaluations, manual testing remains essential".

On production: stateful agents need checkpoints and resume rather than
restart; full tracing of decision patterns "without reading individual
conversation contents, to protect privacy"; rainbow deployments because
agents are mid-run when the code changes.

### Building agents with the Claude Agent SDK (September 2025)

One loop: **gather context → take action → verify work → repeat.** Each
stage has its techniques:

- *Gather:* agentic search over files first, semantic search second;
  subagents "for tasks that require sifting through large amounts of
  information where most of it won't be useful"; compaction when context
  fills.
- *Act:* "your tools should be primary actions you want your agent to
  take"; scripts and code for the rest; MCP for other systems.
- *Verify:* rules-based checks that say what failed and why; visual
  feedback; LLM-as-judge, which is "generally not a very robust method" but
  useful where it pays.

And: "build a representative eval set based on customer usage to catch
regressions as you add features."

### Effective context engineering for AI agents (September 2025)

"Context rot": performance drops as the window fills, on every model.
Context is "a finite resource with diminishing marginal returns". The
guiding principle: "the smallest possible set of high-signal tokens that
maximise the likelihood of some desired outcome".

- **System prompts at the right altitude**: not brittle if-else logic, not
  vague guidance. Headed sections. "Start with a minimal prompt tested on
  the best available model, then add instructions and examples in response
  to observed failures."
- **Tools**: few, non-overlapping, token-efficient. "If a human engineer
  can't definitively say which tool should be used in a given situation, an
  AI agent can't be expected to do better."
- **Examples**: a few diverse, canonical ones beat a list of edge-case
  rules.
- **Just-in-time retrieval**: keep references, load on demand; a hybrid of
  preloaded and on-demand usually wins.
- **Long horizons**: compaction (recall first, then precision; clearing old
  tool results is the lightest form), **structured note-taking** outside
  the window (a NOTES.md, a to-do list), and sub-agents that each work in a
  clean window and return a one- to two-thousand-token summary.

### Writing effective tools for agents (September 2025)

"Tools are a new kind of software which reflects a contract between
deterministic systems and non-deterministic agents." Build a prototype, then
an evaluation of dozens of realistic tasks with verifiable outcomes, then
read the transcripts, then let Claude refactor the tools. The principles:

- **Few tools for high-impact workflows**: `search_contacts` over
  `list_contacts`; "more tools don't always lead to better outcomes".
- **Namespace** by service and resource.
- **Return meaningful context**: names over UUIDs; a `response_format`
  parameter for concise or detailed.
- **Token efficiency**: pagination, filtering, truncation with sensible
  defaults; error messages that say what to do.
- **Describe each tool as to a new hire**; `user_id` not `user`. "Small
  description changes can have large effects."

### Equipping agents for the real world with Agent Skills (October 2025)

A skill is "organised folders of instructions, scripts, and resources that
agents can discover and load dynamically": a `SKILL.md` with a name and
description, a body, and linked files. **Progressive disclosure**: only the
name and description are always in context; the body loads when relevant;
linked files when needed. "Anyone with procedural knowledge can package
it": the point is domain experts sharing their workflows, not a custom agent
per use case. Write a skill by running agents on representative tasks,
finding where they struggle, and closing the gap; "give special attention to
`name` and `description`", since they decide when it triggers. Treat skills
from strangers as code to audit. Skills became an open standard.

### Effective harnesses for long-running agents (November 2025)

Agents working across sessions "start without memory of earlier work", and
compaction alone was not enough. Two failures: **doing too much at once**
(running out of context mid-feature) and **declaring victory early**. The
fix is externalised state: an initialiser that writes a feature list (JSON,
every item failing, "unacceptable to remove or edit tests"), a progress log,
a startup script, a first commit; then each session reads the log, picks
**one** unfinished item, verifies the basics first, does the item, commits,
updates the log. Testing "as a human user would" (browser automation)
"improved results considerably"; Claude kept marking features done after
unit tests alone.

### Demystifying evals for AI agents (January 2026)

The vocabulary: task, trial, grader, transcript, outcome ("the final state
in the environment", not what the agent said it did), suite. Grade
outcomes, not tool sequences. Three kinds of grader — code-based,
model-based, human — combined, with humans mostly calibrating the model
graders. **Capability** evals start low and climb; **regression** evals sit
near 100%. **pass@k** when one success is enough; **pass^k** when a
customer-facing agent must be consistent.

How to start: "twenty to fifty simple tasks drawn from real failures";
turn user-reported failures into test cases; "ambiguity in task
specifications becomes noise in metrics", so two experts should agree on
the verdict and a reference solution proves the task is solvable; balance
when a behaviour should and should not happen; a clean environment per
trial. Pitfalls: a 0% pass rate is usually a broken task; give a judge an
"Unknown" option; saturation; and above all "Read the transcripts!"

### Harness design for long-running application development (March 2026)

A **generator** builds, a separate **evaluator** judges, because "agents
reliably skew positive when grading their own work". A **planner** turns a
sentence into a spec but stays high-level so spec errors do not cascade.
Generator and evaluator negotiate a "sprint contract" — what done means and
how it is tested — before each sprint. Out of the box Claude was a weak QA
agent: "it noticed real issues, then talked itself into approving them";
rounds of tuning against a person's judgement fixed it. The evaluator is
"worth its cost when a task sits beyond what the model handles reliably
alone". And: "re-examine the harness with each new model and remove pieces
that are no longer load-bearing."

### Scaling Managed Agents (2026)

Three parts behind stable interfaces: a **session** (an append-only log),
a **harness** (the loop) and a **sandbox** (where code runs). Keep the
session outside the harness so any harness can crash and resume. Keep
credentials out of the sandbox: "the harness is never made aware of any
credentials"; a proxy makes the call. "Question harness assumptions
regularly": context resets that helped one model were "dead weight" on the
next.

## The hub against the articles

### The building blocks

| Anthropic | The hub | Gap |
|---|---|---|
| Augmented LLM | An agent: brief, tools, knowledge scope, memory (`docs/agents.md`) | none |
| Prompt chaining | A hand-off row (`agent_handoffs`); the Assembly line pattern | no programmatic gate between stages — a stage cannot be checked by a rule before the next starts; three stages from a person's run |
| Routing | The Front desk (model-based, one specialist per question) | no cheap-model routing: every agent pins one model; the patterns put the coordinator and the worker on the same default |
| Parallelisation | — | **the one block the hub lacks.** `runAgent.ts` executes a turn's tool calls one after another, so a coordinator's asks and a run's reads are serial. No voting |
| Orchestrator-workers | The Cluster, the Elephant & goldfish; `agents_ask`, one deep, twelve per run | the ask carries "the task and nothing else": no objective/format/boundaries structure, so a weak coordinator writes a weak task and nobody sees it was weak until the answer |
| Evaluator-optimiser | The Critic loop, three rounds | only as a pair of agents; a single agent or a skill cannot have its answer checked |
| Agents | Every run: a tool loop with `max_iterations`, `exhausted` said out loud, approvals as the checkpoint | none |
| Human in the loop | `/approvals`, per agent per server, with the model's `reason` | none — this is ahead of the articles |

### The six habits

| Habit | The hub today | What a champion has |
|---|---|---|
| **Start simple** | `/agents/new` has "Not sure where to start? Use a ready-made team"; `/agents/patterns` is headed "Hire a team, not an agent" | no guidance on when one agent is enough, or which shape a situation calls for; the patterns' `when` lists are the closest thing |
| **Small, high-signal context** | memory scopes; active vs set-aside memory; the goldfish worker; top-5 retrieval; the run page's "what the first request carried" and "largest tool result" | the brief has a word count and nothing else: no altitude check, no examples prompt, no token estimate, no sign that a brief names tools the agent has not got; no compaction or tool-result clearing in a long run; memory grows with no readout of what it costs every turn |
| **Delegate properly** | the Coordinator's and Archivist's briefs *tell the model* to copy context in, under 400 words, one ask per job | the tool does not ask for it, so the rule lives in prose; the asked run's page shows the task, not whether it had what it needed |
| **Verify the work** | approvals verify *writes*; the Reviewer verifies *drafts* in one pattern; a run that ran out says so | an ordinary agent or skill delivers its first answer unchecked; "LLM as a judge" and rules-based checks exist nowhere a champion can switch on |
| **Test cases and transcripts** | `verify-*` scripts for the wiring; the layer-3 scenario proposal in `docs/agent-testing.md`; the bench for prompt speed; the run page's timings | nothing in the product: no place to keep a case, no pass rate, no "save this failure as a test"; and **no page shows a transcript**, not even to the person whose run it is (it is stored for 7 days and read by nobody but the Steward) |
| **Question the scaffolding** | the limits are constants: 10 iterations, 12 asks, 3 rounds, 2 hand-offs, 5 passages, 400-word briefs | not written down as *scaffolding* anywhere, so nobody knows which to revisit when the model changes and which are load-bearing (the scopes, the gate) |

### Where the hub is ahead

The articles are written by a team that runs its own agents. The hub is
run by someone else's company, and that shows in what it has that they do
not describe: a run as a *person* with that person's reach; memory with a
scope the model cannot choose; what leaves the hub decided by a label;
credentials sealed and proxied so "the harness is never made aware" of them
(the Managed Agents lesson, already built); every write a proposal with a
reason; a transcript that expires. None of this should move. It also means
the proposals below must respect it: a test case is a person's run, a judge
sees what that person may see, and a transcript is read by its own person.

### Where the hub disagrees, on purpose

- **Asks are sequential and one deep.** The research post's lead agent
  "waits for each subagent batch" too; async was future work. Depth 1 is
  the pattern doc's decision and the right one. Parallel is the gap, not
  depth.
- **Transcripts expire after 7 days and no page shows them.** Anthropic
  monitored "decision patterns … without reading individual conversation
  contents" for privacy, then says "read the transcripts" for quality. The
  hub resolves this the same way the research team did: numbers for
  everyone, content for the run's own person while it is kept.
- **No autonomous self-improvement.** "Let agents improve themselves"
  rewrote a tool description in a lab. In the hub a brief is a row an admin
  owns and the gate holds writes; an agent proposing a change to its own
  brief would be a proposal, which is exactly the Steward's shape. Later,
  if at all.

## Proposals

Each says what it is, which article it comes from, how it fits the hub,
and roughly how big it is. They are grouped by the habit they give a
champion.

### A · Start simple, and say which shape

**A1. The chooser.** A short page, or the top of `/agents/new`, that asks
four questions in plain words and names the shape:

| Question | Yes → |
|---|---|
| Is it one kind of job, done the same way each time, with an answer a person reads? | **one agent with a skill**. Stop here. |
| Does it need several areas of expertise at once, and should the reader see who said what? | the Cluster |
| Should people type a question without knowing who to ask? | the Front desk |
| Is there a standard the answer must meet, written down? | the Critic loop (or A3 below, on one agent) |
| Does the context for a recurring job keep growing, and must one job never colour the next? | the Elephant & goldfish |
| Are there steps that different briefs do best, with nothing going back a step? | the Assembly line |

"Building effective agents" in one card: the first row is the default, and
the page says why ("every extra agent costs time and money on every run;
reach for one when a single agent demonstrably fails at the job"). The
`when` lines each pattern already carries become the chooser's rows.
*Small: a page and copy.*

**A2. One agent first on the patterns page.** Retitle "Hire a team, not an
agent" to something that does not contradict Anthropic's first rule, and
put a "One agent" card at the top that links to `/agents/new`. *Trivial.*

**A3. Cheap workers.** Routing's second example is "easy queries to a
smaller model". The patterns put every role on the deployment default.
Give workers, specialists, stages and the Reviewer a cheaper model by
default (Sonnet), and coordinators the default, with the agent form's model
hint saying which is which. The research system ran Opus as lead and
Sonnet as workers. *Small: five pattern files and a hint.*

### B · A brief at the right altitude

**B1. Brief health, beside the word count.** The form shows "412 words".
Show what the context-engineering post would check:

- about how many tokens it is, and what that is as a share of a turn
  (the run page already measures "what the first request carried");
- whether it has an example of a good answer (the post's "pictures");
- whether it names a tool or a server the agent is not given;
- whether it has headed sections;
- the count of "always" and "never" — a brief that is mostly hard rules is
  "brittle hardcoded if-else logic" in prose.

Said as hints, never as refusals. *Small–medium: one function in
`lib/agentDesign.ts`, used by the form and `hub_agent_create`.*

**B2. A brief template.** The empty brief gets a structure a champion can
fill, from the seeds' own shape and the post's advice: who it is and for
whom · what it does · what a good answer looks like, with one example · what
it must not do · what it should say when it cannot. The usability review's
"Simple wording" rule applies. *Small.*

**B3. Memory as a budget.** The Memory tab lists memories; it should also
say what they cost: "14 loaded into every run, about 1,900 tokens", with a
nudge above a threshold to set some aside, and the Steward offered a fourth
proposal, *set aside* — it already reads every agent's memory. This is
"structured note-taking" kept honest. *Small.*

**B4. Clear old tool results in long runs.** The lightest compaction in the
post: a run's N-th turn need not carry the full text of a 40 KB tool result
from turn 2. The run page already names "the largest tool result and how
many later turns reread it". Replace tool results older than K turns with
their size and a line, in `runAgent.ts`, behind a per-agent setting under
Advanced. *Medium: a change in the loop and its verify.*

### C · Delegation the tool asks for

**C1. A structured ask.** `agents_ask` takes `agent` and `task`. Make it
take what the research post says every subagent needs: `objective` (one
sentence), `context` (the facts, copied in), `format` (what shape the
answer takes), `boundaries` (what not to do). The hub joins them into the
asked run's prompt under those headings. The Coordinator's brief stops
having to *tell* the model; the schema asks. The asked run's page shows the
four fields, so a person can see a weak delegation at a glance. *Small–
medium: `askAgents.ts`, the five patterns' briefs, `verify:asks`.*

**C2. Parallel asks and reads.** Execute a turn's tool calls concurrently
when every one of them is read-only or an ask (asks start runs, which hold
their own writes; reads are reads). Writes stay serial. The research post's
"up to 90%" is for search; a Cluster with four specialists goes from four
waits to one. `runAgent.ts`'s `for … await` becomes a `Promise.all` over the
safe subset, results returned in the model's order. The timeline records
each tool's own time already. *Medium: the loop, the gate's read-only
knowledge (`needsApproval` already knows), `verify:loop`, `verify:asks`.*

**C3. Scale effort to complexity, in the brief.** The Coordinator's and
Front desk's briefs get the research post's rule: a question for one area
is one ask; a broad one is several; say how many you will make before you
make them. *Trivial.*

### D · Verify before delivering

**D1. Checks on a skill.** The one proposal that generalises the Critic
loop. A skill gets an optional **Checks** section, in the words of the
evals post's graders:

| Kind | A champion writes | The hub does |
|---|---|---|
| must mention / must not mention | words or a pattern | string check on the answer |
| length | "under 300 words" | count |
| cites | "every number has a source" | a judge question |
| writes | "proposes exactly 2 tasks" | counts held proposals under the run |
| a standard | numbered points, as the Critic loop's | a judge pass: a second model call with the answer and the points, answering APPROVED / NOT YET and which points, with an "cannot judge" option |

The run delivers its answer, then the verdict beside it on *Your answers*
("Checked: 4 of 5 · missing a price"). Nothing is withheld; the person sees
what the check saw. The judge runs as the same person with no tools and no
memory, so it widens nothing. *Medium–large: schema on `agent_skills`,
`lib/checks.ts`, the run path, Your answers, `hub_skill_create`.* This is
what makes D2 possible.

**D2. A self-check line in every brief.** Cheaper than D1 and from the
harness post: before answering, re-read the task and say what you did not
do. The seeds have it under their own names ("say what you cannot do");
make it the brief template's last section (B2). *Trivial.*

### E · Test cases a champion can keep

**E1. Test cases on a skill.** The product version of layer 3 in
`docs/agent-testing.md`, and the evals post's "twenty to fifty tasks from
real failures":

- A **case** is an input (the skill's arguments) and the checks of D1 that
  a good answer passes, plus an optional reference answer.
- **Save as a test case** on any of *Your answers* or a run: the input is
  copied, the checks start empty, the person writes what should have
  happened. This is "turn user-reported failures into test cases".
- **Run the cases** runs each `k` times (default 3) as the person, with the
  real model, and reports pass rate per case and pass^k over the suite; it
  says how many model calls it will make first, as the bench does.
- The result is stored on the skill with the brief's hash, so changing the
  brief and re-running shows "was 9/10, now 7/10" — the regression suite —
  and a champion can revert.
- Cases are the skill's, not the person's: a colleague's failure becomes
  everyone's test.

Outcome over path: a case never asserts which tools were used. Clean
environment per trial: a case runs with memory loaded but writes held, so
it leaves nothing. *Large: schema, a runner that reuses `runSkillForPrincipal`,
a tab, `hub_skill_test`. The most valuable single thing on this list.*

**E2. Read the transcript.** The run page shows turns, times and sizes and
nothing of what was said. Add the content — each turn's text and each
tool's result — on the run page for **the run's own person** and admins,
in the Expert view, while the transcript is kept (7 days), never for a
special-category run, and masked as stored. "Read the transcripts" is the
one habit every post ends on, and the hub stores them and lets nobody look.
*Small–medium: the run page and `privateRun`; the data is there.*

**E3. A "what went wrong" button.** On a bad answer, one click that opens
the run with the transcript (E2) and offers "Save as a test case" (E1) and
"Edit the brief". That is the whole loop on one page. *Small once E1 and E2
exist.*

### F · Scaffolding, written down

**F1. The scaffolding list.** A section in `docs/agent-patterns.md`
naming every number the hub picked for a model it no longer runs — 10
rounds, 12 asks, 3 rounds, 2 deep, 5 passages, 400 words, 10-minute ask
timeout, 7-day transcripts — with what each protects against, and a note
to revisit on each model change. Separately, the list of what is
**structural** and never moves: who a run runs as, memory scopes, labels,
the gate. *A doc.*

**F2. Model names.** The agent form offers Opus 4.8, Sonnet 4.6 and Haiku
4.5. That is the deployment's business (`HUB_MODEL_IDS`), but the list is
the champion's view of "which model", and it should follow the hub's
default rather than be three fixed rows. *Small, and not this review's.*

### G · Skills as the thing people share

**G1. Export a skill as a SKILL.md.** The hub imports the standard and
writes nothing back. A skill's prompt, parameters and (after D1) checks as
a `SKILL.md` folder, downloadable, so a champion can give it to another
hub, another firm, or Claude Code directly. "Anyone with procedural
knowledge can package it" cuts both ways. *Small.*

**G2. Descriptions as triggers.** A skill's description is what a connected
client reads to decide when to call it. The form should say so where the
description is typed, with the skills post's advice (what it is for, when
to use it, when not), and B1's health check should cover it. *Trivial.*

### H · Two patterns the articles add

**H1. The Checklist runner** (from the long-running harness post). For work
that is too big for one run and comes round on a schedule: a *Planner*
skill that writes the checklist as a memory (every item open, numbered);
each scheduled run reads it, verifies the basics, does **one** item, marks
it, writes a progress line; a *Reviewer* (the Critic loop's, no memory)
checks an item before it is marked done. The Steward's sweep is this shape
already, by hand. *Medium: one pattern file, verify:patterns.*

**H2. The Second opinion** (voting, the one parallelisation the hub could
use). The same question to two or three specialists at once (C2), the
coordinator reporting where they agree and where they do not. Only after
C2, and only if a client asks: the research post's cost multiplier applies.
*Small after C2.*

## How this helps people organise themselves

Today a champion's path is: pick a team, fill in names, read the agents'
run pages, edit briefs. With the proposals, it is the loop every Anthropic
post describes, on the hub's own pages:

1. **Start with one agent** (A1, A2), with a brief the form helps shape
   (B1, B2) and a cheaper model where it does not matter (A3).
2. **Give it a skill with a check** (D1), so its first answers come back
   with a verdict a colleague can read.
3. **Save the failures as test cases** (E1, E3), read the transcript when a
   verdict surprises (E2), and change the brief with a pass rate to show
   whether it helped.
4. **Only when the tests show a kind of failure one agent cannot fix** —
   it needs two areas of expertise, the context has grown too large, people
   ask the wrong agent — **reach for the shape the chooser names** (A1),
   and the asks it makes are structured (C1) and parallel (C2).
5. **Keep the memory honest** (B3) and let the Steward help.

None of it needs us in the loop, and none of it widens what an agent may
do: every run in a test is the champion's run, every check sees what they
see, every write is still held.

## Suggested order

| Phase | What | Why first |
|---|---|---|
| **1 · Say it** (days) | A1, A2, A3, B2, C3, D2, F1, G2 | copy and small files; it changes what a champion reaches for before anything is built |
| **2 · See it** (a week) | E2, B1, B3 | the transcript and the brief's health are the two things a person needs in order to improve an agent, and both are already measured or stored |
| **3 · Delegate and verify** (a week each) | C1, C2, D1 | the structured ask fixes the weakest link in every team pattern; parallel asks make the Cluster usable; checks make a single agent trustworthy without a second agent |
| **4 · Test** (two weeks) | E1, E3 | the loop closes: failures become cases, cases guard the brief |
| **5 · Extend** (as asked) | B4, G1, H1, H2 | each is a client's request waiting to happen |

Every phase gets a verify script in the existing style; E1 is the one that
also spends model money by design, and says so before it does.

## Progress

**Phase 1 is done.** On branch `claude/available-mcps-wurs52`, not deployed.

| | What changed | Proven by |
|---|---|---|
| A1 | `/agents/choose`: one question per shape, one agent first, each pattern's question kept in its own code (`Pattern.question`); the link opens that pattern on the patterns page | `verify:views` (web), 89 checks |
| A2 | The patterns page says most jobs need one agent, and links the chooser; the New agent and Agents pages point at the chooser before any team | the same |
| A3 | Workers, specialists, stages and the reviewer are created on the cheaper model (`CHEAPER_MODEL`); the archivist, coordinator, writer and front desk stay on the default; the form's model list says which is which | `verify:patterns` (db), 84 checks |
| B2, D2 | "Start from the template" on an empty brief: headed sections, one example, and a self-check ("say what you did not do") as the last section | `verify:views` |
| C3 | The coordinator's and the front desk's briefs scale their asks to the question and say which specialists they will ask before asking | `verify:patterns` |
| F1 | The scaffolding table in docs/agent-patterns.md: every number, what it protects against, when to revisit; and what is structural | a doc |
| G2 | The skill form says a connected client reads only the name and description to decide whether to call it | — |

## What this deliberately leaves out

- **Agent teams that talk to each other** (Claude Code's peer-to-peer
  teams). The hub's asks are one deep on purpose; a mesh is cost and loops
  with no pattern that wants it.
- **Asynchronous asks.** The research post calls it future work for the
  same reasons it would be hard here: result coordination, state, errors.
  Parallel-within-a-turn (C2) gets most of the benefit.
- **Agents editing their own briefs.** A proposal through the gate, in the
  Steward's shape, if ever.
- **A managed sandbox.** The hub's "hands" are MCP servers; code execution
  for agents is a different product decision.
- **Semantic routing by a classifier instead of the Front desk.** The
  Front desk remembers who asks what, which a classifier would not.

## Sources

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), December 2024
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), June 2025
- [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk), September 2025
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), September 2025
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), September 2025
- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), October 2025
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), November 2025
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), January 2026
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), March 2026
- [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents), 2026
