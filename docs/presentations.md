# Presentations — direction and plan

Status: **proposal**. Nothing here is built. It exists so the two of you can
disagree with it before step 1 starts.

## The idea

Decks are built and presented from the hub, in the brand, by an agent that
knows the firm's material. During a talk the presenter asks for a slide ("case
study, Helios") and it appears, filled in from the knowledge base, without
leaving the presentation.

## The decision

Build the first half as described, and build the second half **one screen
removed from the audience**:

- **Decks in the hub, as HTML.** The design system already assumes it: a
  1920×1080 deck template with 18 slide types, an animation engine, and a rule
  that decks are built by duplicating those types and never by inventing a
  treatment. A deck the hub renders is a deck an agent can change; a `.pptx`
  on SharePoint is not. PDF comes from the same HTML.
- **Live slides land on the presenter's screen first.** The presenter triggers
  one, keeps talking, sees it build on their own screen, and sends it to the
  audience with one key. The audience never sees a slide a person has not.

The second point is the whole design. "Say a word, the audience sees a slide"
fails on three facts that no amount of prompting changes:

1. **An agent run takes 15–40 seconds.** Reading the knowledge base, writing a
   slide, rendering it. A room watching a blank screen for half a minute is
   what the audience remembers.
2. **The brand's own rules forbid it.** "Never ship invented metrics", "no
   undefined concepts, no unsupported conclusions", and the dependency audit —
   a slide must only use what earlier slides established. A slide nobody has
   read, shown to a client, breaks all three at the moment a wrong number costs
   the most.
3. **Transcripts are not live.** Teams transcripts arrive after the meeting.
   A spoken trigger means speech recognition in the presenter's browser, in a
   room where other people are also talking.

Staging on the presenter's screen turns each of these from a failure into a
non-event: generation time hides behind the presenter talking; the presenter's
glance is the review; and the trigger can be a key and three typed words
before it is ever a voice.

## What it is made of

```
/decks                        the roster: every deck, who built it, last presented
/decks/<slug>                 editor: the slide list, the agent's chat beside it
/decks/<slug>/present         presenter screen (notes, next slide, staging area, clock)
/decks/<slug>/show            audience screen: shows what the presenter has pushed
/decks/<slug>.pdf             the same HTML, printed
```

| Piece | What it is | Why it is that way |
|---|---|---|
| **Brand template in code** | The 18 slide types as HTML/CSS components with the tokens (colours, type, spacing, motion) from the design system. The agent fills slots; it never writes CSS. | Branding in a prompt drifts; a template cannot. Every deck comes out on-brand because there is no off-brand path. |
| **A deck** | A row: slug, title, audience, the ordered slides; each slide a type plus its slot content (headline, resolution, body, figures, image choice from the asset set). Stored as data, rendered on request. | Data, not HTML, is what an agent can change one slot at a time, and what the dependency audit can read. |
| **The deck agent** | Builds a deck from a brief and the knowledge base, following `presentation-narrative.md` (Introduce → Explain → Connect → Apply → Conclude), and reports its dependency audit with the deck. Also writes reserve slides. | The narrative method is the firm's; it belongs in the agent's instructions, with the design system in its collection. |
| **Reserve slides** | Before a talk, the agent prepares slides for the questions the deck invites (the case study behind a claim, the figure behind a metric, "how does it compare to X"). Kept with the deck, unshown. | Most live asks are predictable. A reserve slide is instant and reviewed; only the unexpected ask generates live. |
| **Staging** | The presenter screen has a slot where a requested slide builds. Keys: trigger, push to audience, discard. | The review step, as a place on the screen rather than a rule in a prompt. |
| **Audience screen** | A second browser window or device, following the presenter's pushes over a server-sent stream. Shows nothing it was not sent. | One source of truth for what the room sees, so staging is not bypassable by a refresh. |
| **Trigger** | Step 2: a key plus typed words. Step 3: a wake phrase through the browser's speech recognition on the presenter's laptop, with the typed path kept. | Typed works in every room on the first day. Voice is added once the rest is trusted, not before. |
| **Export** | PDF from the rendered HTML (Playwright is already in the image for other reasons). Saved to SharePoint through the same create-only tool shape as meeting notes: one folder, new files only. | Same fence as notes. No deck-shaped reason to widen it. |

## What the agent may and may not do

- It fills slots in slide types. It cannot add a type, change the template, or
  emit markup.
- Every figure on a slide carries a source: a knowledge-base document, a
  PM-tool record, or "supplied by the presenter". A slot with no source
  renders as a visible placeholder (`[00%]`), never as a plausible number. This
  is the design system's rule, enforced by the renderer rather than asked of
  the model.
- Live slides are built with the deck so far as context: what has been
  established, what the audience has been told. The agent is asked for the
  dependency check on the new slide and the presenter sees its one-line answer
  in staging ("uses: cycle time, defined on slide 4").

## Hard constraints to respect

- **Nothing reaches the audience screen except by the presenter's push.** Not
  on generation, not on a timer, not on a reconnect.
- **Latency is design, not optimisation.** Reserve slides exist because live
  generation will never be fast enough to wait for in silence. Do not trade
  the staging step for a faster model.
- **The brand assets are inputs, not outputs.** Logos, portraits, illustrations
  and fonts come from the design system's asset set and are used as supplied;
  the design system forbids retouching them and so does the renderer.
- **The design system has to be in the knowledge base first**, in a
  collection the deck agent is scoped to, and its four known inconsistencies
  (domain, the duplicated red value, the logo note, the border token) resolved
  in the text before an agent treats it as truth.

## Phased plan

### Step 1 — Decks in the hub

The brand template in code; the deck model and renderer; `/decks` and the
editor; the deck agent building a full deck from a brief with its dependency
audit; PDF export; create-only save to SharePoint. **Presenting works as a
plain full-screen deck.** No live layer yet.

Needs from you: the logo files, the portrait and illustration set, the fonts
you are licensed to use, and the deck template HTML if it exists as a file
(the design system names `templates/teqneo-deck/TeqneoDeck.dc.html`). An
existing deck you like, as the reference.

Done when: an agent builds a 20-slide deck from a brief, every slide is one of
the 18 types, the audit lists each concept's first use, and the PDF matches
the screen.

### Step 2 — Live layer

Presenter and audience screens; the server-sent stream; staging; typed
trigger; reserve slides generated with the deck; the dependency check on live
slides.

Done when: in a rehearsal, a typed "case study, Helios" produces a slide in
staging while the presenter keeps talking, and the audience screen changes
only on the push key.

### Step 3 — Voice

Wake phrase in the presenter's browser, feeding the same trigger. Kept
optional and off by default.

Done when: it works in a quiet room, fails safe in a noisy one (a misfire
only ever stages, never shows), and the typed path still exists.

## What this deliberately does not do

- **Edit decks in PowerPoint.** The hub renders; PowerPoint is an export
  format if anyone needs one, through the same HTML. Round-tripping edits made
  in PowerPoint back into the deck model is a different product.
- **Generate imagery.** Slides use the supplied asset set. No generated
  portraits, icons or diagrams: the design system's whole visual language is
  the supplied halftone collage, and a generated image is the fastest way off
  brand.
- **Record or transcribe the talk itself.** Teams does that already when the
  talk is a Teams meeting; the notes flow picks it up afterwards.
- **Let the audience interact.** The audience screen is a display, not an app.
