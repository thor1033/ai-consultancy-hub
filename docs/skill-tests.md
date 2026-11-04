# Tests on a skill: cases, trials, and finding the best setup for a job

Status: **built** (docs/effective-agents-review.md, E1 and E3). On an agent's
page, under Skills, the **Tests** button on each skill; and from a client,
`hub_skill_cases` and `hub_skill_test`.

## The idea

A skill is a job: "review this contract", "write the weekly update". The
question a champion keeps asking is *which setup does this job best* — which
brief, which model, how much effort, one agent or a team — and the honest
answer is not an opinion about one answer but a count over many: the same
asks, several times each, under each setup, scored the same way.

This is Anthropic's evals post made product: twenty to fifty tasks drawn from
real failures, graded on the outcome, run enough times to tell a reliable
setup from a lucky one (their *pass^k*), kept so a change to the brief can be
measured rather than felt.

Three things, each the skill's and not any one person's:

| Thing | What it is | Where it comes from |
|---|---|---|
| **A case** | one thing the skill was asked (its arguments, or the exact request of a run), and the checks a good answer passes on top of the skill's own ([docs/agent-design-tools.md](agent-design-tools.md), checks) — with, optionally, what a good answer looked like | *Save as a test case* on any of your answers or on a run's page; or written under Tests; or `hub_skill_cases` |
| **A setup** | the skill's agent as it is, or with another brief, model, effort — or another agent altogether, given the same request (one agent against a team's coordinator) | the Tests panel's *Add a setup to compare*; `hub_skill_test`'s `variants` |
| **A trial set** | every case, k times, under each setup, scored; kept with a hash of the setup it ran against | *Run the cases*; `hub_skill_test` with `confirm: true` |

## How to find the best setup for a job

1. **Collect the failures.** Every answer that went wrong has *What went
   wrong? See the run* under it (Standard view) and *Save as a test case*
   (for those who manage agents). The exact request is kept as a case; the
   person adds what should have happened — a phrase it must mention, a limit,
   a standard a second model can judge, a reference answer for whoever reads
   the next failure. Five to ten real ones beat fifty invented ones.
2. **Run them as it is, three times each.** That is the baseline: which cases
   pass every time, which pass sometimes (the ones to worry about), which
   never pass. The verdict line reads *2 of 5 cases passed every time · 11
   of 15 trials*.
3. **Add a setup to compare.** The same cases, under a different brief
   (shorter, with an example, with the rule that keeps failing), a cheaper
   model, a lower effort, or another agent — a pattern's coordinator, to see
   whether the job needs a team at all. Up to six setups in one set. The
   panel says before running: *30 runs of the real model: 5 cases × 3 times
   × 2 setups, as you, with every write held and nothing remembered.*
4. **Read the table.** A row per case, a column per setup, each cell *n of
   k*. The best setup is starred: most cases passed every time, then most
   trials passed, then cheapest. Expert sees cost and mean time per setup.
   Every trial that did not pass is listed with why and a link to its run,
   where the transcript is.
5. **Change the brief, run again.** The set keeps the setup's hash; when the
   brief, model, template or checks change, the panel says so on the old
   set, and the next set is the comparison: was 9 of 10, now 7 of 10.

The method in one sentence: cases from real failures, checks a reader could
apply, k of three, and never trust a setup that passed once.

## What a trial is, exactly

A trial is a **real run** of the skill's agent as the person who started the
set, through the same path as any run (`lib/agentRuns.ts`): it retrieves as
them, reaches the tools the agent has, loads the agent's memory, and its
transcript is on its run page. What makes it a trial is what it may not do:

| | A real run | A trial |
|---|---|---|
| Writes to a connected system | held for approval, unless the entry allows them | held whatever the entry says, and **rejected** when the trial ends, with the note "A test run" — after the `writes` check counted them |
| Memory | written, in the run's scope | **refused**: "Not remembered: this is a test run" — a trial must not teach the agent anything |
| Hand-offs | fire when it finishes | do not fire: a hand-off would start a real run of the next agent |
| Asks | the asked agent runs as the same person | the same, as a trial too: it keeps nothing either |
| Where it shows | the agent's run list, *Your answers* | the run list (marked by its set), the Tests panel; **not** *Your answers* |
| Checks | the skill's | the skill's **and the case's** |

A trial passes when its run finished and every check passed. A check that
could not be judged is not a pass. A run that fails, or outlives twenty
minutes, is counted as failed and the set goes on.

## Spend

Every trial is a model run. A set says how many before it makes one, both on
the panel and from `hub_skill_test` (which runs nothing without `confirm:
true`), and refuses more than `HUB_TRIAL_MAX_RUNS` (default 60) outright: a
typo in k must not cost a month's budget. Starting a set needs `agent:manage`,
as does writing a case; saving a case from your own answer needs only
`agent:run` — it is your failure to report.

## Views

Simple sees none of this: no Tests button, no link to a run. Standard sees
the cases, the brief as a setup to compare, pass counts and the verdict.
Model and effort choices, another agent by slug, costs, times, run ids and
the setup hash are Expert's ([docs/views.md](views.md)).

## Data

`skill_cases` holds what a person asked a skill — a case saved from a run is
the run's prompt — on purpose and for keeps: it is a test fixture, the
skill's, and retention does not sweep it. Erasing a person
(`erasePerson`, [docs/retention.md](retention.md)) removes the trial sets
they started and takes their name off the cases they wrote; the cases stay.
`skill_trials.results` holds check details, costs and run ids, never an
answer. Trial runs are ordinary `agent_sessions` rows with `trial_id` set,
and retention treats them as any run.

## Verification

| Script | What it proves |
|---|---|
| `verify:skill-tests` (web) | a plan says how many runs before any run and refuses a set over the ceiling, an unknown model, an off agent, a skill with no cases; a set runs every case k times under each setup as the person, records each trial under the set, scores pass rate and passed-every-time per case and setup and names the best; a case's checks are judged on top of the skill's; a trial's writes are held whatever the entry allows and rejected when it ends, its memory writes refused, no hand-off fires, and it is left out of Your answers; a case from a run keeps the exact prompt and runs with it; the setup hash changes with the brief; a failed trial is counted, not fatal; erasing a person removes their sets and keeps the cases; the pure scorer |
| `verify:design-tools` (web) | `hub_skill_cases` lists, adds and removes; `hub_skill_test` without confirm runs nothing and says what it would; the ceiling and an unknown model are refused in words |
| `verify:views` (web) | Simple has no Tests and no run link; Standard has the run link; only someone who may manage sees Tests and Save as a test case |

None of them spends: a stand-in Messages API answers well on the agent's
model and badly every second time on the cheaper one, so the comparison has
a winner to find.

## Deliberately not done

- **No scheduled test runs.** A set runs when a person starts it. A nightly
  set is a schedule away ([docs/schedules.md](schedules.md)) once someone
  wants one, and it would spend every night.
- **No automatic promotion.** The panel says which setup is best; a person
  changes the agent. A champion should read the failures first.
- **No cross-skill comparison.** A set belongs to one skill. Comparing a
  single agent with a team is done by naming the team's coordinator as a
  setup, given the same request.
