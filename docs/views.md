# Views: Simple, Standard, Expert

The hub's backend is the same for everyone: agents with tools and memory, a
knowledge base, approvals, schedules, hand-offs, patterns and run timings. People
differ in how much of that they want to see. A partner at a client firm wants to
ask a question, run a task and say yes or no to a change. The person who builds
the firm's agents wants every dial. A **view** decides how much of the hub one
person sees, and the same pages serve all three.

A view **hides and never grants**. What anyone may *do* is still their role's
(`packages/authz`): every server action checks `sessionCan` whatever the view. A
viewer who picks Expert sees more page and can do nothing more. `verify:views`
proves this.

## The three views

| | Simple | Standard | Expert |
|---|---|---|---|
| For | Everyone who uses the agents rather than builds them | The person in the firm who sets the agents up | Whoever builds and runs the hub itself |
| Home | Greeting, "waiting for you", who can help, what the agents know | The overview: the week's runs, spend, attention, schedules | The same, plus embeddings and tool servers by name |
| Agents | A directory: each agent, its tasks, "Ask a question" and "Run a task" | The org chart with owners, functions and figures | The same |
| An agent | Conversation and Skills, each skill runnable from a form | Adds Overview, Memory and Settings | Adds Hand-offs, tool names, the slug, run timings and client setup |
| Chat answers | "Based on N passages from your documents" | Adds time and sources | Adds model and cost |
| New agent | (not shown) | Form with the deep dials under "Advanced", and ready-made teams first | Everything open, plus patterns and the GitHub importer |
| Approvals | Plain wording; "Show the details" | Adds the week's figures and "Show the exact call" | The same, plus the raw JSON |
| Knowledge | "Your documents": search, read, add | Collections, sources, figures | Plus the search engine in use |
| Decks | Slides edited as fields; add slides by asking | A switch between fields and JSON | JSON by default, plus the Claude Code panel |
| Context map | (not shown) | Shown | Shown |
| Connections | (not shown) | "Connections" in plain words | "MCP servers", with env vars and the Claude Code command |
| Admin | (not shown) | "People and access": people and folder access | The control plane: OAuth, credentials, audit, the MCP registry |

Navigation follows the same table (`NAV_SPEC` in `apps/web/src/lib/views.ts`). An
item that needs a permission is hidden from people who lack it in every view, so
Expert never adds Admin for a non-admin.

## Which view a person gets

`resolveView` in `lib/views.ts` takes the first of these that is a real view:

1. **The `hub-view` cookie.** This is the person's choice on this browser.
2. **`principals.preferences.view`.** This is the same choice saved on their row,
   so it follows them to another device.
3. **`HUB_DEFAULT_VIEW`.** This is the deployment's default for everyone who has
   not chosen. It is case- and space-tolerant, because it is typed into a secrets
   form.
4. **Their role.** admin → Expert, analyst → Standard, viewer or nobody → Simple.

Anything else is ignored, not trusted. That covers a cookie of `god-mode`, a
saved `42`, or an unknown deployment value.

People choose in two places:

- **Settings** (`/settings`) has three cards with what each view shows. It says
  where the current view came from and offers "Go back to the default".
- **The switch** at the bottom of the side rail.

Both call `setViewAction`, which:

- sets the cookie for a year (httpOnly; secure in production);
- saves the choice on the person's row when they have one;
- revalidates the layout.

Choosing null clears both.

For a firm whose people mostly ask and approve, set `HUB_DEFAULT_VIEW=simple`
on the deployment. Admins can then switch themselves to Expert in one click.

## How a page uses it

- **Server components** call `viewContext()` from `lib/viewServer.ts`. React's
  `cache` builds it once per request and returns
  `{ view, from, can, principal, saves }`. The root layout and the page share
  that one lookup.
- **Client components** call `useView()` from `components/ViewProvider.tsx` and
  get `{ view, can, atLeast }`. The layout sets the provider from the server's
  reading.

Rules when adding to a page:

- Internals go behind Expert. That means costs, models, token counts, tool names
  (`hub_skill_*`), slugs, JSON and env var names.
- Simple's words are for someone who has never heard of an agent loop. Say
  "passages from your documents", not "chunks"; "Connections", not "MCP".
- Never hide a failure. An error a Simple user would hit still shows, in plain
  words.
- Never use the view as a permission check. `can` (from `authorize`) gates
  buttons, and the server action checks again.

## Skills as forms

`components/SkillRunner.tsx` turns a skill's parameters into a short form:

- booleans become Yes/No;
- options become a select;
- long text (judged by name and description) becomes a box;
- everything else becomes a line.

**Run** calls `runSkillAction`. It is the same run path as the MCP tool and runs
as the signed-in person, with approvals and memory exactly as in a chat. The page
waits up to 40 seconds. After that, `runStatusAction` polls every 3 seconds for
up to 20 minutes. A run can only be read back by the person who started it; an
admin is refused too, because a run id is not a bearer token.

## Slides as fields

`app/decks/[id]/SlideFields.tsx` edits any slide kind without JSON:

- text becomes a field;
- a list of text becomes one line per item;
- numbers and booleans get their own inputs;
- anything nested keeps a small JSON box of its own.

It saves the same JSON the expert editor saves, so the server's checks do not
change.

## Verifying

`npm run verify:views -w web` needs `DATABASE_URL`. It uses no API key: a
stand-in Messages API answers the skill run. It stubs only the request:

- WorkOS's `withAuth`;
- the cookie jar;
- `next/cache`;
- `next/navigation`.

It renders the real pages per view and checks what each says and what it must
not say. In Simple that means no `hub_skill_`, no `$`, no "Spend", no "MCP", no
tokens, no model ids and no JSON. A control check confirms the same test trips
on the Expert home. It also covers:

- the resolution order;
- that a view never grants;
- the saved preference;
- running a skill and reading it back.

It cannot prove how the pages look. For that, take screenshots after
`npm run build`.
