# Decks — presentations that change while you present

A **deck** is a presentation the hub stores as data and draws in the Teqneo
design system. You present it from the hub, and it can change while it is on
screen: a question from the room becomes a slide in the presenter's tray within
seconds, and goes on screen only when the presenter says so.

```
/decks                      every deck you may open; new deck
/decks/<id>                 the slides, the tray, the question box, edit as JSON
/decks/<id>/present         presenter view: current, next, notes, sources, tray
/decks/<id>/show            audience view: the slide and nothing else
/decks/<id>/print           every slide as a page, for "Save as PDF"
hub_deck_* (MCP)            the same deck from Claude Code or any agent client
```

## A slide is data, not markup

Each slide is a `kind` plus fields (`lib/decks/schema.ts`). The hub renders them
(`components/slides/Slide.tsx`), so every slide is on brand however it was made,
a new slide renders the instant it arrives, and nothing a model writes can run in
the audience's browser: every field is text, and the one inline format is
`**bold**`.

### The consultancy grammar

Decks are written the way a strategy consultancy writes them, and the renderer
holds every content slide to the same frame, top to bottom:

| Part | Field | |
|---|---|---|
| Tracker | `kicker` | Where in the storyline: "Diagnostic", "Recommendation". |
| Sticker | `sticker` | "Preliminary", "For discussion", "To be confirmed". |
| Action title | `title` | The takeaway as one sentence, never a topic. |
| Caption | `caption`, `unit` | What the exhibit measures, and in what. |
| Exhibit | the kind | A chart, matrix, plan or list. |
| So what | `takeaway` | One line in a callout. |
| Fine print | `footnote`, `sources` | Printed: "Source: …". |

White ground, black type, hairlines, and one red for what carries the point;
greys for everything else.

### Kinds

| Kind | Use it for |
|---|---|
| `title` | The cover: title, subtitle, client, date. |
| `agenda` | The storyline, with the part you are at highlighted. |
| `summary` | The executive summary: numbered headlines with detail. |
| `section` | A divider. |
| `bullets`, `columns` | Text, when no exhibit fits. |
| `stats` | Up to four headline numbers. |
| `bars` | Comparing items; highlight the one that matters. |
| `trend` | A series over time, with a growth annotation. |
| `waterfall` | How a total is built up and taken down. |
| `matrix` | A 2×2 with items placed and a focus quadrant. |
| `process` | Steps as chevrons, with the current one marked. |
| `timeline` | A Gantt: bars and milestones over periods. |
| `harvey` | Options against criteria in Harvey balls, one recommended. |
| `table` | Anything tabular. |
| `quote`, `quotes` | One quote large, or "what we heard". |

The limits are the slide's: past them text no longer fits at a size a room can
read. A slide that would overflow is refused with the field named, so an agent
fixes it in one go. Longer content gets a smaller type size automatically,
within those limits.

## Presenting

Open **Present**. The presenter view shows the slide on screen, the next one, the
notes and sources, a filmstrip, the question box and the tray. **Open audience
window** opens the room's view; share that window in Teams or put it on the
projector. Arrow keys, Page Up/Down and Space move both, which is what
presentation clickers send. **F** in the audience window toggles full screen.

**Start presenting** does two things:

- Every audience view follows the presenter, on any device. Windows in the same
  browser move instantly (BroadcastChannel); other devices within about a second,
  through the database. The views poll a version number, so it works the same on
  every Fly machine and nothing holds a connection open.
- The deck becomes the presenter's: an agent's new slide goes to the **tray**
  instead of the deck, and agents cannot change, move or remove live slides until
  the presentation stops. They may still revise their own slides in the tray.

## The question box and the tray

Type the question as it was asked and press **Draft a slide** (⌘/Ctrl+Enter).
The hub retrieves from the deck's collection **as the presenter** (so a slide can
only quote what the person presenting may read), makes one call to the fast
model with the deck's outline and the slide on screen, and puts the slide in the
tray, with the question in its notes and its sources printed on the slide. Typically 10–20 seconds.

A slide in the tray is never on the audience's screen. **Show now** puts it right
after the current slide and on screen; **Add after current** puts it in the deck
without moving; **Discard** drops it. Slides an agent wrote carry a blue *Agent*
tag in the presenter's views only.

The question box always goes to the tray, presenting or not: a model wrote it,
and a person decides.

## From Claude Code

| Tool | |
|---|---|
| `hub_deck_list` | Decks you can open. |
| `hub_deck_create` | A deck with its slides, in order. Returns its id and URL. |
| `hub_deck_get` | Slides with ids, what is on screen, what is in the tray. |
| `hub_deck_add_slide` | Into the deck, or the tray while presenting (it says which). |
| `hub_deck_update_slide` | Replace a slide; refused for live slides mid-presentation. |
| `hub_deck_move_slide`, `hub_deck_remove_slide` | Refused for live slides mid-presentation. |

Each tool's description carries the slide kinds, so a client needs nothing else.
These are `hub_*` tools and the approval gate ([approvals.md](approvals.md)) does
not hold them: the tray is the review, and it is where the presenter already is.

## Who may see a deck

Anyone allowed to run agents, unless the deck names a collection they may not
read: then it does not exist for them, in the list, the pages, the poll and the
tools alike. A deck about a client is as private as the client's documents.
Deleting a deck is for the person who made it, or an admin.

## PDF

**PDF** opens every live slide as a 1280×720 page; press **Save as PDF** and
choose Save as PDF in the dialog. It is what was on screen, slides added during
the presentation included, and never the tray.

## Verifying

```
npm run verify:decks -w web
```

54 checks, needs `DATABASE_URL`, no API key. The schema's refusals (the exhibits' shapes included), creating and
editing, every presentation rule (tray, no agent edits to live slides, Show now
placement, discard), six simultaneous writers all landing, who may see a deck
in every path, the MCP tools, and the parsing of a drafted reply. **Not proven
here:** that the model answers the question box in the expected shape; its
parsing is checked on canned replies only.

## Not done yet

- **Images.** No image slides; a slide that needs a picture is drawn as text.
- **Two-axis and stacked charts.** Bars, trends and waterfalls take one series.
- **A server-side PDF.** Export is the browser's print-to-PDF. Sending the PDF to
  the client's SharePoint folder needs a server-rendered file and a file tool.
- **The question box uses no tools.** It answers from retrieval, not from the
  PM tool or mail. An agent in Claude Code can do the tool-using version with
  `hub_deck_add_slide`.
- **Read-only links for the client.** The audience view needs a hub login; the
  client sees it through your screen share.
