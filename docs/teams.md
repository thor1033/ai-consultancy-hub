# Microsoft Teams: transcripts and the team's files

The `teams` MCP server gives an agent **read-only** access to two things in
Microsoft Teams:

- **Meeting transcripts** — what was said in the team's meetings, one line per
  speaker turn, with times. The secretary reads a meeting itself instead of
  someone pasting a `.vtt` into `meeting-to-pm`.
- **The team's files** — the Files tab (a SharePoint document library): list
  folders, search, and read Word, PowerPoint, Excel, PDF, `.vtt` and text files
  as text.

It cannot upload, edit, move, share or delete anything. As with
`microsoft365`, that is a property of
`packages/mcp/servers/teams/server.mjs` — there is no tool that writes — and of
the Graph permissions behind it, which are all read permissions.

```
agents.mcp_servers = ["teams"]
  └── builtinServerConfig("teams")                 servers.ts
        └── node servers/teams/server.mjs          stdio child, per run
              ├── login.microsoftonline.com        client credentials → token (M365_*)
              ├── graph …/users/<organiser>/onlineMeetings/…   transcripts
              └── graph …/sites/<site>/drive/…                 files
```

## What it can reach, and what fences it

Both halves use the same app registration as `microsoft365`. Neither relies on
this server behaving well; Microsoft enforces each fence:

| Half | Configured by | Fenced by |
|---|---|---|
| Transcripts | `M365_TEAMS_ORGANIZER_ID` | A **Teams application access policy** granted to that one person. Without it Graph refuses every meeting; with it, only meetings that person organised. |
| Files | `M365_TEAMS_SITE_URL` | **`Sites.Selected`**, which starts with access to no site at all. An admin grants read on this one site. |

**Channel meetings only, by default.** The organiser's meetings include private
ones — a one-to-one with a client is as reachable as the team's standing
check-in. Agents on the hub can be run by anyone with a hub login, so the server
only serves meetings held **in a Teams channel**: the ones the whole team can
already see. A private meeting's transcript is left out of the list (and
counted, so its absence is visible) and refused by id. Set
`M365_TEAMS_PRIVATE_MEETINGS=1` to widen that deliberately.

Each half switches on with its own variable. With only one set, the other half's
tools answer with the variable that is missing. With neither, or with the
credentials missing, the server refuses to start and the run fails naming the
missing variable rather than answering "no transcripts".

## Setup

Ditlev does steps 0–4 as the teqneo.co admin. About 15 minutes, plus up to
half an hour for the access policy to apply.

### 0. Make sure meetings are transcribed

Teams keeps a transcript only when transcription was on in the meeting.

- **Teams admin centre → Meetings → Meeting policies → Global → Recording &
  transcription:** *Transcription* on.
- **Each recurring meeting** (Teqneo Check-In, Teqneo PM-tool Weekly Brief):
  open it → *Meeting options* → turn on **Record and transcribe
  automatically** if your licence offers it. Otherwise someone clicks *More →
  Record and transcribe → Start transcription* each time.
- **Spoken language.** Transcription assumes English unless told otherwise. If
  a meeting is in Danish, set the spoken language to Danish (when starting
  transcription, or in *Meeting options*) — an English model on Danish speech
  produces a transcript that reads like nonsense.

### 1. Add permissions to the app registration

Use the app registration from [secretary-agent.md](secretary-agent.md#setup)
(steps 1–2 there if it does not exist yet). **Entra admin centre → App
registrations → the app → API permissions → Add → Microsoft Graph →
Application permissions:**

- `OnlineMeetings.Read.All` — to read a meeting's subject and whether it is a
  channel meeting
- `OnlineMeetingTranscript.Read.All` — to read its transcripts
- `Sites.Selected` — files, on sites granted one by one (step 3)

Then **Grant admin consent**. Application, not Delegated: this server never has
a signed-in person.

The two meeting permissions read as tenant-wide in the portal. They are not, in
practice: app access to meetings is refused for every user until step 2 grants
it for one.

### 2. Allow the app to read Ditlev's meetings

In PowerShell, with the Teams module:

```powershell
Install-Module MicrosoftTeams          # once
Connect-MicrosoftTeams                 # sign in as the admin

New-CsApplicationAccessPolicy -Identity AIHub-Meetings `
  -AppIds "<client-id>" -Description "AI Hub reads the team's meeting transcripts"
Grant-CsApplicationAccessPolicy -PolicyName AIHub-Meetings -Identity "<Ditlev's object id>"
```

The object id is in **Entra admin centre → Users → Ditlev → Object ID**. The
policy can take up to 30 minutes to apply; until then transcript calls return
403.

### 3. Grant the app read access to the team's site

Find the site address: in Teams, the channel's **Files/Shared** tab → *Open in
SharePoint*. Keep the part up to the site name, e.g.
`https://teqneo.sharepoint.com/sites/Teqneo`.

In [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer),
signed in as Ditlev (an admin and a member of the team), consent to
`Sites.FullControl.All` under *Modify permissions*, then:

```http
GET https://graph.microsoft.com/v1.0/sites/teqneo.sharepoint.com:/sites/Teqneo
```

Copy the `id` from the response (it looks like `host,guid,guid`), and:

```http
POST https://graph.microsoft.com/v1.0/sites/<that id>/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [{ "application": { "id": "<client-id>", "displayName": "AI Hub" } }]
}
```

`201 Created` means it worked. The `Sites.FullControl.All` consent is Graph
Explorer's, for this one call; the hub's app never holds it.

### 4. Set the configuration

In production as Fly secrets, locally in `apps/web/.env.local`:

```
M365_TENANT_ID=…                 # already set if microsoft365 is configured
M365_CLIENT_ID=…
M365_CLIENT_SECRET=…
M365_TEAMS_ORGANIZER_ID=<Ditlev's object id>
M365_TEAMS_SITE_URL=https://teqneo.sharepoint.com/sites/Teqneo
M365_TIMEZONE=Europe/Copenhagen
```

```bash
flyctl secrets set M365_TEAMS_ORGANIZER_ID='…' M365_TEAMS_SITE_URL='https://teqneo.sharepoint.com/sites/Teqneo'
```

`M365_TEAMS_ORGANIZER_ID` takes the object id, not an email address: Graph's
meetings API only accepts ids, and turning an address into one would need
`User.Read.All`, a read of the whole directory.

### 5. Give an agent the tools

`/agents` → the agent → Settings → What it may use → tick **`teams`**. Do this
after step 4: a bundled server that cannot start fails the whole run, not just
its own tools.

Then ask the agent to run **`teams_status`**. It reports each half as working
or not, and why. Common answers:

| It says | Fix |
|---|---|
| 403 on transcripts | Step 1 consent, or the step 2 policy has not applied yet (wait 30 min). |
| `GraphAccessToTranscriptsDisabled` | A tenant setting turned off Graph access to transcripts; turn it back on in the Teams admin centre. |
| 403 on files | Step 3 was not done, or was done for a different app id. |
| "No transcripts" | Nobody turned on transcription in those meetings (step 0). |

## Your colleague without a Microsoft account

Nothing above needs a second Microsoft 365 account. The hub reaches Teams as an
app, and both of you reach the hub with your own hub logins, so the agents and
what they read are shared already. To also open the team's files in Teams
yourself, Ditlev can add you to the team as a **guest** (Teams → the team →
*Add member* → your email). Guests are free and see the team's channels and
files.

## The tools

| Tool | Answers |
|---|---|
| `teams_status` | Which halves are set up and working, and if not, why? |
| `teams_meetings_list` | Which meetings have a transcript (default: last 30 days)? A recurring meeting appears once per transcribed occurrence. |
| `teams_transcript_get` | What was said: `[00:12:04] Name: …`, one line per turn, a page at a time. |
| `teams_files_list` | What is in a folder? Each channel has a folder named after it. |
| `teams_files_search` | Which files mention this? |
| `teams_file_read` | A file's text, a page at a time: Word, PowerPoint (in slide order), Excel (sheet by sheet), PDF, `.vtt`, HTML, plain text. |

Details that are load-bearing and easy to regress, all asserted in the
verifier:

- **Scope is checked before content.** `teams_transcript_get` looks up the
  meeting and refuses a non-channel one before it requests the transcript, so
  an id the model was never shown cannot reach a private meeting.
- **Paging, not truncation.** Long transcripts and files come back 60,000
  characters at a time with the offset to continue from, cut at a line break.
  A transcript is read for what was decided at the end as often as for how it
  began.
- **Speaker attribution can be off.** A tenant can forbid speaker labels; the
  server then asks for the unattributed transcript and says so, rather than
  failing.
- **The token stays on Graph.** Paging links come back as absolute URLs; one
  that points anywhere but Graph is refused.
- **pdf.js writes warnings with `console.log`**, and stdout is the MCP
  protocol channel. They are redirected to stderr while a PDF is read.

## Verify

```bash
node packages/mcp/verify-teams.mjs          # or: npm run verify:teams -w @ai-hub/mcp
```

No tenant, no app registration, no database. A throwaway HTTP server stands in
for Microsoft, and the real server runs against it through
`builtinServerConfig` → `connectMcpServers`. The files it serves are real
Office files zipped by the script and a PDF written byte by byte. 60 checks,
including the startup refusals, that no tool can write, that a private
meeting is hidden from the list and refused by id, the attribution fallback,
paging that joins up with nothing lost, and that no oversized or unreadable
file is ever downloaded.

What it cannot prove is that the live tenant is configured. That is what
`teams_status` is for.

## What this increment deliberately does not do

- **Write anything.** Meeting notes and decks saved to SharePoint are the next
  step, and should arrive as one tool that creates new files in one folder,
  never as a general "save" or "overwrite".
- **Read meetings someone else organised.** The access policy is granted to
  one organiser. Adding a second person is a second
  `Grant-CsApplicationAccessPolicy` and a change to accept several ids.
- **Index the files into the knowledge base.** Agents read files live. Copying
  the library into `/knowledge` for search across everything is a source
  connector, built when it is needed.
- **Speaker notes in decks, old `.doc`/`.xls`/`.ppt`, images, scanned PDFs.**
  The last has no text to extract; the tool says so rather than returning
  nothing.
