# Setting up Claude Code with the hub

How a colleague gets the same setup: the hub's agents as Claude Code
sub-agents in every project, the hub's own tools, and (optionally) the PM-tool.
Two minutes for the admin, one command for the colleague.

## 1. The admin (once per colleague)

In the hub, open **/admin → Access**:

1. **Add or update a person** — their work email and the `analyst` role. That
   lets them run agents and search knowledge; `viewer` would only search.
2. **Issue a credential** — *Belongs to* that person, named after their machine
   ("Mads — laptop"). Copy the `hub_sk_…` token: it is shown once.
3. Send them the token privately (not in a shared channel), plus the command
   below.

To give them a single agent rather than all of them, bind the credential to that
agent. A bound credential exports and reaches that agent only.

Restricted knowledge collections need a grant per person (**/admin → Knowledge**),
exactly as in the browser.

## 2. The colleague (once per machine)

Needs Node 20+ and Claude Code. Then:

```bash
curl -fsSL https://raw.githubusercontent.com/thor1033/ai-consultancy-hub/master/scripts/setup-claude-code.mjs \
  | node - --token hub_sk_… --with-pm-tool
```

or, from a clone of this repo, `node scripts/setup-claude-code.mjs --token hub_sk_… --with-pm-tool`.

It sets everything up at user level, so it works in every project:

| | Where |
|---|---|
| `HUB_TOKEN`, `HUB_URL` | `~/.claude/settings.json` → `env` |
| Agent sync on every session start | `~/.claude/settings.json` → `hooks.SessionStart`, running `~/.claude/hub/sync-hub-agents.mjs --user` |
| Synced agents and skills | `~/.claude/agents/hub-*.md`, `~/.claude/skills/hub-*/` |
| The hub's MCP server (`ai-hub`) | user scope (`claude mcp list`) |
| The PM-tool's MCP server (`pm-tool`), with `--with-pm-tool` | user scope; signs in with their own account on first use |

Then start a new Claude Code session. The agents an admin has set to **Local**
or **Both** appear as `hub-<name>` sub-agents; `/agents` lists them.

Re-running the command is safe — it replaces its own entries and keeps
everything else in `settings.json` (the previous file is kept as
`settings.json.before-hub`). Run it again with a new token when a credential is
rotated.

## Claude Code on the web

Cloud sessions do not read `~/.claude`. In this repository the project's own
hook (`.claude/settings.json`) does the sync instead; the session's environment
needs `HUB_TOKEN` set as an environment variable and `hub.teqneo.co` allowed on
its network, in the environment's settings on claude.ai.

## Revoking

Revoke the credential in **/admin → Access**. Everything stops at once: the
sync gets a 401 and keeps nothing new, and every sub-agent's calls are refused
by the hub — the files left on their machine hold instructions, not access.
Disabling the person does the same for all their credentials.
