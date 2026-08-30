# PM-tool integration — the hub's first remote MCP server

## What this is

The PM-tool (Atlas) is the consultancy's own project delivery hub. It is also
**client #1 of the AI hub**: it exposes its project data to the hub as an MCP
server, so an agent can read real delivery data and write back to it.

It is the first instance of the general pattern — *a client system exposes an
MCP endpoint, the hub dials it* — and the ideal one to learn on, because we own
both ends. Everything here generalizes to a client's CRM or data warehouse.

```
Neon Postgres
   └── lib/db/queries.ts       withTenant + entity validation (the app layer)
         ├── /api/projects/…   REST facade · WorkOS cookie · humans in a browser
         └── /api/mcp          MCP facade · bearer token · the hub's agent
                    ↑ Streamable HTTP (stateless)
   hub: remoteServerConfig() → connectMcpServers() → agent tool loop
```

## Direction of dependency

One-way. The hub knows about the PM-tool through `HUB_REMOTE_MCP_SERVERS`; the
PM-tool never learns about the hub — it serves an authenticated MCP endpoint to
whoever holds a valid token. Nothing in the PM-tool imports hub code.

## Design rules

**The MCP server sits on the app layer, never on the database.** All tools go
through `lib/db/queries.ts`. That module owns `withTenant` and the entity
schemas; a tool issuing its own SQL would bypass the tenant boundary and the
validation the UI depends on.

**Tools are verbs, not tables.** A generic `list_entity(entity)` would force the
model to learn the schema before asking anything useful. The tools answer
questions a delivery lead asks: *what's the status of this project*, *what's
overdue*, *what are the open risks*.

**Writes are opt-in and always attributed.** The browser writes the audit trail
from the client after an edit (`POST /api/projects/[id]/audit`), so an agent
calling the query layer directly would mutate a client's delivery record
invisibly. Every write tool records its own `activity` row with the token's
label as actor, so an agent edit reads as one in the project's own trail.

## The two sides

### PM-tool (the server)

| Piece | What it does |
| --- | --- |
| `app/api/mcp/route.ts` | The endpoint. Stateless Streamable HTTP, POST only. |
| `lib/api/machineAuth.ts` | Bearer token → org + scopes. Fails closed. |
| `lib/mcp/tools.ts` | Tool definitions over the query layer. |
| `lib/mcp/server.ts` | Builds a per-request server carrying that token's scopes. |
| `scripts/verify-mcp.ts` | End-to-end verification (`npm run verify:mcp`). |

Stateless is not a preference: on Vercel there is no process to hold a session
between invocations, so a fresh server + transport is built per request and
every request re-authenticates.

### Hub (the client)

| Piece | What it does |
| --- | --- |
| `packages/mcp/src/remote.ts` | Reads `HUB_REMOTE_MCP_SERVERS`, injects the credential. |
| `packages/mcp/src/manager.ts` | `McpHttpConfig` → `StreamableHTTPClientTransport`. |
| `apps/web/src/lib/runSession.ts` | `resolveServer()` — built-in (stdio) or remote (HTTP). |
| `apps/web/src/lib/mcpCatalog.ts` | Upserts remote servers into the control-plane registry. |

A remote server appears in `/mcp` and `/admin` on first read, so it can be
switched off from the console without a redeploy. A disabled server is dropped
from every run. Deleting one from `/admin` does not stick — the same first-read
upsert re-creates it — which is why the console labels declared servers and
points at disable instead.

## Deploying it

1. **Host the PM-tool** and note its origin, e.g. `https://atlas.example.com`.
   The endpoint is `POST https://atlas.example.com/api/mcp`.

2. **Mint a token** and map it to one organization:

   ```bash
   openssl rand -base64 24   # or: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

   On the PM-tool (Vercel → Settings → Environment Variables):

   ```
   PM_TOOL_MCP_TOKENS={"<secret>":{"org":"org_...","label":"AI Hub","scopes":["read"]}}
   ```

   `org` accepts the WorkOS org id (what you can read off a dashboard) or the
   internal `organizations.id` UUID. `label` is what the audit trail shows.
   Start with `["read"]`; add `"write"` when agent writes have been reviewed in
   practice.

3. **Point the hub at it** (hub deployment env):

   ```
   HUB_REMOTE_MCP_SERVERS={"pm-tool":{"url":"https://atlas.example.com/api/mcp","label":"PM-tool","description":"Project delivery data: projects, tasks, risks, milestones.","tokenEnv":"PM_TOOL_MCP_TOKEN"}}
   PM_TOOL_MCP_TOKEN=<the same secret>
   ```

   `tokenEnv` keeps the secret out of the JSON blob, so the blob is safe to log
   or show in a config UI.

4. **Check it** — open `/mcp` in the hub. `pm-tool` should be listed with a live
   tool count. Then add `{"name": "pm-tool"}` to an agent's MCP servers on its
   Settings tab.

### Locally

```bash
cd PM-tool && npm run dev          # :3000
cd hub && npm run dev              # :3001, with the env above pointing at :3000
```

Or exercise the hub's remote path with no PM-tool at all:
`npm run mcp:remote-fixture -w @ai-hub/mcp`.

## The tools

Read (always available):

| Tool | Answers |
| --- | --- |
| `pm_list_projects` | What engagements exist? (start here — ids are opaque) |
| `pm_project_status` | Progress, overdue work, what's due next, open risks, recent activity |
| `pm_get_project` | Full detail, by requested section |
| `pm_list_tasks` | Tasks by status / owner / milestone / overdue |
| `pm_list_risks` | Risks by status |

Write (requires the `write` scope):

| Tool | Effect |
| --- | --- |
| `pm_create_task` | Adds a task; records a `create` activity entry |
| `pm_update_task` | Updates fields; stamps `completedOn` on completion, as the board does |
| `pm_add_note` | Adds a project or task note |

## Security model, and what is still open

**Today.** A static bearer token maps to exactly one organization. The endpoint
fails closed on a missing env var, malformed JSON, an unknown token, an unknown
org, or a database error during resolution. Scopes gate writes, and a read-only
token is not offered the write tools at all — they are never registered on its
server instance, so they cannot be called either.

**The tenancy limit.** The token *is* the org selector. The hub's own principal
and per-user authorization do not cross the boundary: everything the hub sends
arrives as one machine identity. So **one token = one client deployment**; do
not multiplex organizations behind a single token.

**Phase 2.** Replace the static token with a short-lived per-run JWT carrying
the hub principal, org and scope. `remoteServerConfig()` is the seam — it builds
the headers, and callers do not change.

**RLS is not the boundary.** The PM-tool's RLS policies are dormant on Neon
(`neondb_owner` carries `BYPASSRLS`), so the explicit `org_id` predicates in
`lib/db/queries.ts` are what actually enforce isolation. Building this endpoint
surfaced that several of those queries had no such predicate and returned every
tenant's rows; they were fixed (see the PM-tool README, "Multi-tenant
isolation"). Activating RLS via a dedicated `app_user` role remains Phase-2
hardening — and is what would have made that class of bug non-fatal.

## Verification

`npm run verify:mcp` in the PM-tool, against a running dev server, drives the
endpoint through the same MCP client and transport the hub uses: auth refusal,
handshake, tool discovery, schema round-trip, tenant scoping, reads, writes,
audit attribution, and scope enforcement. Writes run against a throwaway project
in the seeded demo org, created and deleted by the script — it never touches a
real workspace.
