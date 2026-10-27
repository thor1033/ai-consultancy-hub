# Setting up Claude Code with the hub

Two ways in. The first is the one to use; the second remains for what cannot
sign in.

## 1. Sign in — people

One command, then one browser sign-in, in every project on the machine:

```bash
claude mcp add --transport http --scope user ai-hub https://hub.teqneo.co/api/mcp
```

Start Claude Code, run `/mcp`, pick **ai-hub** and **Authenticate** (or run
`claude mcp login ai-hub`). The browser opens the same WorkOS sign-in as the hub
itself; afterwards the tools appear and the sign-in is remembered.

What that gives them, under their own identity:

| | |
|---|---|
| Knowledge | `hub_search_knowledge`, `hub_get_document`, scoped to the collections they may read |
| Agents and skills | `hub_agent_<slug>`, `hub_skill_<slug>` — hub-run agents, whose PM-tool calls are made as them |
| The PM-tool | its `pm_*` tools, served through the hub and audited in the PM-tool as "*their name* (via MCP)" |

Their first sign-in from the company domain creates their hub account as an
`analyst` (`HUB_AUTO_PROVISION_DOMAINS`, [auth.md](auth.md)). No credential is
issued, nothing is stored on the machine but Claude Code's own sign-in, and
disabling the person in `/admin` refuses them within minutes (tokens live five).

Direct access to the PM-tool is still available as a second server if wanted —
`claude mcp add --transport http --scope user pm-tool https://pm.teqneo.co/api/mcp`
— with a second sign-in to the same account.

### Claude Code on the web

Cloud sessions use connectors made at claude.ai/customize/connectors rather
than an in-session sign-in. Add the hub there the same way once its OAuth is
on; the grant then applies to every cloud session.

## 2. A credential — local agents, scripts, the cloud

The agent sync (`scripts/sync-hub-agents.mjs`) runs outside Claude Code and
cannot use its sign-in, so an agent placed **Local** or **Both** still reaches
the machine through a `hub_sk_…` credential:

1. In the hub, **/admin → Access**: **Add or update a person** (if the
   sign-in above has not already created them), then **Issue a credential**
   named after their machine. Copy the token; it is shown once.
2. They run

   ```bash
   node scripts/setup-claude-code.mjs --token hub_sk_… --with-pm-tool
   ```

   or, without a clone, pipe the script from
   `https://raw.githubusercontent.com/thor1033/ai-consultancy-hub/master/scripts/setup-claude-code.mjs`
   into `node - --token …`. It stores the token and the sync hook in
   `~/.claude/settings.json`, adds the MCP servers at user scope and runs the
   first sync. Safe to re-run; the previous settings are kept as
   `settings.json.before-hub`.

A synced sub-agent connects with that credential, so it acts as the hub's
machine identity, not the person's — see [local-agents.md](local-agents.md).

### What the one-command setup installs

`scripts/setup-claude-code.mjs --token hub_sk_…` stores `HUB_TOKEN` and
`HUB_URL` in `~/.claude/settings.json`, installs the agent sync as a
SessionStart hook and the work log as SessionStart + SessionEnd hooks
([project-manager.md](project-manager.md)), adds the hub's MCP server at user
scope, and runs the first sync. Re-running it replaces its own entries and
leaves the rest of the file alone.

## Revoking

Disable the person in **/admin → Access** (or in WorkOS): OAuth sign-ins are
refused at the next token refresh, and every credential they hold stops at
once. Revoking a single credential stops that machine's sync and sub-agents
while leaving their sign-in alone.

## Turning the sign-in on (admin, once)

The hub publishes its OAuth metadata only when configured. In Fly:

```
WORKOS_AUTHKIT_DOMAIN=https://<your-subdomain>.authkit.app
HUB_MCP_RESOURCE=https://hub.teqneo.co/api/mcp
HUB_AUTO_PROVISION_DOMAINS=<company email domain>
```

and `"forwardIdentity": true` on the PM-tool entries in `HUB_REMOTE_MCP_SERVERS`,
or a signed-in person sees no PM-tool tools on the hub. `WORKOS_API_KEY` (already
set for the web sign-in) is what lets a first sign-in be matched to an email.

The WorkOS side (resource indicator, dynamic client registration, callback) is
shared with the PM-tool and already in place. For the PM-tool to accept a
person arriving through the hub, set `MCP_TRUSTED_AUDIENCES=https://hub.teqneo.co/api/mcp`
on it.
