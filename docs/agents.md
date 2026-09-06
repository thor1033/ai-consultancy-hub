# Standing agents

## What an agent is

An **agent** is someone you keep: a named worker with standing instructions, a
fixed set of tools, an optional knowledge scope, and a memory that survives
between conversations. It is the thing you assign work to rather than a
procedure you execute.

Agents are now the hub's only unit of work. They used to sit beside a versioned
**Skill** — a captured expert workflow you pinned, ran once, and measured
against a manual baseline. Skills were removed, along with the ROI dashboard
that scored them and the workbench that captured them, because the thing that
survived real use was the worker you come back to, not the procedure you freeze.
Nothing here is versioned, and that is the point: an agent's value is that it
changes as it learns.

```
agents                    a name, instructions, model, tools, knowledge scope
  └── agent_memories      what it has chosen to remember  (unique per agent+key)
        ↑
    memory MCP server     spawned per run with HUB_AGENT_ID
```

## Memory

Memory is an MCP server (`packages/mcp/servers/memory/server.mjs`) with four
tools: `memory_list`, `memory_search`, `memory_write`, `memory_forget`. The
agent decides what is worth keeping; nothing is captured automatically.

**Scope travels in the environment, never in a tool argument.** The server is
spawned with `HUB_AGENT_ID` and refuses to start without it. A tool argument
would mean a model that can name another agent's id can read that agent's
memory — with clients on the same hub, that is a cross-client leak, not a bug in
a demo. `memoryServerConfig(agentId)` is therefore deliberately kept out of
`BUILTIN_SERVER_NAMES` — which is otherwise empty — so `memory` cannot be
resolved by name alone, and a session with no agent simply has no memory
server.

**Memories are keyed, not appended.** Writing an existing key replaces it. An
agent told "actually, they moved the review to Wednesday" should correct itself,
not end up holding two contradictory facts that both surface at once.

**Every memory is visible and deletable** from the agent's Memory tab. An agent
that silently accumulates beliefs about a client is a liability; being able to
read and prune them is what makes it something to point at real work.

The server talks to Postgres directly rather than importing `@ai-hub/db`: it
runs as a bare `node server.mjs` child process, and that package's TypeScript
uses extensionless imports only a bundler resolves. Its four statements mirror
`packages/db/src/agents.ts` — keep the upsert-by-key semantics in step.

## A run

`runSession({ agentId, … })` attaches the agent's memory server automatically —
an agent that could be configured to forget everything is just a chat window —
and records the run in `agent_sessions` with `source: "agent"` so it is
traceable back to the agent that made it. If the agent has a
`knowledge_collection`, retrieval is scoped to it, best-effort: a missing
embedder or an empty index answers without context rather than failing the turn.

## Verification

| Command | Covers |
| --- | --- |
| `npm run verify:agents -w @ai-hub/db` | the store: CRUD, that an omitted field is left alone while an explicit null clears one, memory upsert/search/forget, and that deleting an agent takes its memories with it |
| `npm run verify:memory -w @ai-hub/mcp` | the server through the hub's own client path: the four tools, upsert-not-append, that one agent cannot read another's memories, and that it refuses to start unscoped |

Neither needs an API key; both need `DATABASE_URL` and clean up after
themselves.

## Not done yet

- **No authorization on the UI.** WorkOS AuthKit now puts a door on the pages
  and an allowlist decides who gets in, but the `/agents` server actions still
  run server-trusted: they do not resolve the signed-in user to a `Principal`,
  so the `PolicyEngine` never sees them. Anyone on the allowlist can edit any
  agent. The bearer-token API and `/api/mcp` *are* gated.
- **No tenancy.** The hub still has no `org_id` anywhere, so agents and their
  memories are per-deployment, not per-client.
- **Conversations are not persisted.** Each turn sends the running transcript
  from the client; only memory survives a reload. Every turn is recorded in
  `agent_sessions`, but there is no "resume this conversation" yet.
- **No scheduling.** The scheduler was removed with skills — it only ever fired
  skill runs — so an agent cannot be put on a cron. Bringing it back means a
  schedule kind that targets an agent, and a ticker to fire it.
- **Agent *runs* are not reachable from Claude Code.** Memory now is — see
  below — but there is still no tool that runs an agent turn remotely, and
  `POST /api/agent/run` ignores `agentId`, so a turn taken through it has no
  memory and no knowledge scope. Only `/agents/[slug]` runs a real agent.

## Memory from an outside client

`/api/mcp` offers four memory tools — `hub_memory_list`, `hub_memory_search`,
`hub_memory_write`, `hub_memory_forget` — so Claude Code can carry an agent's
memory in the terminal.

**The agent is bound to the token, never to a tool argument.** A `HUB_API_TOKENS`
entry may carry an `agentId` (an id or a slug):

```json
{"tok-lead": {"id": "lead", "roles": ["analyst"], "agentId": "delivery-lead"}}
```

This is the same rule the stdio server enforces with `HUB_AGENT_ID`, for the same
reason: an agent id a model can pass is an agent id a model can change, and with
several clients on one hub that is a cross-client read. There is deliberately no
tool that takes an agent id, so the question cannot even be asked.

Registration is by construction, so the tools are simply absent unless the
binding is real and permitted. All four of these yield a session with no memory
tools at all, rather than tools that error:

| Token | Result |
| --- | --- |
| no `agentId` | no memory tools |
| `agentId` naming an agent that does not exist | no memory tools |
| `viewer` role (lacks `agent:run`) | no memory tools |
| `agentId` that is not a string | dropped at parse; no memory tools |

`npm run verify:hub-memory -w web` covers all of it (19 checks, no API key —
needs `DATABASE_URL`). It drives the real server through a real MCP client over
an in-memory transport, so a pass means a Claude Code session sees the same
thing.
