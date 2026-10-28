# The Product Owner

One definition, one agent per product we build: **Product Owner — AI Hub**
(`product-owner-hub`) and **Product Owner — Atlas (PM-tool)**
(`product-owner-atlas`). Each is a `ProductDefinition` in
`packages/db/src/seeds/product-owner.ts`; the brief, the skills and the
memories are generated from it.

## Why this agent

The hub's agents each own one thing. The Project Manager owns the plan: what is
late, who owns it, what it blocks. The Secretary owns the record: what was said,
when, by whom. The people in Claude Code own the code. Nothing owned the
product — what it is for, what has been decided and why, whether a request
belongs in it — so that answer lived in two founders' heads and was given
differently on different days.

The test the hub's own docs set for a new agent is whether it is a person,
something a person knows, or a thing they pick up
([agents-anywhere.md](agents-anywhere.md)). A product owner is a person. The
second test, from how the first four agents have gone, is whether there is a
live source behind it and a recurring question in front of it. The source is
the repository and the board; the question is "does this fit?", asked while
building.

## What it owns, and what it does not

| | Owner | Source of truth |
|---|---|---|
| The product: purpose, principles, decisions, what next | **Product Owner** | the design record (docs, indexed), the repository (live), the board (read) |
| The plan: late, owners, milestones | Project Manager | the PM-tool board, read + write (gated) |
| The record: what was said, when | Secretary | Teams transcripts, mail, calendar, filed notes |
| The code | the founders, in Claude Code | the repository |

It **changes nothing**. Every server it holds is read-only by construction —
GitHub through the `/readonly` endpoint, the PM-tool through the read-scoped
`pm-tool-read` credential — so "the product owner never writes" is a
property of its credentials, not a sentence in its brief. Asked to change
something, it says who does and hands over what they need.

## What it knows, and how it keeps it apart

The brief tells it three places to look and what each is the truth about:

- **The design record** — `docs/`, README and CLAUDE.md, indexed into the
  `hub-product` collection by the `github:hub` source
  ([github.md](github.md)) at a named commit. The truth about *why*. A
  passage is a snapshot, and the commit it names says how old.
- **The repository, live** — through the `github` server. The truth about
  *what is so now*: a file as it stands, what merged since a date, what is
  open. When a question turns on current behaviour it reads the file.
- **The board** — through `pm-tool-read`. The truth about *the plan*. It
  starts with `pm_project_status` and reads the board to place the product in
  the plan, never to run the plan.

Plus the `meetings` collection, because decisions about the product are made in
meetings before they reach a doc.

It judges **against principles, by name**. The hub's are in
`packages/db/src/seeds/product-owner.ts` and in the agent's memory; the first
— *the hub stays generic* — decides most of the hard cases, and is the
founders' own rule: a change that serves one agent's job belongs in that agent,
not in the hub.

## The skills

| Skill | Takes | Gives |
|---|---|---|
| `hub-product-overview` | `audience` (founders / client / new-colleague), `focus` | What it is for, what it does today, what is in flight, what is next on the board, open questions — for that reader |
| `hub-does-this-fit` | `request`, `context` | One of four verdicts — already exists, fits, fits with changes, does not belong — by principle, with what it would take and what to ask |
| `hub-release-notes` | `since`, `audience` | What merged since the date, grouped by what it means to a person using it, every entry linked, with what was deliberately left out |
| `hub-backlog-triage` | `scope` | Open issues, open pull requests and the product's board tasks sorted into done / duplicate / undecided / against a principle / stale / ready, the ready ones ordered, and who makes each change |

From Claude Code, with the agent placed in both places, these are
`/hub-hub-product-overview audience=founders` and so on, run by the
`hub-product-owner-hub` sub-agent; from any MCP client they are
`hub_skill_hub_product_overview` and friends. Each is a prompt with blanks
and a declaration of what fills them; the seed refuses to provision a template
with an undeclared `{{placeholder}}`.

## Provisioning

**In production this happens on every deploy**: the release command applies
this agent with the rules in `packages/db/src/seeds/apply.ts`, keeping what was
changed on its page since the last release ([deploy.md](deploy.md)). The
commands below are for a laptop, and apply the same rules.

```bash
node packages/db/seed-product-owner.mjs --product hub --check                      # no DB
node --env-file=apps/web/.env.local packages/db/seed-product-owner.mjs --product hub
node --env-file=apps/web/.env.local packages/db/seed-product-owner.mjs --product hub --skills-only
```

Idempotent: the agent by slug, each skill by slug, each memory by key. The full
seed rewrites the agent row from the definition, which is right for a first
install and wrong for a deployment where someone has since changed its placement
or scope in `/agents`; `--skills-only` refreshes the skills and leaves the rest.

The checks run first and refuse to provision on failure. The ones that matter:
it holds exactly `github` and `pm-tool-read` and never `pm-tool`; its knowledge
is its own collection and `meetings`, nothing wider; every principle is in the
brief so a judgement can name it; no memory stores an id or a list a tool
returns; every skill names the read tools and none names a write.

After provisioning it warns, without failing, when the environment it ran in
does not declare the servers or the `github:hub` source — production's database
is provisioned from a laptop whose env is not Fly's, so the absence proves
nothing about the deployment. Then on the deployment:

1. the `github` entry, `GITHUB_TOKEN` and `HUB_GITHUB_SOURCES` are set
   ([github.md](github.md));
2. `/knowledge → Sources → GitHub — thor1033/ai-consultancy-hub → Sync now`;
3. ask the agent for the overview, audience founders. If it cites commits and
   pull request numbers, the three sources are connected.

## The second product: Atlas

`ATLAS_PRODUCT` is the same shape with different facts: repository
`thor1033/pm-tool`, default branch `main`, the paths to index (`README.md`,
`AGENTS.md`, `PARITY-NOTES.md` — the last is Atlas's decision log, and the
most useful of the three), collection `atlas-product`, the `PM tool` track on
the board, and eight principles drawn from Atlas's own README and notes:
one workspace per engagement; tenant isolation explicit in the query;
Track/Task vocabulary fixed; the MCP endpoint as a product surface; sign in
once; parity before novelty; not the Next.js you know; prose indexed, board
live. Its skills are `atlas-product-overview`, `atlas-does-this-fit`,
`atlas-release-notes`, `atlas-backlog-triage`.

Provision with `--product atlas`, add the `atlas` entry to
`HUB_GITHUB_SOURCES` ([github.md](github.md)), sync it from `/knowledge`.

A third product is a third definition. The principles are the part worth
writing carefully, because they are what the owner judges by; everything else
is facts a tool could almost look up.

## Deliberately not done

- **A software developer agent.** In Claude Code, Claude Code is the
  developer, with the repository, the tests and the build in front of it. A
  hub agent called "developer" would have none of those. The part of that role
  worth keeping standing — the architecture and the standards — is in the
  product owner's principles; split it into a tech lead when it has its own
  questions.
- **Writing to the board.** The PM owns it. The product owner's triage ends
  with a list of changes and who makes each.
- **Automatic sync of the design record.** Manual from `/knowledge`; the agent
  is told its knowledge is a snapshot.
- **An orchestrator.** Nothing delegates to the product owner yet; it is
  asked, by a person or by another client. The metaphor predicts a manager
  layer; it is a hub feature, and not needed at four agents.
