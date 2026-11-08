# The Market Scout

Status: **built**, seeded (`seed:market-scout`). Two agents: the **Market
Scout** and the **Market Reviewer**, in Strategy.

## The question

Who else sells what we sell, what do they say about themselves, what do they
charge — and is what we say about ourselves actually different? Asked once,
it is a research project; asked every month, it is a job. The Scout is the
agent that holds the job, and the Reviewer is why its answers can be trusted.

## The decision

A standing agent with the web ([docs/web.md](web.md)), a brief that forbids
inventing, four skills that each produce one kind of answer, checks on every
answer, and a second agent that opens every page the first one cites before
anything is delivered. The firm's positioning is an input, not something the
Scout knows: it is told, remembers it as a proposal, and compares against it.

| | Market Scout | Market Reviewer |
|---|---|---|
| Has | the web (12 searches, 12 fetches a run), the Reviewer to ask, memory, the `market` collection | web fetch only (no search), no memory |
| Does | searches, reads, compares, writes with sources | opens every cited page and says which companies and claims the pages do not support |
| Model | the deployment's default | the cheaper one |
| Never | invents a company, price or quote; reads our own site as evidence of competitors; advises on strategy | adds research, suggests a competitor, rewrites a line |

## The four skills

| Skill | Ask it | You get |
|---|---|---|
| **Map the market** | our positioning in a few sentences, a region, competitors we know | four rings — direct, adjacent, substitutes, the incumbents' suites — one line per company with its URL, what it does, who buys it, price if public, how we differ; then *What we could not find*, and where we are plainly different and where we are not |
| **Profile a competitor** | a name or a site | what they sell, who buys, pricing as published and dated, how they describe themselves (quoted), recent moves (dated), strengths and weaknesses against us, where we differ and where we do not, every source |
| **Check a claim of ours** | one thing we say, e.g. "every write an agent makes waits for a person" | who else claims it in their words, and a verdict: **DISTINCT**, **SHARED** or **TABLE STAKES**, with a wording that would hold |
| **What changed this week** | nothing; put it on a schedule | for every competitor in the register, what changed since it was last checked, dated and sourced; one line for those where nothing did |

Every skill ends by asking the Reviewer and quoting its verdict. Every skill
carries the **sourcing standard** as a check a second model judges
([docs/skill-tests.md](skill-tests.md)): every company has a URL, every claim
names its page, nothing is stated the pages do not support, "we differ" is a
comparison, every date has a source. The verdict shows under the answer.

## How to use it to differentiate

1. **Tell it who we are.** The first *Map the market* with our positioning
   as we would say it to a client. It proposes remembering the positioning;
   approve that.
2. **Read the map for what we could not find.** Those are the searches to
   run by hand, and the competitors a founder knows that the web does not.
   Add them under *known* and map again.
3. **Profile the three that matter.** Approve the register entries it
   proposes; the register is the memory the weekly watch runs from.
4. **Check our claims one by one.** Every line of the pitch that says we are
   different goes through *Check a claim*. SHARED and TABLE STAKES lines get
   the suggested wording or get cut; DISTINCT lines are the differentiation.
5. **File what should outlive the run.** A profile worth keeping goes into
   the knowledge base by hand, into the `market` collection the Scout reads
   from, so the next profile starts from it.
6. **Put the watch on a weekly schedule** ([docs/schedules.md](schedules.md)),
   as the person who will read it. Changes arrive as register updates to
   approve.
7. **Keep it honest with test cases.** When an answer names a company that
   does not exist or a price that is wrong, *Save as a test case* under it,
   add what should have happened, and run the cases before changing the
   brief ([docs/skill-tests.md](skill-tests.md)).

## What it leaves behind, and what it may not

Its answers, under *Your answers* and on the run pages with every search
and page the run made. Register memories, as proposals: because the Scout
reads the web, every memory write is held for a person
([docs/web.md](web.md)). Nothing in the knowledge base: filing is a
person's. Nothing in any outside system: it has no connection but the web,
and the web it reads, never writes.

## What this deliberately does not do

- **No pricing or strategy advice.** It says what is and where we differ;
  what to do about it is the founders'.
- **No automatic filing.** The Context Steward could propose filing a
  profile from the Scout's run; it is not wired, because a profile is
  evidence a founder should read first.
- **No seeded schedule.** A scheduled run executes as the schedule's owner,
  and that is a person's choice to make.
- **No paid data sources.** Public pages only. A market database would be a
  connection on the Connections page, when one is wanted.

## Verification

| Script | What it proves |
|---|---|
| `seeds:check` (db) | the two definitions: what each holds and may not, the briefs' rules, the four skills with the standard as a judge check, the blanks declared, the register and positioning keys |
| `verify:seeds` (db) | a release keeps what people changed on the agents' pages |
| `verify:web` (web) | the web entry reaches the run with its bounds; memory writes held; unavailable on another provider, and said |

What no script proves: whether a real search finds the real competitors.
That is what the first *Map the market* is for, read against what the
founders already know.
