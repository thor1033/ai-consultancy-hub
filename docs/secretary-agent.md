# The secretary agent

A secretary is not a chat box with a job title. The properties that make one
useful are the ones you would list in a job description, and each of them is a
field on a row rather than a paragraph of encouragement in a prompt:

| The property | Where it lives | Why it is that field |
| --- | --- | --- |
| A standing brief | `agents.instructions` | Who they work for, and what they do when asked for something they cannot do. |
| **Discretion** | `agents.mcp_servers` → `pm-tool-read` | The defining trait. Enforced by the credential: PM-tool omits its write tools for a read-scoped token, so `pm_create_task` is *absent from the tool list*, not forbidden in prose. |
| Fidelity to the record | the evidence rule, in the brief and the skill | Every claim carries a timestamp and a verbatim quote. No quote means it is inference, and it is labelled. |
| Knowing the people | `agent_memories` | Who the founders are, which exact owner strings match, and that Teams mislabels both of them. Seeded as an induction pack, corrected by use. |
| Stamina for a queue | `agents.max_iterations` = 20 | Ten rounds suits looking one thing up. This one reads its memory, then grounds against a 114-task project. |
| Named expertise | `agent_skills` → `meeting-to-pm` | Work a colleague can invoke by name with real arguments, not a paragraph retyped from memory. |
| A clock | `agent_schedules` | Not yet used. See [schedules.md](schedules.md). |

The definition is **code, not a textarea**:
`packages/db/src/seeds/secretary.ts`. Every other agent here was typed into
`/agents` and exists only as a row, which is fine when the instructions are two
sentences. It is not fine when they are the difference between a reviewed change
set and a delivery record rewritten from a bad transcript.

## It proposes; a person applies

The hub has no approval step, and an agent run is an autonomous tool loop. So
an agent given a write credential and told "update the PM tool" writes
unattended — which is the one thing the founders decided this flow must not do.

The answer is not a stern instruction. It is that the secretary holds a
**read-scoped PM-tool credential**, declared as a second server (`pm-tool-read`)
against the same endpoint as the delivery lead's `pm-tool`. PM-tool filters its
own tool list by scope (`lib/mcp/tools.ts`, `toolsFor`), so the write tools
never reach the model. The same reasoning as the mailbox server below, where the
read-only guarantee is "there is no tool that writes" rather than a setting.

```
transcript ──▶ hub_skill_meeting_to_pm ──▶ changeset.json ──▶ .claude/skills/meeting-to-pm
               (Secretary, read-only)      (proposed)          (approve / edit / skip,
                                                                then apply, per row)
```

The halves interlock because the skill emits **exactly** the `changeset.json`
shape the Claude Code skill already reads — same `rows`, `section`, `decision`,
`evidence` and `call`. The hub does the grounded reading; the approval loop that
already exists does the confirming and the applying. `call.args` holds the
literal arguments to be sent, so what a reviewer approves is byte-for-byte what
gets sent, and nothing is re-derived at apply time.

## The skill

`hub_skill_meeting_to_pm`, in any MCP client:

| Argument | | |
| --- | --- | --- |
| `transcript` | required | The transcript or notes as text. A Teams `.vtt` works; so do hand-written notes. |
| `meetingDate` | required | ISO `YYYY-MM-DD`. The record is dated to the meeting, never to today. |
| `attendees` | optional | Who was actually in the room. The fastest way to get owners right. |
| `focus` | optional | Limit it to part of the board. Blank means the whole meeting. |

Three things the prompt carries that cost a session to learn, and are not
recoverable from a transcript on its own:

- **The speaker tags lie.** Teams labels both founders with a variant of the
  host's name; in the first company meeting the title-cased `Thor Simonsen` was
  *Ditlev*. The skill must re-derive the mapping from self-reference and
  vocabulary split, and state its evidence, before it assigns a single owner.
- **The track ids are not discoverable.** `pm_create_task` takes `track` as an
  id and no MCP tool maps ids to labels, so the table is in the prompt.
- **Four kinds of change are not writable at all** — milestone dates, new
  milestones, new tracks, a task's `kind`. A meeting that moves four milestone
  dates yields *zero* writable rows for them. They become `manual` rows with
  the same evidence, never approximated by shifting the tasks underneath.

## Provisioning

```bash
node packages/db/seed-secretary.mjs --check                       # no DB, no network
npm run seed:secretary -w @ai-hub/db                              # needs DATABASE_URL
```

Idempotent — the agent matches by slug, the skill by slug, memories by key — so
the same command provisions a laptop and production, and running it twice is not
a mistake.

The checks are not optional: they run first and **refuse to provision** if they
fail. What they catch is silent. A `{{placeholder}}` with no parameter behind it
renders as the literal text `{{transcript}}`, which the model reads as content
and answers confidently about a meeting it was never given.

It also warns when the environment does not declare `pm-tool-read`. That matters
more than it looks: `runSession` drops an unknown server name **silently**, on
purpose, because that is also how `/admin` disables one. A secretary whose
server was never declared does not fail — it runs with memory alone and writes a
fluent, entirely ungrounded change set.

Before it can do real work, mint the read-scoped token in PM-tool's
`PM_TOOL_MCP_TOKENS` under its own label. Not a person's existing token: the
audit trail is attributed to the label, and a secretary's reads should not
appear as someone's.

## The mailbox and calendar

The `microsoft365` MCP server gives an agent **read-only** access to one
Microsoft 365 mailbox and its calendar: what is coming up and what has arrived,
on demand, from the hub UI or from Claude Code.

The secretary's entry names its mailbox: `{"name":"microsoft365","mailbox":
"secretary@teqneo.co"}` (`SECRETARY_MAILBOX` in the seed). The credentials are
the deployment's — one app registration — and **which mailbox** an agent reads
is its own setting (Settings → What it may use → Mailbox this agent reads), so a
second agent gets a second shared mailbox without a second registration. The
mailbox has to be inside the access policy's group below, or Graph refuses it.

**Order matters.** A bundled server whose credentials are missing refuses to
start, and `connectMcpServers` then fails the whole run — so an agent that
names `microsoft365` cannot run at all, not even for PM-tool work, until the
deployment holds the `M365_*` secrets. The seed warns about this; set the
secrets first, then provision or tick the box.

It cannot send, reply, accept, decline, create or delete anything. That is a
property of `packages/mcp/servers/microsoft365/server.mjs` — there is no tool
that writes — rather than a setting someone can flip. Keep it that way when
extending: drafting belongs behind a human approval step, and the hub still has
no such step of its own — the PM-tool half borrows Claude Code's, and a mailbox
has no equivalent.

```
agents.mcp_servers = ["microsoft365"]
  └── builtinServerConfig("microsoft365")        servers.ts
        └── node servers/microsoft365/server.mjs stdio child, per run
              ├── login.microsoftonline.com      client credentials → token
              └── graph.microsoft.com/v1.0/users/<M365_MAILBOX>/…
```

## Why app-only, not delegated

The credential is an OAuth 2.0 **client credentials** grant: tenant id, client
id, client secret. There is no browser consent screen and no refresh token to
rotate, which is what an agent that will eventually run unattended needs — a
delegated token dies the moment nobody is there to re-consent it.

The cost is the thing to be deliberate about. **Application permissions are
tenant-wide**: `Mail.Read` granted this way reads every mailbox in the
organisation, not just the secretary's. `M365_MAILBOX` narrows what this server
*asks for*, not what the credential *may* reach. Scope it properly in Exchange
Online:

```powershell
# The scope must be a MAIL-ENABLED SECURITY GROUP, not a mailbox: put every
# agent mailbox in one group and point the policy at it. Adding an agent later
# is then a group membership, not a new policy.
New-ApplicationAccessPolicy -AppId <client-id> `
  -PolicyScopeGroupId aihub-mailboxes@yourdomain.com -AccessRight RestrictAccess
Test-ApplicationAccessPolicy -Identity secretary@yourdomain.com -AppId <client-id>     # Granted
Test-ApplicationAccessPolicy -Identity someone-else@yourdomain.com -AppId <client-id>  # Denied
```

The second `Test-` line is the one that matters: it should come back `Denied`
for a mailbox outside the group. Until it does, the secret in
`M365_CLIENT_SECRET` is a key to the whole organisation's mail. Policies take
up to half an hour to apply.

## Setup

0. **The mailbox.** A **shared mailbox** (Microsoft 365 admin centre → Teams &
   groups → Shared mailboxes → Add): `secretary@yourdomain.com`. It needs no
   licence — the tenant just has to have a plan that includes Exchange — and it
   has a calendar. One per agent; never a person's inbox.
1. **Entra ID → App registrations → New registration.** Single tenant. No
   redirect URI — this flow never uses one.
2. **Certificates & secrets → New client secret.** Copy the *Value*. It is shown
   once.
3. **API permissions → Microsoft Graph → Application permissions.** Add
   `Mail.Read` and `Calendars.Read`. Nothing else: the server asks for no other
   scope, and `m365_whoami` deliberately avoids `mailboxSettings` so it does not
   need `MailboxSettings.Read`.
4. **Grant admin consent.** The grant is inert until this is clicked.
5. **Apply the Application Access Policy** above, with the agent mailboxes in
   a mail-enabled security group.
6. **Fill in `apps/web/.env.local`** (in production, Fly secrets):

   ```
   M365_TENANT_ID=…
   M365_CLIENT_ID=…
   M365_CLIENT_SECRET=…
   M365_MAILBOX=secretary@yourdomain.com      # the default; an agent may name its own
   M365_TIMEZONE=Europe/Copenhagen
   ```

   Missing any of the four and the server exits 1 naming what is missing, so the
   agent run fails loudly instead of reporting an empty inbox.

7. **Give an agent the mailbox** at `/agents` → the agent → Settings → What it
   may use: tick `microsoft365` and fill in **Mailbox this agent reads**;
   `memory` attaches itself. The secretary gets it from the seed. Suggested
   instructions for a new one:

   > You are the secretary. You read one mailbox and one calendar, and you
   > cannot send or change anything. Lead with what needs a decision today.
   > When someone asks you to reply, accept or reschedule, write the draft in
   > full and say plainly that it still has to be sent by hand.

## The tools

| Tool | Answers |
|---|---|
| `m365_whoami` | Which mailbox am I reading, and is the connection working? |
| `m365_calendar_list` | What is on, between two times (default: next 7 days)? |
| `m365_calendar_get` | Who is attending this meeting, who accepted, what is the join link? |
| `m365_mail_list` | What has arrived — newest first, unread only, or matching a search? |
| `m365_mail_get` | The full body, recipients and attachment names of one message. |

Two Graph details are load-bearing and easy to regress:

- The calendar reads **`/calendarView`**, not `/events`. `/events` returns a
  recurring series as a single master row, so a weekly standup would be missing
  from "what's on tomorrow" every week but the first.
- A search sends **`$search` alone**. Graph returns 400 when it is combined with
  `$orderby` or `$filter`, so `unreadOnly` is reported as ignored rather than
  silently dropped.

Both are asserted in the verifier.

## Verify

```bash
node packages/mcp/verify-m365.mjs          # or: npm run verify:m365 -w @ai-hub/mcp
```

No tenant, no app registration, no API key, no database. A throwaway HTTP server
stands in for `login.microsoftonline.com` and `graph.microsoft.com`, and the real
server is pointed at it with `M365_LOGIN_BASE_URL` / `M365_GRAPH_BASE_URL`.
Everything else is the shipping path — `builtinServerConfig` →
`connectMcpServers` — so a pass means the tools work, not that a mock agrees
with itself. 32 checks, including that no tool name can write, that the token is
fetched once and reused, and that a wrong secret surfaces its AADSTS code.

Against the real tenant, the smoke test is `m365_whoami` — if it returns the
mailbox, consent and the access policy are both right.

## What this increment deliberately does not do

- **Nothing triggers it.** There is no cron and no webhook anywhere in the hub;
  an agent runs when someone calls it. A secretary that acts on its own needs an
  inbound route and a clock, and that is the next increment.
- **One set of credentials per deployment.** Each agent names its own mailbox,
  but they all read through the same app registration, inside the same access
  policy. Per-agent credentials are the same build as per-user OAuth, and both
  should wait for a paying reason.
- **Triage depth is a setting now, not a constant.** A run's rounds of tool use
  are capped by `agents.max_iterations` (**Settings → Tool-use rounds per run**),
  null meaning the default of 10. Listing an inbox and opening five messages
  fits in ten; triaging forty does not, so raise it before asking for real inbox
  work. A run that hits the cap says so rather than returning a partial answer —
  see [agents.md](agents.md#tool-use-rounds).
