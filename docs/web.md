# The web, as a tool an agent may be given

Status: **built**. An entry `web` on an agent, under *What it may use*.

## The idea

Most of what the hub's agents know comes from inside the firm: the knowledge
base, memory, the systems an agent is connected to. Some jobs need the
outside — what a competitor charges, what a regulation says this month, what
a supplier announced — and until now an agent asked about those answered from
training data, as if it had looked.

`web` gives an agent **web search** and **web fetch**. Both are the Claude
API's own server tools: the model asks for a search or a page, Anthropic runs
it and hands the result back inside the same request, with citations.
Nothing runs in the hub, no new vendor sees a query, and no key beyond the
deployment's model key is needed.

## What an entry says

| Entry | Means |
|---|---|
| `{"name":"web"}` | search and read, eight of each per run |
| `{"name":"web","searches":12,"fetches":12}` | up to twelve of each |
| `{"name":"web","only":["competitor.com","g2.com"]}` | only these sites and their subdomains |
| `{"name":"web","never":["example.org"]}` | never these |
| `{"name":"web","search":false}` | read pages it is given URLs for, search for none |

On the agent's page: tick *The web*, then the sites it may read (one per
line) and the searches per run. `hub_agent_create` and `hub_agent_update`
take `web` in `tools` like any server; the bounds are set on the page. The
design save keeps only what the run reads (sites as hostnames, counts from
1 to 50, `only` or `never` but not both) and refuses the rest in words.

## What bounds it

- **Searches are billed** beyond tokens (USD 10 per 1,000 on the Claude API,
  `WEB_SEARCH_USD`), fetches are tokens only. The run's cost includes them;
  the run page names `web_search` and `web_fetch` among the tools used and
  the timeline counts searches and fetches per turn.
- **The provider.** Web search and fetch exist on the Anthropic provider
  (`packages/agent/src/client.ts`). On Bedrock or Vertex the hub drops the
  entry from the run and says so, to the model and in the answer, the way it
  does for any server this deployment has not got
  ([docs/agents.md](agents.md), "A server the agent names"). Fail closed: an
  agent that cannot look does not pretend it did.
- **The model.** Opus 4.8 and Sonnet 4.6 get search and fetch with dynamic
  filtering (`web_search_20260209`, `web_fetch_20260209`). Haiku 4.5 gets
  the basic search only and reads the snippets.
- **Memory.** A run that may read the web has read outside content from its
  first turn for the gate's purposes: a page can carry instructions, and the
  hub cannot see the reads happen (they are inside the API). So its memory
  writes are held for a person throughout, and what it remembers is kept for
  its person only until a person approves, as after any outside read
  ([docs/memory-scopes.md](memory-scopes.md),
  [docs/data-protection-review.md](data-protection-review.md) F10).
- **Rounds.** The API's own loop over server tools stops after ten steps and
  asks to be resumed (`pause_turn`); the hub resumes it with nothing added,
  and each resume counts toward the run's tool rounds, so a run that searches
  without end still hits the cap.

## What it is not

Not a browser, and not a way to log in anywhere: a fetch reads a public page
the run has a URL for. Not a connection on the Connections page: there is no
token and nothing to seal. Not retrieval: what a run reads on the web is in
that run and nowhere else until a person files it or approves a memory.

## Verification

| Script | What it proves |
|---|---|
| `verify:loop` (agent) | with the web, the request carries the API's search and fetch tools with the bounds asked for (counts, sites cleaned to hostnames, one list not both); a paused turn is resumed as is; searches are counted per turn and for the run, named as tools used, and charged; an older model gets the basic search only |
| `verify:web` (web) | through the run path: a web entry on the agent reaches the request with its bounds; its memory writes are held and the model told; on another provider the web is dropped and said, to the model and in the answer; the design save keeps hostnames and counts and refuses junk |
