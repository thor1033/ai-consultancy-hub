# Local agents

An agent can live on the hub, in Claude Code, or both. **Where it runs** is a
setting on the agent's page (Settings → Where it runs), and only an admin can
change it.

| Placement | The hub runs it | Synced into Claude Code |
|---|---|---|
| **Hub** (default) | yes: `/agents` console, `hub_agent_<slug>` tools, schedules | no |
| **Local** | no: the console, its MCP tools and its schedules stop | yes, as a sub-agent with its skills |
| **Both** | yes | yes |

Every existing agent is `hub`, so nothing changes until someone switches one.

## What the two placements share, and what they don't

Running an agent "on the hub" means the hub's runtime calls the model with the
hub's Anthropic key. Running it "locally" means the model is the Claude Code
session it was synced into: that session's model does the thinking, and every
step is visible there.

What does **not** move is anything the hub enforces. A local agent's tools,
memory and knowledge are reached through one endpoint per agent,
`/api/mcp/agents/<slug>`, which checks them on every call:

- **Tools.** The agent's configured servers (PM-tool, `microsoft365`, …) are
  dialled by the hub with the hub's credential and proxied through. The
  PM-tool token never leaves the hub, so "the secretary cannot write" is still a
  property of the read-only token it holds rather than of a prompt someone can
  edit (see [secretary-agent.md](secretary-agent.md)).
- **Memory.** The agent's own, and only its own. The id is closed over by the
  server; no tool takes an agent id ([agents.md](agents.md#memory)).
- **Knowledge.** Retrieved as the *caller*, narrowed to the agent's collection,
  exactly as for a hub run ([knowledge-access.md](knowledge-access.md)).

The synced sub-agent file holds instructions and that URL, never a credential.
Editing it buys nothing a token would not already allow, and the next sync
overwrites it anyway.

## Who may reach a local agent

The same people who may run it on the hub: a principal with `agent:run`. A
credential **bound** to an agent (`agentId` on a `hub_sk_…` credential, or on
the person) reaches that agent only, both in the export and at the endpoint, so a
token handed to one sub-agent is not a key to the others. A viewer gets nothing.

**Whose identity a local agent acts with.** When the connection to
`/api/mcp/agents/<slug>` carries a person's OAuth token, the agent's PM-tool
calls are made as that person, with writes kept out through a read-only entry
([auth.md](auth.md), "Signing in once"). The files the sync writes today
connect with `HUB_TOKEN`, a credential, so synced sub-agents act as the hub's
machine identity until the sub-agents share the session's own signed-in hub
connection.

## Syncing into Claude Code

`.claude/settings.json` runs `scripts/sync-hub-agents.mjs` on `SessionStart`. It:

1. fetches `GET /api/agents/export`, which returns the agents placed `local` or
   `both`, already rendered as Claude Code files;
2. writes `.claude/agents/hub-<slug>.md` and `.claude/skills/hub-<skill>/SKILL.md`;
3. deletes files it wrote last time that the hub no longer returns (an agent
   moved back to `hub`, disabled or deleted);
4. tells Claude Code to reload skills, and names the synced sub-agents in the
   session's context.

It only ever writes or deletes `hub-`-prefixed files listed in its own manifest
(`.claude/.hub-sync.json`), ignores any path the hub returns outside those two
shapes, and never fails the session: an unreachable hub leaves the last synced
files in place and says so on stderr. The generated files are gitignored — the
hub is the source of truth.

Configuration, from the environment:

| Variable | |
|---|---|
| `HUB_URL` | The hub's origin. Default `https://hub.teqneo.co`. |
| `HUB_TOKEN` | A `hub_sk_…` credential from `/admin`, used for the export and by each sub-agent's MCP connection. Not needed where a proxy injects the hub's credential (the Claude Code cloud environment does). |

Run it by hand with `node scripts/sync-hub-agents.mjs`. With `--user` it writes to
`~/.claude` instead, so the agents follow you into every project — that is what
[the one-command setup](claude-code-setup.md) installs for a colleague.

### What a synced agent looks like

The agent's page shows the exact files under **What Claude Code receives**. In
short:

- **Sub-agent** `hub-<slug>`: the agent's instructions, its model (or
  `inherit`), `maxTurns` from its tool-use rounds, and one inline MCP server —
  its own endpoint — connected only while the sub-agent runs, so the main
  session never sees its tools.
- **Skill** `hub-<skill>`: the skill's prompt template and parameters, run with
  `context: fork` inside the owning sub-agent, so it executes as that agent the
  way the hub would have run it.

## Activity

The hub cannot see a local agent's model, so it records what it can: one row per
tool call through the endpoint (`agent_local_calls`), successes and refusals
alike. The agent's page shows the last 30 days. These are deliberately **not**
rows in `agent_sessions`: a row there claims a run the hub performed and priced,
and the ROI numbers would count it as one.

## Verifying

```
npm run verify:local-agents -w web
```

55 checks, no API key, needs `DATABASE_URL`. It drives the real endpoint, the
real export route with real credentials, a real remote MCP server standing in
for the PM-tool, and the real sync script against a fake hub — covering who is
refused, that proxied calls carry the hub's credential, memory isolation between
agents, that the hub stops running local agents (tools, skills, schedules), and
that the sync script never writes outside `.claude/` or over a hand-made file.

## Not done yet

- **The model's side is not verified.** That Claude Code picks up the files and
  delegates to the sub-agent needs a real session; the checks above stop at the
  files and the endpoint.
- **Per-call connections.** Each proxied tool call dials its upstream server
  afresh (tool *lists* are cached for five minutes). Fine for the PM-tool over
  HTTP; heavier for a stdio server like `microsoft365`, which is spawned per call.
- **No approval step for what a local agent remembers.** Local agents write
  memory exactly as hub agents do. The governed review queue (the Context page
  mock-up) would apply to both.
