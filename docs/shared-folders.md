# The shared folders

Status: **built** (the sync). The tree below is Teqneo's; creating its two new
folders and moving files in from laptops is the founders' part.

## The decision

The firm's documents live in **one place: the team's SharePoint library** —
the Files tab in Teams, and, through OneDrive, a folder on each laptop. Not on
laptops, not in personal OneDrives, not pasted into `/knowledge`.

The hub keeps chosen folders of that library **indexed**, each into a
collection of its own, every hour. A file dropped in a folder is something an
agent can find within the hour, and a file deleted there stops being found.
Nobody files anything by hand: the folder *is* the filing.

Why not keep pasting documents into `/knowledge`: a copy is wrong by the next
edit, and there was no way to know which copy was current — the design system
is in the knowledge base twice already. The files are the record; the
collection is the index.

## Teqneo's tree

```
Dokumenter/                      collection         who can read it in the hub
├── Company/          new        company            founders only (restricted)
│   ├── Legal/                     contracts, CVR, policies, insurance
│   └── Finance/                   budgets, pricing (the books themselves are Dinero's)
├── Clients/          new
│   └── <Client name>/           client-<name>      restricted, one drawer per client
│       ├── Sales/                 proposal, statement of work
│       └── Delivery/              what we hand over
├── Sales/                       sales              everyone
├── Go-to-market/                go-to-market       everyone
├── Delivery/                    delivery           everyone (method and templates)
├── Product/                     product            everyone
├── Hub/                         hub-product        everyone (beside the GitHub docs)
├── Brand/            new        brand              everyone (the design system PDF)
├── Training material/           training           everyone
├── General/                     general            everyone
└── Meetings/
    ├── Notes/                   meetings           the Secretary's notes (`teams-notes`)
    └── Recordings/              —                  video is not indexed
```

The existing folders are the team's **channels** (each channel's Files tab is
its folder), so they keep their names. `Company`, `Clients` and `Brand` are
plain folders made in SharePoint, **not private channels**: a private channel's
files live on a SharePoint site of their own, which the hub's grant
(`Sites.Selected`, one site) cannot reach.

**Clients.** One folder per client, named as people say it (`Møller & Co`
becomes `client-moeller-co`). Each is its own restricted collection, created
the first time the folder is seen, so an analyst on one engagement can be
granted that client on `/admin` and nothing else. A file put directly in
`Clients/`, outside any client's folder, is refused and listed — it would
otherwise sit in nobody's drawer.

**Who can read what.** In the hub, the column above, enforced by the same rule
as every other collection ([knowledge-access.md](knowledge-access.md)). Admins
are not filtered. In SharePoint itself, everyone in the team sees everything
today; when the team grows past the founders, stop inheriting permissions on
`Company` and on each client's folder (SharePoint → the folder → *Manage
access*). The hub's restriction and SharePoint's are separate fences, and the
hub's does not depend on SharePoint's being set.

## How the sync works

`HUB_SHAREPOINT_FOLDERS` declares the folders. Each entry becomes a knowledge
source `sharepoint:<key>` (`packages/rag/src/sharepoint.ts`):

```json
{
  "company":  { "folder": "Company",  "collection": "company" },
  "clients":  { "folder": "Clients",  "perFolder": "client-" },
  "sales":    { "folder": "Sales",    "collection": "sales",    "visibility": "open" }
}
```

| Rule | Why |
|---|---|
| An entry that does not say `"visibility": "open"` is **restricted**. A `perFolder` entry is restricted whatever it says. | Fail closed. Two clients in one open drawer is the leak the client folders exist to prevent. |
| The collection row is created **before** the first file is filed, and an existing row is **never changed**. | A restricted folder is never readable by everyone for the length of a sync; and what a person set on `/admin` stands. A declared-restricted folder someone opened is reported on every sync. |
| Only what changed is read. | Each indexed file carries its version (modified time and size). Unchanged files are not downloaded or embedded again, so an hourly sync of a quiet library costs a listing. |
| A file gone from the folder is deleted from the index. A listing that could not see everything **fails the sync and deletes nothing**. | The index follows the folder; a SharePoint hiccup must not empty it. |
| A file that cannot be read (a scan, a `.png`, over 30 MB, longer than 1.2 million characters) is **skipped and listed**. | Reported, never silent. Half a contract indexed as the whole of it is worse than none. |
| A folder another entry syncs, and `Meetings/Notes` (`teams-notes`), are left to their owner. | Nothing is indexed twice, into two drawers with two visibilities. |
| Naming a collection by hand on *Sync now* is refused. | It would be the one way to file a restricted folder somewhere open. |

Reading goes through the read-only `teams` server — the same Graph code and the
same site grant the agents use — so the sync adds no credential and no reach.
Nothing in it writes to SharePoint.

**The clock.** Every `HUB_SHAREPOINT_SYNC_MINUTES` (default 60; `0` = only *Sync
now*), from the scheduler's ticker, so only where `HUB_SCHEDULER=1`. Every
machine ticks; a row in `source_syncs` lets exactly one start each sync, and a
sync that died is picked up again once its interval has passed. What the last
sync did — or why it failed — shows on `/knowledge` under *Sources*, because
nobody presses *Sync now* on a source that syncs itself, so that is the only
place its breaking would show.

## Setup

1. **Make the three folders.** Teams → the Teqneo team → any channel → *Files*
   → *Open in SharePoint* → go up to *Dokumenter* → *New* → *Folder*:
   `Company`, `Clients`, `Brand`. Inside `Company`: `Legal`, `Finance`.
2. **Put the library on your laptop.** In the same SharePoint view, press
   **Sync** (OneDrive must be signed in with your Teqneo account). The library
   appears in File Explorer under *Teqneo*, or in Finder under *OneDrive –
   Teqneo*. Files stay online until opened, so it costs no disk.
3. **Move files in** from the laptop into the folder they belong in. Anything
   about one client goes in `Clients/<Client name>/`.
4. **Tell the hub which folders.** From PowerShell, as with the other secrets:

   ```powershell
   Set-Content -Path C:\temp\sp.txt -Encoding ascii -Value 'HUB_SHAREPOINT_FOLDERS={"company":{"folder":"Company","collection":"company"},"clients":{"folder":"Clients","perFolder":"client-"},"sales":{"folder":"Sales","collection":"sales","visibility":"open"},"gtm":{"folder":"Go-to-market","collection":"go-to-market","visibility":"open"},"delivery":{"folder":"Delivery","collection":"delivery","visibility":"open"},"product":{"folder":"Product","collection":"product","visibility":"open"},"hub":{"folder":"Hub","collection":"hub-product","visibility":"open"},"brand":{"folder":"Brand","collection":"brand","visibility":"open"},"training":{"folder":"Training material","collection":"training","visibility":"open"},"general":{"folder":"General","collection":"general","visibility":"open"}}'
   cmd /c "flyctl secrets import -a teqneo-ai-hub < C:\temp\sp.txt"
   Remove-Item C:\temp\sp.txt
   ```

   Fly restarts the hub with it. Within a minute the first sync starts; its
   result is on `/knowledge` → *Sources*. A malformed value syncs nothing, and
   the hub's log says which entry was wrong and why.
5. **Scope the agents** that should work out of a drawer, on each agent's
   page: the Legal agent to `company`, say. Scope is curation, not permission:
   an agent still reads only what the person asking may read.

## Verification

`npm run verify:sharepoint -w @ai-hub/rag` (needs `DATABASE_URL`): 38 checks
against a fake tenant and the real database — the configuration's refusals,
visibility on creation, one restricted collection per client, the
meeting-notes folder and a nested entry left to their owners, an unreadable
file reported, an unchanged file not downloaded again, an edit replaced, a
deletion followed, a failed listing deleting nothing, an opened drawer left
open and reported, the clock's claim and recovery, and the ticker's own entry
point. A mutation that lets a client folder be open fails four of them.

Not proven by it: Microsoft's live listing shapes (`verify:teams` copies them,
`teams_status` checks the live grant) and the first sync of the real library.

## Left out

- Writing to SharePoint from the hub, of any kind, beyond the meeting notes.
- Mirroring SharePoint's own permissions into grants. The hub's visibility is
  declared per folder; reading each file's sharing would make the index as
  complicated as SharePoint's permission model.
- Indexing video, images and legacy `.doc`/`.xls`/`.ppt`.
- More than one SharePoint site.
