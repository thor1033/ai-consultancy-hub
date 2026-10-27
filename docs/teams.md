# Microsoft Teams: transcripts, the team's files, and meeting notes

Two MCP servers, one file (`packages/mcp/servers/teams/server.mjs`):

- **`teams`** — read-only transcripts and files (below).
- **`teams-notes`** — one tool that saves meeting notes as a **new** Markdown
  file in one folder, and files them in the knowledge base
  ([Meeting notes](#meeting-notes-teams-notes)).

They are given to an agent separately. Ticking `teams` never brings the
ability to write along with it.

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

**Channel meetings are found through a calendar.** Microsoft's bulk listing of
an organiser's transcripts (`getAllTranscripts`) [does not return channel
meetings](https://learn.microsoft.com/graph/api/onlinemeeting-getalltranscripts)
— exactly the meetings this server shares. So the server also reads a calendar
(`M365_TEAMS_CALENDAR`, by default `M365_MAILBOX`: the secretary's mailbox),
takes each event's Teams join link, looks the meeting up under the organiser
(`onlineMeetings?$filter=JoinWebUrl eq '…'`) and lists that meeting's
transcripts one meeting at a time, which Microsoft does support for channel
meetings. Both routes run on every list; a transcript found by both counts
once. What follows from it:

- **Invite the secretary to the meeting series** (secretary@teqneo.co, as for
  accepting meetings). A channel meeting that is not on its calendar cannot be
  found. A *Meet now* in a channel has no invitation, so it never can.
- **Only the organiser's meetings resolve.** A channel meeting's calendar
  event names the team's group mailbox as organiser, so the server reads the
  real organiser from the join link (its `context` carries their object id).
  A meeting someone else organised is named as unreachable without a lookup;
  one whose link names the organiser but that Microsoft does not match is
  reported as unmatched. Neither is dropped silently. Short `/meet/<id>` links
  are looked up by their meeting id instead.
- **A recording is not a transcript.** A meeting recorded without transcription
  has nothing to read; the empty result says how many meetings it looked at.

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
- **Graph access to transcripts.** A tenant-wide switch, separate from the
  policy below, decides whether any app may read transcripts through Graph.
  When it is off, every transcript call fails with
  `GraphAccessToTranscriptsDisabled`. Turn it (and speaker names) on:

  ```powershell
  Update-Module MicrosoftTeams          # the parameters need a recent module
  Connect-MicrosoftTeams
  Set-CsTeamsMeetingConfiguration -Identity Global `
    -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true
  ```
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
- `Calendars.Read` — already there for `microsoft365`; it is how channel
  meetings are found (see above)

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

Two things that go wrong here:

- **The query goes in the URL bar**, with the method dropdown beside it, not in
  the *Request body* box. The body box is for the POST's JSON only. A GET typed
  into it runs whatever is in the URL bar, by default `/me`.
- **`<client-id>` is the app's *Application (client) ID*** (App registrations
  → the app → Overview), the same value as `M365_CLIENT_ID`. Not the app's
  *Object ID*, and not the Enterprise Application's. A grant to the wrong id
  succeeds and does nothing: check with `GET …/sites/<that id>/permissions`.

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
| `GraphAccessToTranscriptsDisabled` | The tenant switch is off: `Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true` (step 0). |
| 403 on files | Step 3 was not done, or the grant went to the app's Object ID instead of its Application (client) ID. |
| `channelMeetings.calendar` is `null` | Set `M365_MAILBOX` (or `M365_TEAMS_CALENDAR`) to the mailbox invited to the team's meetings. |
| `teamsMeetingsOnCalendar: 0` | That mailbox is not invited to the meeting series. Add it as an attendee. |
| `organisedByOrganiser` lower than `teamsMeetingsOnCalendar` | The notes say which: organised by someone other than `M365_TEAMS_ORGANIZER_ID`, or a link Microsoft did not match. |
| Meetings resolve, `transcriptsFound: 0` | Transcription was not on in them (step 0). Recording alone does not make one. |
| Could not read the calendar | The app needs `Calendars.Read` and the mailbox must be in the Exchange access policy's group — the same setup as `microsoft365`. |
| "No transcripts" | Nobody turned on transcription in those meetings (step 0). |

## Meeting notes (`teams-notes`)

`teams-notes` has one tool, **`teams_notes_save`**. Like every tool that
writes, an agent's call to it is held for a person's approval unless an admin
has switched that off for the agent's entry ([approvals.md](approvals.md));
the file is created when someone approves, and the next sync of the notes
source files it in the knowledge base. It writes up one
transcribed meeting as a new Markdown file in one folder of the team's files,
`M365_TEAMS_NOTES_FOLDER` (Teqneo: `Meetings/Notes`, so the notes sit in the
Meetings channel's *Shared* tab). The agent supplies the content, and the
server lays it out the same way every time:

```markdown
---
meeting: "Teqneo Check-In"
date: 2026-10-21
transcribed: "Tue, 21 Oct 2026, 20:00 to …"
meetingId: "…"
transcriptId: "…"
written_by: "AI Hub agent, from the Teams transcript"
---

# Teqneo Check-In — 21 Oct 2026

_Written by an agent from the meeting transcript. Check it against the transcript before relying on it._

**Attendees:** Ditlev Brygmann, Thor Simonsen

## Summary
## Decisions          1. … _(00:12:04)_
## Actions            - [ ] … — **Owner**, due … _(00:31:10)_
## Open questions
```

The file is named by the meeting's date and subject: `2026-10-21 Teqneo
Check-In.md`.

**What it can and cannot do.** Microsoft cannot fence a folder: `Sites.Selected`
grants write on the whole site. So the folder is fenced by the code, in three
ways:

- **The tool takes no path.** The folder comes from the deployment's
  configuration, checked at startup (no `..`), so the model has nothing to
  point elsewhere.
- **Create only.** The upload asks Graph to *fail* if the name exists
  (`conflictBehavior: "fail"`), so Graph itself refuses an overwrite. Saving the
  same meeting again makes `… (2).md`. There is no tool that edits, moves or
  deletes.
- **Same scope as reading.** A meeting outside a channel cannot be written up,
  just as it cannot be read.

**Filed in the knowledge base.** After a run in which a note was saved, the
hub syncs the notes folder into the **`meetings`** collection (source
`teams-notes`), so any agent scoped to it can answer "when did we decide X?"
across meetings. The run's answer ends with a line saying it was filed, or, if
filing failed, that the note is in Teams but not yet searchable, and why. The
same sync runs from `/knowledge` → Sources → *Teams meeting notes*. The files
are the record and the collection is the index: a note deleted in Teams stays
in the collection until it is deleted there too.

### Setup

1. **Grant write on the site**, in Graph Explorer, exactly as in step 3 above,
   with `"roles": ["write"]` (write includes read). Check with the GET: the app
   should now show `write`.
2. **Set the folder:**
   `flyctl secrets set -a teqneo-ai-hub M365_TEAMS_NOTES_FOLDER='Meetings/Notes'`.
   The folder is created on the first save if it does not exist.
3. **Give the agent both servers**, `/agents` → the agent → Settings → What it
   may use: **`teams`** (to read the transcript) and **`teams-notes`** (to save).
   Then **What it may read** → include the `meetings` collection, so it can find
   past notes.
4. **Try it:** *"Write the notes for the most recent Teqneo Check-In."* The
   answer links to the new file. `teams_status` (on `teams`) shows the notes
   folder and whether it exists yet.

If a save fails with 403 after the folder exists, the app was granted read but
not write (step 1).

**Automatic later.** Once you trust the notes, add a schedule to the agent,
e.g. every evening: *"Write notes for any meeting transcribed today that has
none yet in Meetings/Notes."* Until then, ask for each one.

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
| `teams_meetings_list` | Which meetings have a transcript (default: last 30 days)? A recurring meeting appears once per transcribed occurrence. Channel meetings come from the calendar route above. |
| `teams_transcript_get` | What was said: `[00:12:04] Name: …`, one line per turn, a page at a time. |
| `teams_files_list` | What is in a folder? Each channel has a folder named after it. |
| `teams_files_search` | Which files mention this? |
| `teams_file_read` | A file's text, a page at a time: Word, PowerPoint (in slide order), Excel (sheet by sheet), PDF, `.vtt`, HTML, plain text. |
| `teams_notes_save` | **`teams-notes` only.** Saves one meeting's notes as a new file in the notes folder. |

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
npm run verify:teams -w @ai-hub/mcp
# or: node --experimental-transform-types packages/mcp/verify-teams.mjs
```

No tenant, no app registration, no database. A throwaway HTTP server stands in
for Microsoft, and the real server runs against it through
`builtinServerConfig` → `connectMcpServers`. The files it serves are real
Office files zipped by the script and a PDF written byte by byte. 60 checks,
including the startup refusals, that no tool can write, that a private
meeting is hidden from the list and refused by id, the attribution fallback,
paging that joins up with nothing lost, and that no oversized or unreadable
file is ever downloaded.

For notes it drives the write path end to end:
- the read server never carries the write tool, even with `HUB_TEAMS_MODE=notes`
  in the environment;
- the missing folder is created where it should be;
- the upload session asks Graph to fail on an existing name;
- the bytes go to the upload URL without the token;
- a second save makes `(2)` and leaves the first file untouched;
- a private meeting is refused before any upload starts;
- the knowledge source reads the notes back through the read server.

And, with the fixture's bulk listing behaving as Microsoft's does (channel
meetings left out), that the calendar route finds them: one lookup per join
link however many occurrences, a short `/meet/` link found by its meeting id,
other platforms skipped, someone else's meeting named from its link without a
lookup, an unmatched link reported as such, the private meeting still hidden,
a denied calendar degrading to a note while the bulk results still come back,
and `M365_TEAMS_CALENDAR` overriding the mailbox.

108 checks.

What it cannot prove: that Microsoft's `JoinWebUrl` filter matches the join
link exactly as a calendar event carries it (`teams_status` reports how many
links resolved, which is the check), that the live tenant is configured (`teams_status` is
for that, and a first save is the only proof of write access), and the few
lines in `runSession` that file notes after a run. Those need a fake model
that streams, which the web test scripts do not have yet; `verify:scheduler`
fails today for the same reason.

## What this increment deliberately does not do

- **Write anything but new notes.** No editing, moving or deleting, and no
  folder but the configured one. Decks are next, and get the same treatment: one
  create-only tool, one folder.
- **Write notes automatically.** That is a schedule on the agent, added once the
  notes have earned trust.
- **Read meetings someone else organised.** The access policy is granted to
  one organiser. Adding a second person is a second
  `Grant-CsApplicationAccessPolicy` and a change to accept several ids.
- **Index the whole library into the knowledge base.** Only the notes folder is
  indexed. Agents read other files live.
- **Speaker notes in decks, old `.doc`/`.xls`/`.ppt`, images, scanned PDFs.**
  The last has no text to extract; the tool says so rather than returning
  nothing.
