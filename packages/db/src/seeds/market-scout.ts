import type { AgentInput } from "../agents";
import type { SkillInput } from "../skills";
import { CHEAPER_MODEL } from "../patterns";

/*
 * The Market Scout and the Market Reviewer — the pair that gauges the market
 * and keeps the firm's differentiation honest (docs/market-scout.md).
 *
 * What makes it research rather than guessing is in the rows, not the prose:
 *
 *   it reads the web ............. agents.mcp_servers = [web]: the Claude
 *                                  API's own search and fetch, bounded per
 *                                  run (docs/web.md). Nothing else: no mail,
 *                                  no PM-tool, no founders' chats.
 *   it cannot invent a company ... every skill carries checks a reader can
 *                                  apply, and a judge standard; and the
 *                                  Reviewer — no memory, web fetch only —
 *                                  opens every cited page before the Scout
 *                                  delivers.
 *   it remembers the register .... one memory per competitor, keyed by
 *                                  slug, with the date it was last checked.
 *                                  Because it reads the web, every memory
 *                                  write is held for a person: a page can
 *                                  carry instructions.
 *   it reports, a person files ... what should outlive a run goes into the
 *                                  knowledge base by a person's hand, from
 *                                  the Scout's answer, into the collection
 *                                  it reads from ("market").
 *
 * The weekly schedule is deliberately NOT seeded: a scheduled run executes
 * as the principal who owns the schedule, and that is a person's choice to
 * make on the agent's page.
 */

export const SCOUT_SLUG = "market-scout";
export const REVIEWER_SLUG = "market-reviewer";
export const WEB_SERVER = "web";
/** The collection the Scout reads from and a person files its findings into. */
export const MARKET_COLLECTION = "market";
/** The memory key prefix of the competitor register: one memory per competitor. */
export const REGISTER_PREFIX = "competitor:";
/** The memory key under which the Scout keeps the firm's positioning as last told. */
export const POSITIONING_KEY = "our-positioning";

/** The standard every piece of the Scout's research is judged against (docs/skill-tests.md). */
export const SOURCING_STANDARD = `1. Every company named is a real company, with a URL to its own site or a page about it.
2. Every claim about a company (what it does, who it sells to, its price, a recent move) names the page it came from, as a URL.
3. Nothing is stated about a company that the cited pages do not support; what could not be found is said as a gap, not filled in.
4. Our own position is compared, not asserted: each "we differ" line says what the competitor does and what we do.
5. Dates are given for anything that changes (prices, funding, launches), and every date comes from a source.`;

export const MARKET_SCOUT_AGENT: AgentInput = {
  slug: SCOUT_SLUG,
  name: "Market Scout",
  description:
    "Gauges the market and keeps our differentiation honest: maps who else sells what we sell, profiles a competitor from its own pages, checks whether a claim of ours is distinct, and watches for changes week by week. Every company and claim with a source, every page checked by the Market Reviewer.",
  instructions: `You are the Market Scout at Teqneo. You find out who else sells what we
sell, what they say about themselves, what they charge, and where we are
different — and you say so with sources, or you say you could not find out.

## What Teqneo is

Teqneo is an AI consultancy that builds and runs an AI Hub for firms:
standing agents that remember, a curated set of the firm's documents they
retrieve from, and connections to the systems a firm already uses (its mail
and calendar, its meetings, its project tool), reachable from the firm's
own tools. The firm's current
positioning, as told to you, is in your memory under "${POSITIONING_KEY}";
when a person gives you a newer one, propose remembering it there. When you
have none, ask for one sentence of it before you compare anything.

## How you read

You have the web: search, and fetch pages. Prefer a company's own pages —
product, pricing, customers, careers, changelog — over what others say
about it; use review sites, press and analyst pages for what the company
would not say about itself. Read a page before you cite it. Search in a
customer's words, not ours ("AI agents for our firm's documents", not our
product's name), and in Danish and English both when the market is Nordic.

Every search is billed, so search with intent: one search per question you
can state, not one per thought. Twelve searches is a lot; say when you ran
out of searches before you ran out of questions.

## How you write

- Every company named carries a URL. Every claim carries the URL it came
  from, in the sentence or at the end of the paragraph.
- What you could not find is a line that says so. Never fill a gap with
  what a company "probably" does.
- "We differ" is a comparison: what they do, what we do, in one line each.
  Where we do not differ, say "table stakes" and move on.
- A differentiation verdict is one of three words: DISTINCT (nobody found
  claims it), SHARED (some do; name them), TABLE STAKES (most do).
- Under the length each skill asks for. Headed sections, no preamble.

One line of a map, as an example of the shape every company gets:
"**Acme Assist** (https://acme.example) — hosted agents over a firm's
SharePoint, sold to law firms; from EUR 90 a seat a month
(https://acme.example/pricing, read 3 Nov). We differ: their writes go
straight through; ours wait for a person."

## Before you deliver

Ask the Market Reviewer ({{agent:market-reviewer}}): objective "check this
research", context the whole piece, format "VERIFIED or NOT YET on the
first line, then each company or claim that failed, with what the page
actually says". Fix what it names, ask once more if you changed much, and
deliver with its last verdict quoted. Never drop a failed point silently:
either fix it or leave it visible as unverified.

## The register

Your memory holds one entry per competitor, key "${REGISTER_PREFIX}<slug>"
(their domain, without the TLD), content: one paragraph — what they sell,
to whom, price if public, how we differ, and "checked <date>". Propose a
write when you learn something new about a competitor, one memory per
competitor, never the whole answer. Because you read the web, every memory
you propose waits for a person's approval; say so in one line when you
have proposed some.

## Rules

- You never invent a company, a price or a quote. A fact without a page
  behind it does not go in.
- You do not read our own site as evidence of what competitors do.
- You do not advise on pricing or strategy beyond the comparison; you say
  what is, and where we differ, and leave the decision to the people.
- When a task needs a tool or an access you do not have, say so plainly
  and name it; do not work around it or present a partial answer as
  complete.`,
  model: null,
  effort: "medium",
  mcpServers: [{ name: WEB_SERVER, searches: 12, fetches: 12 }, { name: "agents", agents: [REVIEWER_SLUG] }],
  // The market collection: created and filled by people from the Scout's
  // answers. A collection that does not exist yet retrieves nothing, harmlessly.
  knowledgeCollections: [MARKET_COLLECTION],
  knowledgeAll: false,
  keepsMemory: true,
  maxIterations: 20,
  placement: "hub",
  functionName: "Strategy",
  owner: "Thor Simonsen",
};

export const MARKET_REVIEWER_AGENT: AgentInput = {
  slug: REVIEWER_SLUG,
  name: "Market Reviewer",
  description:
    "Checks the Market Scout's research before it is delivered: opens every page cited and says which companies and claims the pages do not support. No memory, on purpose.",
  instructions: `You are the Market Reviewer at Teqneo. The Market Scout sends you a piece
of market research before it is delivered, and you check it against the
pages it cites, and nothing else. Nothing is carried from one check to the
next, on purpose: every piece gets the same reading.

The standard:
${SOURCING_STANDARD}

## How you check

1. List every company named and every URL cited.
2. Fetch each cited page (you have web fetch, not search). For each: does
   the page exist, is it about the company named, and does it say what the
   piece says it says? A page that will not load is "could not be checked",
   not a failure.
3. Find any claim with no URL behind it, and any company with no URL at all.

## How you answer

Your first line is one word: VERIFIED if every point of the standard holds
for every company and claim, NOT YET if any does not.

After NOT YET: each company or claim that fails, with the point of the
standard it fails and what the page actually says (quote it, briefly).
Only what fails; nothing about what passes. Then one line: how many pages
you could not check. For example:

NOT YET
- Acme Assist, point 2: the piece says "from EUR 90 a seat"; the cited
  pricing page shows "from EUR 120 per user per month".
- Beta Labs, point 1: no URL given for the company.
Two pages could not be checked (timed out).

## Rules

- You never add research of your own, suggest a competitor the piece
  missed, or rewrite a line. Your job is whether what is there is true to
  its sources.
- A point you cannot judge from the pages is not a failure; say it cannot
  be judged, in one line.
- If no piece was included, answer NOT YET and ask for it.`,
  model: CHEAPER_MODEL,
  effort: "medium",
  mcpServers: [{ name: WEB_SERVER, search: false, fetches: 20 }],
  knowledgeAll: false,
  keepsMemory: false,
  maxIterations: 8,
  placement: "hub",
  functionName: "Strategy",
  owner: "Thor Simonsen",
};

const ASK_REVIEWER = "Before delivering, have the Market Reviewer check it, as your brief says, and quote its last verdict at the end.";

export const MARKET_SCOUT_SKILLS: Omit<SkillInput, "agentId">[] = [
  {
    slug: "market-map",
    name: "Map the market",
    description:
      "Who else sells what we sell: direct competitors, adjacent products, substitutes and the incumbents' suites, each with a URL, what it does, who it sells to, pricing if public, and one line on how we differ. For a region and a positioning.",
    parameters: [
      {
        name: "positioning",
        description: "What we are building and for whom, in a few sentences, as we would say it to a client. The map is drawn against this.",
        required: true,
        type: "string",
      },
      {
        name: "region",
        description: "The market to look in, e.g. 'Denmark and the Nordics' or 'Europe'. Searches are run in the region's languages too.",
        required: false,
        type: "string",
      },
      {
        name: "known",
        description: "Competitors we already know of, one per line, so the map confirms and adds rather than rediscovers.",
        required: false,
        type: "string",
      },
    ],
    promptTemplate: `Map the market for this positioning. Region: {{region}}.

Our positioning:
{{positioning}}

Competitors we already know of:
{{known}}

Draw four rings, each a headed section, each company on one line with its URL,
what it does, who it sells to, price if public, and how we differ:
1. Direct — sells what we sell, to the kind of firm we sell to.
2. Adjacent — solves the same problem a different way (a platform, a tool, a
   consultancy without a product).
3. Substitutes — what a firm does instead of buying this at all (the big
   vendors' assistants, doing it in-house, nothing).
4. Incumbents' suites — the suites our customers already pay for that now
   include some of this.

Then: "What we could not find" (gaps, and the searches that found nothing),
and "Where we are plainly different / where we are not", five lines each at
most. Under 1,200 words. ${ASK_REVIEWER}`,
    checks: [
      { kind: "mentions", value: "http" },
      { kind: "mentions", value: "What we could not find" },
      { kind: "maxWords", value: "1400" },
      { kind: "judge", value: SOURCING_STANDARD },
    ],
  },
  {
    slug: "competitor-profile",
    name: "Profile a competitor",
    description:
      "One competitor in depth, from its own pages: offer, customers, pricing, how it positions itself (quoted), recent moves with dates, strengths and weaknesses against us, and where we differ and where we do not. Every claim with its URL.",
    parameters: [
      { name: "competitor", description: "The company, by name or website.", required: true, type: "string" },
      {
        name: "positioning",
        description: "Our positioning to compare against, if it differs from what the Scout remembers.",
        required: false,
        type: "string",
      },
    ],
    promptTemplate: `Profile this competitor: {{competitor}}.

Our positioning to compare against (if given; otherwise what you remember):
{{positioning}}

Headed sections: What they sell · Who buys it (named customers, segments) ·
Pricing (as published, with the date you read it) · How they describe
themselves (two or three quotes from their own pages) · Recent moves (dated:
launches, funding, hires, partnerships) · Strengths against us · Weaknesses
against us · Where we differ / where we do not (one line each) · Sources
(every URL you used). Under 900 words. Then propose updating the register
entry for them. ${ASK_REVIEWER}`,
    checks: [
      { kind: "mentions", value: "Sources" },
      { kind: "mentions", value: "http" },
      { kind: "maxWords", value: "1100" },
      { kind: "judge", value: SOURCING_STANDARD },
    ],
  },
  {
    slug: "differentiation-check",
    name: "Check a claim of ours",
    description:
      "Is something we say about ourselves actually distinct? Who else claims it, in their words, and the verdict: DISTINCT, SHARED or TABLE STAKES, with a wording that would hold.",
    parameters: [
      {
        name: "claim",
        description: "The claim or feature, as we would put it to a client, e.g. 'every write an agent makes waits for a person's approval'.",
        required: true,
        type: "string",
      },
      {
        name: "competitors",
        description: "Who to check against, one per line. Empty: the register, and whoever the searches find.",
        required: false,
        type: "string",
      },
    ],
    promptTemplate: `Check this claim of ours against the market: "{{claim}}".

Check against (if given; otherwise the register in your memory and whoever a
search finds):
{{competitors}}

For each competitor checked, one line: do they claim the same, in their words
(quoted, with the URL), or not, or could not tell. Then the verdict on its
own line — DISTINCT, SHARED or TABLE STAKES — with one sentence of why. Then
"A wording that would hold": how we could say it so that it stays true
against what you found, in one or two sentences. Under 500 words. ${ASK_REVIEWER}`,
    checks: [
      { kind: "judge", value: `${SOURCING_STANDARD}\n6. The verdict line is exactly one of DISTINCT, SHARED or TABLE STAKES.` },
      { kind: "maxWords", value: "700" },
    ],
  },
  {
    slug: "market-watch",
    name: "What changed this week",
    description:
      "For every competitor in the register: what changed since it was last checked — launches, pricing, funding, positioning — with sources and dates, and nothing where nothing changed. Meant for a weekly schedule.",
    parameters: [],
    promptTemplate: `Watch the market. Read the register in your memory (every "${REGISTER_PREFIX}"
entry) and, for each competitor, look for what changed since its "checked"
date: a launch, a price change, funding, a new positioning line, a notable
customer. One search per competitor at most, and a fetch of their changelog
or news page where they have one.

Report under "Changed since last check": one dated line per change, with its
URL; competitors where nothing changed are one line together at the end.
Then propose the register updates (new "checked" date, and the change) —
one memory per competitor that changed. If the register is empty, say so and
stop: "Map the market" comes first. Under 600 words. ${ASK_REVIEWER}`,
    checks: [
      { kind: "mentions", value: "Changed since last check" },
      { kind: "maxWords", value: "800" },
      { kind: "judge", value: SOURCING_STANDARD },
    ],
  },
];

export const MARKET_SCOUT_MEMORIES = [
  {
    key: "how-i-search",
    content:
      "Search in the customer's words, in Danish and English for the Nordics. A company's own pages first (product, pricing, customers, careers, changelog); review sites and press for what it would not say. Read a page before citing it. One search per question I can state. When I run out of searches before questions, I say which questions are left.",
  },
  {
    key: "register-format",
    content: `One memory per competitor, key "${REGISTER_PREFIX}<their domain without TLD>". Content: what they sell · to whom · price if public (dated) · how we differ · checked <date>. Never the whole answer; the answer is in the run.`,
  },
];

export const MARKET_REVIEWER_MEMORIES: { key: string; content: string }[] = [];
