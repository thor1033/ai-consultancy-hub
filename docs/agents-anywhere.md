# Agents anywhere

An agent you build in the hub is usable from Claude Code, VS Code Copilot,
Cursor, ChatGPT Enterprise or M365 Copilot — with no per-client work. Build it
once; it appears in everyone's tool list.

## The org chart

We explain the hub to clients as a business, because the hard part for a
non-technical buyer is telling these apart:

| Hub | Business |
|---|---|
| **Agent** | an employee |
| **Skill** | that employee's expertise — something they know how to do |
| **Tool** | what they operate (an MCP server: PM-tool, a CRM) |
| **Knowledge** | the company's files |
| Orchestrator | a manager — *not built yet* |

The test for a client is: *is this a person, something that person knows, or a
thing they pick up?* If a workflow is hard to place on the org chart, the
abstraction is wrong — not the client.

## What a client sees

| Tool | What it is |
|---|---|
| `hub_agent_<slug>` | one per agent — ask that employee to do something |
| `hub_skill_<slug>` | one per skill — a named task, with real arguments |
| `hub_list_agents` / `hub_list_skills` | what exists, and what each takes |
| `hub_run_agent` | run any agent by slug, for scripting |
| `hub_run_status` | collect a run that outlived its tool call |

Tools are generated per request from the database, which is what makes "build it
in the hub, use it anywhere" true rather than aspirational: creating an agent is
all it takes. Clients cache tool lists, so something new appears on the next
reconnect.

Registration is by construction, as everywhere else in the hub: a principal who
may not `agent:run` is offered none of these, rather than tools that always
error. A disabled agent, or a disabled skill, disappears from every client at
once — and disabling an agent withdraws its skills too, because expertise
cannot outlive the employee who has it.

## Skills are the point

`hub_agent_delivery_lead({ task })` still requires the caller to know what to
ask for. A skill is the task itself:

```
hub_skill_weekly_client_deck({ client: "Aurora", week: "W38" })
```

The skill is a prompt with blanks (`{{client}}`, `{{week}}`) plus the
declaration of what fills them. That declaration becomes the tool's input
schema, so the calling model is *told* what the workflow needs — which
arguments exist, which are required, which are a fixed set of options — instead
of guessing at a sentence.

This is skillification in the shape that fits. A saved context window is a
transcript nobody reruns; a named parameterised run is something a colleague
invokes from their own editor without being told how.

Define skills on the agent's page in the hub. The editor catches the mistake
everyone makes — a `{{placeholder}}` with no argument behind it — because the
failure it causes is a literal `{{client}}` in something a client reads, which
surfaces a long way from its cause.

## Large arguments

A tool call is written out by the *calling* model, token by token, inside one
of its turns. That is a limit no hub-side setting can lift: a 45-minute Teams
transcript is ~90KB, and the orchestrating model cannot reliably emit that as a
single argument — the call errors, or the transcript arrives with its tail
missing and nobody notices until the last decision of the meeting is not in the
change set.

So there is one rule, the same for every string argument of every tool, and the
server states it in its instructions and on each skill:

> Any string argument longer than 20,000 characters is split into **equal
> parts of at most 20,000 characters — however many that takes** — each sent
> with `hub_put_text` under one handle, and the handle passed in place of the
> value.

```
hub_put_text({ part: 1, parts: 5, text: "<chars 1–20000>" })
  → { handle: "P4_klX8", received: 1, parts: 5, complete: false, next: "Send parts 2, 3, 4, 5 …" }
hub_put_text({ handle: "P4_klX8", part: 2, parts: 5, text: "…" })      // any order
…
  → { handle: "P4_klX8", received: 5, parts: 5, complete: true, chars: 91322, use: "@text:P4_klX8" }

hub_skill_meeting_to_pm({ transcript: "@text:P4_klX8", meetingDate: "2026-10-03" })
```

The hub substitutes the whole text before the skill's template is filled, so a
skill is written exactly as if the value had arrived inline. Equal parts rather
than "split in two" is deliberate: halving only moves the failure to the next
longer input, while a fixed part size never fails on length again.

What the hub refuses, rather than quietly accepting: a part over the limit (it
is not trimmed), a handle with a part missing (the error names the part), and a
handle that belongs to someone else — a handle is a bearer of its text, scoped
to the principal like a run id. Uploads are kept for an hour, in the hub
process; the hub runs as one Fly machine, which is what makes that enough.

## Runs take minutes; tool calls do not

An agent doing real multi-turn work runs for minutes. Every MCP client's
tool-call timeout is far shorter (Claude Code defaults to 60s). A
synchronous-only design would fail exactly the runs worth having, while still
spending the tokens.

So a run races a deadline (`DEFAULT_DEADLINE_MS`, 45s):

- **Finishes in time** → the caller gets the answer directly.
- **Does not** → the caller gets a `runId` and a explicit instruction to poll
  `hub_run_status`. The run keeps going.

The work survives the response because the hub is a long-running container on
Fly, not a serverless function — nothing is torn down when the HTTP response
goes out. On a serverless host this design would need a queue instead.

A run is a row in `agent_sessions` with a lifecycle: `running` → `succeeded` or
`failed`. A failure stores its reason, because whoever is polling is doing it
from an editor and cannot read the container log.

**A run id is scoped to the principal who started it.** It is a bearer of the
whole output of an agent working over company knowledge, so an unscoped uuid
would undo knowledge access one run at a time.

## Whose access

An agent retrieves **as the caller**, never with a reach of its own. Its
`knowledge_collection` is curation — which drawer it works out of — and the
caller's grants are permission; the two are ANDed. Otherwise an agent scoped to
a restricted collection would be the way for anyone to read it, with the agent
as the deputy.

See [knowledge-access.md](knowledge-access.md).

## Verifying

```
npm run verify:agent-tools -w web
```

No API key. 55 checks: tool generation per principal, schema generation from
parameters (including enums, numbers, and which arguments are required),
template filling and every way it can be given bad arguments, the run
lifecycle, run-id scoping, and that disabling an agent or skill withdraws it
everywhere.

Not covered, because it needs `ANTHROPIC_API_KEY` and real spend: an actual
agent turn end to end, and the deadline firing mid-flight. Everything either
side of the model call is proven.

## Still open

- **The nested-credential seam.** An agent calling PM-tool uses the *hub's*
  token, so the caller inherits the hub's reach on other MCP servers. Knowledge
  is filtered; tools are not. Fix before a second client shares a deployment.
- **No Orchestrator.** There is no manager layer — no agent that delegates to
  other agents. The metaphor predicts one, which is a good sign the metaphor is
  doing work.
