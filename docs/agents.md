# Standing agents

## What an agent is, and why it is not a Skill

A **Skill** is a captured expert workflow. It is versioned, because it is the IP
the consultancy sells: you pin the process, you run it, it ends, and the run is
measured against a manual baseline for ROI.

An **agent** is the other half. It is someone you keep — a named worker with
standing instructions, a fixed set of tools, an optional knowledge scope, and a
memory that survives between conversations. It is the thing a client assigns
work to rather than a procedure they execute.

Making one a variant of the other was rejected: versioning is the point of a
skill and the opposite of the point of an agent, whose whole value is that it
changes as it learns. They share the run machinery (`runSession`) and nothing
else.

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
`BUILTIN_SERVER_NAMES`: `memory` cannot be resolved by name alone, so a
workbench session with no agent simply has no memory server.

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
and records the run with `source: "agent"` so it is traceable back to the agent
that made it. If the agent has a `knowledge_collection`, retrieval is scoped to
it, best-effort: a missing embedder or an empty index answers without context
rather than failing the turn.

## Verification

| Command | Covers |
| --- | --- |
| `npm run verify:agents -w @ai-hub/db` | the store: CRUD, that an omitted field is left alone while an explicit null clears one, memory upsert/search/forget, and that deleting an agent takes its memories with it |
| `npm run verify:memory -w @ai-hub/mcp` | the server through the hub's own client path: the four tools, upsert-not-append, that one agent cannot read another's memories, and that it refuses to start unscoped |

Neither needs an API key; both need `DATABASE_URL` and clean up after
themselves.

## Not done yet

- **No authorization.** The `/agents` actions run server-trusted like the rest
  of the dashboard. Binding them to a principal so the `PolicyEngine` gates them
  lands with WorkOS SSO in Phase 2 — until then anyone who can reach the hub can
  edit any agent.
- **No tenancy.** The hub still has no `org_id` anywhere, so agents and their
  memories are per-deployment, not per-client.
- **Conversations are not persisted.** Each turn sends the running transcript
  from the client; only memory survives a reload. Sessions are recorded for ROI,
  but there is no "resume this conversation" yet.
- **No scheduling.** `skill_schedules` exists for skills; an agent cannot yet be
  put on a cron.
