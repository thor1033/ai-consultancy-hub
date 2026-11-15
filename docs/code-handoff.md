# From a PM task to merged code, and back

A task on the PM board can be handed to a coding agent, and its pull request
merging can close the loop on the board — with a person deciding at the two
points that matter: pressing Send on the brief, and approving the task as
done. Nothing in between needs babysitting.

```
PM tool: "Start in T3 Code" on a task
  └── T3 Code opens a DRAFT: the brief, in the track's repository, on Claude
        └── you read it and press Send
              └── the agent works on a branch, reads the hub and the PM tool,
                  and opens a pull request with "PM-Task: <project>/<task>"
                    └── the PR merges → GitHub tells the hub (signed webhook)
                          └── the hub PROPOSES: a note on the task, the task to done
                                └── /approvals: a person approves or rejects
```

## The way out: T3 Code

[T3 Code](https://t3.codes) is an open-source app that drives the coding
agents a person is already signed in to (Claude Code, Codex), with threads,
worktrees and one-button pull requests. It runs Claude Code with the person's
own configuration, so the hub's and the PM tool's MCP servers are available in
every thread without setup.

The PM tool's button (`lib/code-handoff.ts` in the PM-tool repository) opens a
T3 Code **prompt link**. A prompt link never runs anything: T3 Code opens it as
a draft and waits for Send, with the person's own permission defaults. So the
button needs no server, no tunnel and no T3 account.

The brief carries the task, its subtasks and dependencies, and the project and
task ids, so the agent reads the live task itself. It asks the agent to search
the hub before deciding, to work on a branch, to open a pull request with a
`PM-Task:` line, to note the PR on the task — and to ask before changing the
task's status. The task's own text is fenced as a description, not as
instructions. Which repository a task opens in is set per track, in the track
editor.

## The way back: a merged pull request

`POST /api/github/webhook` (`lib/github/mergedPr.ts`) receives GitHub's
`pull_request` events. When one **merges** and its description holds

```
PM-Task: ca4749f1-624f-437c-9552-6031da90c5f9/t_duh2aci
```

the hub proposes two writes for that task — `pm_add_note` attached to the task
with the PR link, and `pm_update_task` to `done` — and holds both on
`/approvals` like any agent's write. A merge is evidence that work landed, not
that the task is finished; the person approving says which. Approving runs the
exact calls with the hub's credential for the PM server.

- **Signed, or refused.** Every delivery is checked against the shared secret
  before it is parsed (HMAC-SHA256, constant-time). No secret configured means
  the endpoint answers 503: off, never open.
- **Ids only.** A `PM-Task:` line must be a whole line, and its ids are kept to
  the characters the PM tool uses, so nothing else in a PR body reaches a tool
  call. At most five tasks per PR.
- **Asked once.** GitHub redelivers; the proposed calls carry no clock, so a
  redelivery finds them already waiting (or already run) and proposes nothing.
  A rejected proposal does not block a new one.
- **Decided by an admin.** The proposals have no agent and no person behind
  them, so only an admin may decide them.
- **Never quiet.** A merge that names a task but cannot propose (no writable PM
  server, or two) answers 422 with the reason, which GitHub shows on the
  delivery, and logs it.

### Setting it up

1. Pick a secret (`openssl rand -hex 32`) and set it on the hub:
   `fly secrets set HUB_GITHUB_WEBHOOK_SECRET=…`.
2. On each repository — Settings → Webhooks → Add webhook:
   payload URL `https://hub.teqneo.co/api/github/webhook`, content type
   `application/json`, the same secret, events **Pull requests** only.
   GitHub sends a ping; the hub answers it.
3. If more than one writable PM-tool server is registered, name the one to use
   with `HUB_GITHUB_PM_SERVER`.

## Verifying

```
npm run verify:github-merge -w web
```

26 checks without a database: the signature (real, forged, altered body,
missing header), which events count, reading `PM-Task:` lines (safe ids,
duplicates, the cap), which server, and that the writes are deterministic.
With `DATABASE_URL` it drives the route handler itself: a signed merge records
two pending proposals and writes nothing to the PM tool, a redelivery proposes
nothing new, a forged delivery gets 401, and no secret means 503. The PM
server is registered from a stand-in config and never dialled.

In the PM-tool repository, `npx tsx scripts/verify-code-handoff.ts` checks the
button's side: the brief, the link, and the repository setting.

## Not done yet

- **One page for everything waiting.** T3 Code's own approvals (a command the
  agent wants to run) live in T3 Code and its phone app; the hub's live on
  `/approvals`. They are not yet in one place.
- **Who merged is not who decides.** The proposals go to admins; mapping a
  GitHub login to a hub person, so they go to whoever merged, is not built.
- **Closing on merge only.** A PR closed without merging, or reverted later,
  proposes nothing.
