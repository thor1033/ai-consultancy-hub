# Connections added on the page

A **connection** is a remote MCP server that agents can be given. Examples are a
CRM, a project board or a ticket queue. There are two ways to declare one:

| | Where | Who | Takes effect |
|---|---|---|---|
| **The deployment** | `HUB_REMOTE_MCP_SERVERS` (a Fly secret) | Whoever deploys | On the next deploy or restart |
| **The page** | Connections → **Add a connection** | An admin | At once |

Both kinds sit in the same registry (`packages/mcp/src/remote.ts`). Runs, the
hub's MCP server, the agent form and the pages all read them the same way. If a
name is declared in both places, the deployment's entry wins, and a name it
declares cannot be taken on the page.

## Adding one

An admin opens **Connections** and fills in the form:

| Field | Required | Notes |
|---|---|---|
| Name | Yes | |
| Address | Yes | `https://…`. Plain `http://` is allowed only to this machine, for testing. |
| Token | No | |
| What it is for | No | |
| Short name | No | Expert view only. It is what agents and tool lists refer to; it is made from the name otherwise. |

Before saving, the hub dials the server and counts its tools, so a typo shows up
straight away rather than in an agent's run. If the server refuses the token or
does not answer, the page says so and offers **Save it anyway**.

Then give the connection to an agent: on the agent's Settings page, under "What
it may use", or with `hub_agent_update` from Claude Code. What the agent writes
through it waits for a person's approval, like any other write.

A connection's own page has **Change or remove**:
- An empty field keeps what is saved.
- A new address or token is dialled before it is saved.
- **Remove** takes it out of every run. Agents that had it keep the entry, and
  their runs say it is gone.

Only admins can add, change or remove connections (`admin:manage`). A
connection is a new place where every agent given it sends what it reads and
writes.

## How the token is kept

- **Encrypted at rest.** The address and token are stored only in encrypted
  form, in `mcp_servers.url_sealed` and `token_sealed`. The address is encrypted
  too because an address can carry a key in its path.
- **The cipher.** It is AES-256-GCM with a fresh IV for each value, in
  `apps/web/src/lib/secretBox.ts`. The value's purpose (`mcp:<name>:token`) is
  bound in as associated data. So a value copied to another row or field does
  not open.
- **Never sent back.** The page never receives a saved address or token. To
  change one, you type a new one.
- **The key.** It is derived (HKDF-SHA256) from `HUB_SECRET_KEY` when that is
  set. Otherwise it is derived from `WORKOS_COOKIE_PASSWORD`, which every
  deployment already has because AuthKit requires it.
- **Which key sealed a value.** Each sealed value records it. If
  `HUB_SECRET_KEY` is added later, values sealed before stay readable, and new
  ones use the new key.
- **Changing the key.** Changing the secret that sealed a value makes it
  unreadable:
  - The connection drops out of the registry.
  - Its page and every run that names it say why.
  - The fix is to type the address and token again on its page.

  Set `HUB_SECRET_KEY` (32+ characters) if you want to rotate the cookie
  password without touching connections.

## How it is loaded

The registry is read synchronously. So `lib/connections.ts` loads the
connections into it at the places work starts:

- a run, an ask or a hand-off;
- the hub's MCP server and the local agent server;
- saving an agent;
- the Connections pages;
- source syncs;
- approving a held write.

The load is cached for 5 seconds. That is the longest another machine of the
deployment can lag behind a change, and the machine that made the change
reloads at once. If the database cannot be read, the last good list is kept.

## Not offered on the page

- **Forwarding a person's own token** (`forwardIdentity`). It is a statement of
  trust in a server, made in the deployment's config.
- **Extra headers** (`headers`).
- **`readOnly`.**

These stay in `HUB_REMOTE_MCP_SERVERS`.

## Verifying

`npm run verify:connections -w web` runs 37 checks against the repo's remote MCP
fixture and a stand-in Messages API:

- sealing, keys and tampering;
- who may add, change or remove a connection;
- address and name checks;
- dialling before saving;
- that nothing is stored in plain text;
- a real agent run being offered the connection's tools;
- key rotation and the repair;
- removal.
