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
- **Not reachable from Claude Code.** `/api/mcp` exposes the knowledge base but
  not agents or their memory. Memory over that endpoint has to bind the agent to
  the *token*, for the same reason the stdio server binds it to the environment:
  an agent id in a tool argument is a cross-agent read.
