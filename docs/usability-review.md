# Usability review: is the hub too complicated for the people it is sold to?

*October 2026. Written after going through every page as three people: someone
at a client firm who just wants answers, the person there who sets the agents
up, and us.*

## The short answer

Before this review: **yes, for most of the people who would use it.** The
backend is strong: agents with memory and tools, approvals, schedules,
hand-offs, patterns and run timings. But almost all of it was on every page,
for everyone. A partner who wanted to ask the contracts agent something met
these on the way:

- an org chart with spend per agent;
- a model name and a dollar cost under every answer;
- tool names like `hub_skill_meeting_prep`;
- a slide editor that only took JSON;
- a warning naming `VOYAGE_API_KEY`.

They also could not do some of the most ordinary things at all:

- **Run a skill from the web app.** Skills only ran from Claude Code or
  Claude.ai.
- **Upload a file.** Documents could only be pasted as text.

What we want is a very deep and technical backend that each customer, and each
person, can show as much or as little of as they like. So the fix is not to
remove depth. It is to let each person choose how much they see, and to make
the common things one click.

**After this review**, the hub has three views: Simple, Standard and Expert
(docs/views.md). The table below shows each person's default view.

| Person | Default view | What they see |
|---|---|---|
| Viewer | Simple | Ask, run a task, approve, add documents. No figures, no internals |
| Analyst | Standard | Sets up agents with the deep dials folded away |
| Admin | Expert | Everything, as before |

Defaults can be overridden in two ways:

- **The deployment:** `HUB_DEFAULT_VIEW=simple` for a firm of non-technical
  people.
- **Each person:** a one-click switch in the rail or in Settings, saved to
  their account.

A view hides and never grants; roles still decide what anyone may do.

## Who the hub is for

1. **The user.** A lawyer, consultant or project lead. They want to ask, get
   something useful, and say yes or no when an agent wants to change something.
   They do not know or care what MCP, a token or a model is. *Most of the seats.*
2. **The champion.** Someone at the client who sets agents up for colleagues:
   writes a brief, picks which documents an agent reads, schedules the weekly
   report. Technical-curious, not a developer.
3. **The builder.** Us, or a client's IT person. They need connections, the
   control plane, run timings, exact tool calls and costs.

The test for every screen: **can the user do their job without reading a word
they do not understand?**

## Findings, page by page

Severity rates how much a finding hurts the *user* above:

- **High:** blocks or confuses the main job.
- **Medium:** noise or jargon they must read past.
- **Low:** polish.

**Status** says what was done about it:

- **Fixed:** changed in this round.
- **Open:** still to do, listed under "What is left, by priority" at the end.

### Getting in

| Finding | Severity | Status |
|---|---|---|
| A colleague not yet invited saw "Access denied … add it to `ALLOWED_EMAILS`", which named an env var they cannot set | Medium | **Fixed:** now "You are not invited yet. Ask the person who runs the hub to add you." The setting is kept in small print for whoever they forward it to |
| No first-run guidance: an empty hub does not say what to do first | High | **Open:** see "Onboarding" below |

### Home

| Finding | Severity | Status |
|---|---|---|
| The home page was a manager's dashboard: runs, spend and deltas, a 14-day chart, schedules, tool servers, embeddings | High | **Fixed:** Simple gets its own home with four parts:<br>• a greeting;<br>• "N changes are waiting for you";<br>• **Who can help** (agents with their tasks, "Ask a question" and "Run a task");<br>• **What the agents know** (documents, "Add a document").<br>Standard and Expert keep the overview |
| "Embeddings are on the fallback, set `VOYAGE_API_KEY`" was shown to everyone | Medium | **Fixed:** shown only to admins or in Expert, in plain words below Expert |
| "Tool servers" heading | Low | **Fixed:** "Connections" below Expert |

### Agents

| Finding | Severity | Status |
|---|---|---|
| The agents page is an org chart: owners, functions, spend, attention strip. Useful to a manager, noise to a user looking for help | High | **Fixed:** Simple gets "Who can help." Each agent is a card with what it does, its tasks, "Ask a question" and "Run a task" |
| Button text "Talk to Product", "Talk to Context": the first word of names like "Product Owner — AI Hub" | Medium | **Fixed:** "Ask a question" |

### One agent

| Finding | Severity | Status |
|---|---|---|
| Skills could not be run from the web. A skill was a tool name (`hub_skill_*`) to call from Claude Code | **High** | **Fixed:** every skill has **Run**, which opens a short form built from its parameters (text, choices, yes/no, long text). The answer appears below with Copy. Long runs keep going, and the page polls |
| A long run said "the answer is kept with the agent's recent work", but Simple had no recent work to look at | High | **Fixed:** a new **Your answers** tab lists what *you* asked this agent and what came back. It covers chats, skill runs and schedules, and shows only your own runs, whatever your role (the run page never shows answers either) |
| Seven tabs (Overview, Conversation, Memory, Skills, Hand-offs, Settings, …) and a stats strip of runs, spend and memories | Medium | **Fixed:** Simple shows Conversation, Your answers and Skills. Standard adds Overview, Memory and Settings. Expert adds Hand-offs |
| Every chat answer ended with model, time, cost and sources | Medium | **Fixed:** Simple shows "Based on N passages from your documents". Standard adds time and sources; Expert adds model and cost |
| Empty chat said "starts with its brief and everything it has loaded into memory" | Low | **Fixed:** in Simple, "Ask Wren anything in its area, in your own words. It keeps what matters for next time." |
| Slug, run links, "Reach it from a client" (Claude Code commands) | Medium | **Fixed:** Expert only |

### Creating an agent

| Finding | Severity | Status |
|---|---|---|
| The form has six numbered sections, including model, tool rounds, and placement in Claude Code vs the hub | Medium (a champion's page) | **Fixed:** "How it works" and "Where it runs" fold under **Advanced**, closed below Expert. Simple does not offer creating agents at all |
| The quickest start, a ready-made team, was a link in the middle of a paragraph next to "a SKILL.md on GitHub" | Medium | **Fixed:** below Expert, a card above the form: "Not sure where to start? Use a ready-made team". The GitHub importer is Expert only |
| The patterns page showed ASCII wiring diagrams, slugs and server names in its preview | Medium | **Fixed:** below Expert it reads "Ready-made teams" with plain wording; diagram, slugs and server names are Expert only |

### Approvals

| Finding | Severity | Status |
|---|---|---|
| Each held change could expand to "the exact call" as JSON | Medium | **Fixed:** Simple reads "Show the details" and hides the JSON; the prose summary stays. Expert keeps everything |
| A 7-day statistics strip above the list | Low | **Fixed:** hidden in Simple |

### Documents (Knowledge)

| Finding | Severity | Status |
|---|---|---|
| **A document could only be added by pasting its text.** No upload | **High** | **Fixed:** "Add a document" opens on **Upload a file**, which takes Word, PowerPoint, Excel, PDF, transcripts and text files up to 15 MB. The Teams server's file reader now lives in `packages/mcp/servers/fileText.mjs`, so both read files the same way. Refusals are in words:<br>• a scanned PDF ("probably scanned pages");<br>• an old .doc ("save it in the current format");<br>• a file that is too big |
| A scanned PDF was read as a document of empty page headers, both here and in the Teams server | Medium (a bug) | **Fixed:** a PDF with no text now reads as empty, so both say "probably scanned" instead of filing an empty document |
| Title "What the agents can look up", plus a stats strip, passage counts, a sources summary and "Connect a source" | Medium | **Fixed:** in Simple it is "Your documents." with search, read and add. "Collection" reads "Folder (optional)" |
| "Search engine: Voyage / Fallback" | Low | **Fixed:** Expert only |

### Decks

| Finding | Severity | Status |
|---|---|---|
| **A slide could only be edited as JSON** | **High** | **Fixed:** slides are edited as fields:<br>• text is a field;<br>• a list is one line per item;<br>• numbers and yes/no get their own inputs;<br>• anything nested keeps a small JSON box.<br>Expert defaults to JSON and can switch |
| "Add a slide as JSON" and the Claude Code panel | Medium | **Fixed:** Simple is pointed to the ask box ("To add or rework slides, ask in the box on the right"); the panel is Expert only |
| There is no visual "add a slide of kind X" picker | Medium | **Open** |

### Context map, connections, admin

| Finding | Severity | Status |
|---|---|---|
| Context map, MCP servers and the control plane were in everyone's navigation | Medium | **Fixed:** hidden in Simple. Standard calls them "Context", "Connections" and "Admin" |
| The Connections page named `HUB_REMOTE_MCP_SERVERS`, `hub_agent_*` and a `claude mcp add` command | Medium | **Fixed:** below Expert, these become plain sentences ("Connections … are added by whoever runs the hub") and "use the agents from Claude.ai: Settings → Connectors → paste this address" |
| Admin showed the OAuth status, bearer credentials, the audit log and an MCP registry that asks for an admin token | Medium (for a champion) | **Fixed:** Standard shows **People and access**, meaning people, their roles and which folders they may read, all in plain words. The rest is Expert |

## The vocabulary

A short list of the words the hub used and what Simple and Standard say now.
Expert keeps the precise terms.

| Was | Simple / Standard |
|---|---|
| Knowledge, collection | Documents, folder |
| Chunks | Passages from your documents |
| MCP servers, tool servers | Connections |
| Control plane | Admin |
| Patterns | Ready-made teams |
| Skill (the tool `hub_skill_x`) | A task, with a Run button |
| "The exact call" (JSON) | Show the details |
| Brief, loaded into memory | (said in words: "It keeps what matters for next time") |
| Model, tokens, cost | (not shown) |

## What was built

- **Views** (docs/views.md): Simple, Standard and Expert.
  - Resolved from your choice, then the deployment's default, then your role.
  - Saved in a cookie and on your account.
  - Switched from the rail or Settings.
  - Navigation, pages and client components all read it.
- **Settings page** (`/settings`): what each view shows, where yours came from,
  a reset, and light or dark.
- **Run a skill from the web app:** a form from the skill's parameters, run as
  you, answer shown with Copy. Long runs are polled; a run is readable only by
  whoever started it.
- **Your answers** on each agent: your own chats, runs and answers, and no one
  else's.
- **Upload a file** to Documents: Word, PowerPoint, Excel, PDF, transcripts and
  text. One shared reader, also used by the Teams server.
- **Slides as fields**, without JSON.
- **A Simple home and agent directory.**
- **Plain wording** across access denied, connections, admin, patterns, new
  agent, approvals, documents, decks and chat.
- **`verify:views`**: 74 checks. It renders the real pages per view and fails
  if Simple shows a cost, a model, a tool name, "MCP", tokens or JSON. A
  control check confirms the same test trips on Expert's home. It also covers:
  - that a view never grants;
  - the saved choice;
  - running a skill and reading it back;
  - who can read whose answers;
  - uploading each kind of file and each refusal.

## What is left, by priority

1. **Onboarding (High).** A first visit to an empty hub should say what to do,
   in two lines and three buttons:
   - "Add your first documents";
   - "Start from a ready-made team";
   - "Invite a colleague".

   The same applies per person: a first-time Simple user could get a short
   "here is how this works" card on Home that they can dismiss (a preference
   key, like the view).
2. **One front door to ask (High).** Simple's home asks the person to pick an
   agent first. Most people would rather type the question and let the hub
   route it. The Front desk pattern already does this as agents. What is
   missing is an "Ask anything" box on Home that sends to a deployment-chosen
   front-desk agent. That is a setting plus a box: small.
3. **Pick a slide kind visually (Medium).** Simple adds slides by asking in
   words, which works but hides what kinds exist.
4. **Per-deployment words (Medium).** A firm may call agents "assistants" and
   documents "the library". A small term map (env or a settings row) in front
   of the plain labels would let each customer use their own words.
5. **A glossary (Low).** One page explaining the words Standard still uses
   (brief, memory, skill, schedule, hand-off), linked from Settings.
6. **Schedules in plain words (Low).** The schedule form asks for a prompt and
   a cadence. Simple does not show it today. A champion would be helped by
   presets ("every Monday at 9").
7. **Read upload errors on the deployed app.** A real upload on the deployed
   app is the last check. The build bundles the PDF reader and `verify:views`
   reads each format through the shipping action, but not inside the deployed
   image.
