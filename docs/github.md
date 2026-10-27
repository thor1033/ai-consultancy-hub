# GitHub: the products we build, readable by agents

Two things, one token, both read-only:

- **The `github` MCP server** — an agent reads a repository live: a file as it
  stands, what merged since a date, open pull requests and issues. GitHub's own
  remote server, declared in `HUB_REMOTE_MCP_SERVERS` like any other; no hub
  code.
- **The `github:<key>` knowledge sources** — a repository's prose (`docs/`,
  README, CLAUDE.md) indexed into a collection at one commit, so an agent that
  owns a product knows its design record and retrieval can find it.

The first product owner ([product-owner.md](product-owner.md)) uses both. The
split is the same one the PM-tool connector made: slow-moving prose is indexed,
anything that changes by the hour is read live.

```
agents.mcp_servers = ["github"]
  └── remoteServerConfig("github")              packages/mcp/src/remote.ts
        └── https://api.githubcopilot.com/mcp/readonly     bearer GITHUB_TOKEN
              X-MCP-Toolsets: repos,issues,pull_requests

HUB_GITHUB_SOURCES = { "hub": { repo, ref, paths, collection } }
  └── githubDocsSources()                       packages/rag/src/sources.ts
        └── api.github.com  commits/<ref> → git/trees/<sha> → contents/<path>?ref=<sha>
              → documents in "<collection>", each stamped with <sha>
```

## What fences it

| | Fenced by |
|---|---|
| Which repositories | The token. A **fine-grained** personal access token lists the repositories it may read, and nothing else exists for it. A classic token reads every repository the person can — do not use one. |
| What it may do there | The token's permissions: **Contents: read**, **Issues: read**, **Pull requests: read**, **Metadata: read**. No write permission is granted, so no write succeeds whatever a tool is called. |
| Which tools an agent sees | The `/readonly` endpoint offers only read tools; `X-MCP-Toolsets` keeps it to three toolsets (about fifteen tools instead of eighty); `"readOnly": true` on the entry makes the hub drop anything not annotated read-only as well. Three fences for one property. |
| Who may run the agent | The hub's own policy, as for every agent: `agent:run`. |

The same token serves the MCP server and the docs source. One thing to rotate,
one thing to revoke.

## Setup

### 1. The token

GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token.

- **Resource owner:** the account or organisation that owns the repositories.
- **Repository access:** *Only select repositories* → `ai-consultancy-hub`,
  `pm-tool`.
- **Repository permissions:** Contents **Read-only**, Issues **Read-only**,
  Pull requests **Read-only**. Metadata is added automatically. Nothing under
  Account permissions.
- **Expiration:** GitHub caps fine-grained tokens at a year. Put the date in
  the calendar; an expired token makes `teams_status`'s GitHub cousin — the
  `/mcp` page — show the server as not connected.

### 2. The configuration

In production as Fly secrets, locally in `apps/web/.env.local`. Add the
`github` entry to the existing `HUB_REMOTE_MCP_SERVERS` JSON (it is one
object; the PM-tool entries stay as they are):

```json
"github": {
  "url": "https://api.githubcopilot.com/mcp/readonly",
  "label": "GitHub",
  "description": "The repositories we build, read-only: files, commits, pull requests, issues.",
  "tokenEnv": "GITHUB_TOKEN",
  "headers": { "X-MCP-Toolsets": "repos,issues,pull_requests" },
  "readOnly": true
}
```

Then the token and the sources:

```
GITHUB_TOKEN=github_pat_…
HUB_GITHUB_SOURCES={"hub":{"repo":"thor1033/ai-consultancy-hub","ref":"master","paths":["docs","README.md","CLAUDE.md"],"collection":"hub-product"}}
```

```bash
flyctl secrets set -a teqneo-ai-hub GITHUB_TOKEN='github_pat_…' \
  HUB_GITHUB_SOURCES='{"hub":{"repo":"thor1033/ai-consultancy-hub","ref":"master","paths":["docs","README.md","CLAUDE.md"],"collection":"hub-product"}}' \
  HUB_REMOTE_MCP_SERVERS='…the full JSON, with the github entry added…'
```

`flyctl secrets set` restarts the app. `/mcp` then lists GitHub as connected,
and `/knowledge → Sources` lists one source per repository.

Each entry in `HUB_GITHUB_SOURCES`:

| Field | |
|---|---|
| `repo` | `owner/name`. Anything else is dropped. |
| `ref` | Branch, tag or commit to read. Default `HEAD`. |
| `paths` | Files and folders to index, relative to the repository root. Default `docs`, `README.md`. Only `.md`, `.mdx`, `.markdown` and `.txt` under them are read; code is never embedded. |
| `collection` | Where the documents are filed when the sync names no collection. Scope the product's agent to it. |

Malformed JSON ⇒ no GitHub sources, with a warning in the log. An entry whose
key or `repo` is not a plain name is dropped, because both are spliced into an
API path.

### 3. The first sync

`/knowledge → Sources → GitHub — thor1033/ai-consultancy-hub → Sync now`. Leave
the collection box empty and the documents are filed under the entry's own
collection; name one and it wins for that sync.

A sync reads the repository **at one commit**: it resolves `ref` to a sha, lists
the tree at that sha, and reads every file at that sha, so a push in the middle
cannot produce an index that is half one version and half another. Every
document carries the sha and a link to the file at it. A re-sync replaces that
source's documents through the same upsert path as every other connector.

What a sync refuses rather than guesses at: a truncated tree (GitHub stops
listing very large repositories, and a partial index presented as complete is
the one failure a reader cannot see), more than 300 documents under the paths,
a file over 256KB (a dump, not a document). Files with no content are skipped.
A repository the token cannot see answers **404**, not 403 — the error says so.

Syncing is manual today. A nightly sync is a schedule away once something
needs it; the product owner is told its knowledge is a snapshot and to read
the live file when a question turns on current behaviour.

### 4. Give an agent the server and the collection

`/agents` → the agent → Settings → What it may use → tick **`github`**; What it
may read → the product's collection. `seed:product-owner` does both for the
product owner.

## The tools an agent sees

From GitHub's server, read-only, in the three toolsets:

| Toolset | Tools | Answers |
|---|---|---|
| `repos` | `get_file_contents`, `list_commits`, `get_commit`, `search_code`, `list_branches`, `list_tags`, `list_releases`, `get_latest_release`, `search_repositories` | What a file says now; what changed, when, in whose words; where something lives |
| `pull_requests` | `list_pull_requests`, `pull_request_read`, `search_pull_requests` | What is in flight and what merged, with its description and files |
| `issues` | `list_issues`, `issue_read`, `search_issues`, `list_issue_types` | What has been asked for and not decided |

GitHub's tool list changes with its releases; `/mcp` shows what the hub
currently sees.

## Verify

```bash
npm run verify:github -w @ai-hub/rag      # the docs source, against a throwaway GitHub
npm run verify:remote -w @ai-hub/mcp      # a remote entry's headers and readOnly reach the dial
```

`verify:github` needs no token and no network: a throwaway HTTP server stands
in for `api.github.com`. It checks registration from the env (one source per
well-formed entry, malformed JSON ⇒ none, a bad key or repository dropped),
that a missing token means declared-but-not-connected and no request leaves,
the fetch (only prose under the paths; a `.ts` under `docs/`, a README outside
the paths, a 300KB file and an empty file left out; titles from the first
heading; every document stamped with the commit; every read at that commit,
raw, with the token as a bearer), a 404 reported with the private-repository
hint, a truncated tree refused, and — with `DATABASE_URL` — a sync, a re-sync
that must not duplicate, the default collection and the override. 25 checks.

What it cannot prove: that GitHub's live responses match the shapes copied
there, or that a token has the permissions above on the real repositories.
The first sync from `/knowledge` and the `/mcp` page are the checks for that.

## Deliberately not done

- **Writing anything.** No issue, no comment, no file. A product owner that
  could open issues would be a product owner nobody reviews.
- **Indexing code.** Retrieval over source files answers questions about code
  worse than reading the file does, and embeds secrets a repository should not
  have had. Code is read live, by path.
- **A GitHub source per agent.** Sources are per repository; agents are scoped
  to collections. Two agents that own two products are scoped to two
  collections from two entries.
- **Automatic sync.** Manual from `/knowledge` for now; see above.
