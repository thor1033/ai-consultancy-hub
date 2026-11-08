// Views: how much of the hub a person is shown (lib/views.ts, docs/views.md),
// driven through the shipping pages, actions and database.
//
//   node --experimental-transform-types --env-file=.env.local verify-views.mjs
//
// Needs DATABASE_URL and a migrated database (principals.preferences). No API
// key and no spend: a throwaway HTTP server stands in for the Messages API when
// a skill is run from the page's action.
//
// Outside Next, the request is stubbed and nothing else: WorkOS's withAuth
// returns the person this script signs in as, next/headers holds a cookie jar
// it can read back, next/cache's revalidate is a no-op, and next/navigation's
// notFound throws as Next's does. Pages and components are the real files —
// TSX is transpiled on load by TypeScript itself — and async server components
// are awaited before React renders the tree to HTML.
//
// What is proven: the resolution order (your choice, then the deployment's,
// then your role's) and that bad values are ignored; that a view never grants
// (a viewer in Expert still cannot run or manage); the navigation per view and
// role; the choice saved on the person's row and in the cookie; and, per view,
// what each page says and — the point — what it must not: Simple shows no
// costs, models, tool names or control plane. A skill run from the page's
// action returns the agent's answer; a run is readable only by whoever started
// it; a person who may not run agents is refused. A Word file or PDF added on
// the Documents page lands as text, and every refusal is in words.
//
// What it cannot prove: how the pages look. That is a screenshot after
// `npm run build`.
import { registerHooks, createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// ── the request, stubbed ────────────────────────────────────────────────────
// The signed-in person and the browser's cookies live on globalThis, so the
// stub modules (data: URLs, which cannot import this file) can see them.
globalThis.__views = { user: null, cookies: new Map() };
const stub = (code) => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const STUBS = {
  "server-only": "export default null;",
  "@workos-inc/authkit-nextjs": "export async function withAuth() { return { user: globalThis.__views.user }; }",
  "next/headers": `
    export async function cookies() {
      const jar = globalThis.__views.cookies;
      return {
        get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name, value) => { jar.set(name, value); },
        delete: (name) => { jar.delete(name); },
      };
    }
    export async function headers() { return new Headers({ host: "hub.example", "x-forwarded-proto": "https" }); }`,
  "next/cache": "export function revalidatePath() {} export function revalidateTag() {}",
  "next/navigation": `
    export const useRouter = () => ({ push() {}, refresh() {}, replace() {}, back() {} });
    export const usePathname = () => "/";
    export const useSearchParams = () => new URLSearchParams();
    export function notFound() { const e = new Error("NEXT_NOT_FOUND"); e.digest = "NEXT_HTTP_ERROR_FALLBACK;404"; throw e; }
    export function redirect(to) { const e = new Error("NEXT_REDIRECT " + to); e.digest = "NEXT_REDIRECT;" + to; throw e; }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS[specifier] !== undefined) return stub(STUBS[specifier]);
    if (specifier.startsWith("@/")) {
      const base = new URL("./src/", import.meta.url);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier.slice(2) + ext, base);
        if (existsSync(fileURLToPath(url)) && (ext !== "" || /\.(tsx?|mjs|js)$/.test(url.pathname))) return { url: url.href, shortCircuit: true };
      }
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".")) return nextResolve(`${specifier}.js`, context);
      if (!context.parentURL) throw err;
      for (const ext of [".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    // Stylesheets are Next's to bundle; a page importing one gets nothing here.
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: fileURLToPath(url),
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=.env.local");
  process.exit(1);
}

const stamp = Date.now();
const PEOPLE = {
  admin: { id: `verify-views-admin-${stamp}`, email: `verify-views-admin-${stamp}@example.com`, roles: ["admin"] },
  analyst: { id: `verify-views-analyst-${stamp}`, email: `verify-views-analyst-${stamp}@example.com`, roles: ["analyst"] },
  viewer: { id: `verify-views-viewer-${stamp}`, email: `verify-views-viewer-${stamp}@example.com`, roles: ["viewer"] },
};
process.env.ALLOWED_EMAILS = Object.values(PEOPLE)
  .map((p) => p.email)
  .join(",");
delete process.env.HUB_DEFAULT_VIEW;
delete process.env.LANGFUSE_PUBLIC_KEY;

// ── the stand-in Messages API: answers every run with one known line ────────
const ANSWER = `Three things stand out (${stamp}).`;
const http = createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } });
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";

const React = (await import("react")).default;
// settle() rebuilds children arrays that React already keyed, so React warns
// about keys it never sees in a real render. Those warnings are this script's,
// not the pages'; anything else React reports still prints.
const consoleError = console.error;
console.error = (...args) => (/unique "key" prop/.test(String(args[0])) ? undefined : consoleError(...args));
const { renderToStaticMarkup } = await import("react-dom/server");
const views = await import("./src/lib/views.ts");
const db = await import("../../packages/db/src/index.ts");
const sql = db.getSql();

/** Await every async server component in the tree, so React renders plain elements. */
async function settle(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (typeof node.then === "function") return settle(await node);
  if (!React.isValidElement(node)) return node;
  const { type, props } = node;
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return settle(await type(props));
  const next = {};
  let changed = false;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "children" || React.isValidElement(v) || (Array.isArray(v) && v.some((x) => React.isValidElement(x) || Array.isArray(x)))) {
      next[k] = await settle(v);
      changed = true;
    } else if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && React.isValidElement(x.content))) {
      // Tabs: [{ id, label, content }] — content is a tree of its own.
      next[k] = await Promise.all(v.map(async (x) => (x && React.isValidElement(x.content) ? { ...x, content: await settle(x.content) } : x)));
      changed = true;
    }
  }
  return changed ? React.cloneElement(node, next) : node;
}

const text = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ");

const made = { agents: [] };
try {
  // ── 1. the rules, pure ─────────────────────────────────────────────────────
  console.log("— the rules —");
  const { resolveView, atLeast, navFor, defaultViewForRoles, isView, CAN_NOTHING } = views;
  check("role defaults: admin → expert, analyst → standard, viewer and nobody → simple",
    defaultViewForRoles(["admin"]) === "expert" && defaultViewForRoles(["analyst"]) === "standard" && defaultViewForRoles(["viewer"]) === "simple" && defaultViewForRoles([]) === "simple");
  const r = (o) => resolveView({ cookie: undefined, saved: undefined, deployment: undefined, roles: [], ...o });
  check("your cookie beats your saved choice", JSON.stringify(r({ cookie: "simple", saved: "expert", roles: ["admin"] })) === JSON.stringify({ view: "simple", from: "you" }));
  check("your saved choice beats the deployment's default", JSON.stringify(r({ saved: "expert", deployment: "simple" })) === JSON.stringify({ view: "expert", from: "you" }));
  check("the deployment's default beats the role's", JSON.stringify(r({ deployment: "simple", roles: ["admin"] })) === JSON.stringify({ view: "simple", from: "deployment" }));
  check("with nothing chosen, the role decides", JSON.stringify(r({ roles: ["analyst"] })) === JSON.stringify({ view: "standard", from: "role" }));
  check("a bad cookie, saved value or deployment value is ignored, not trusted",
    r({ cookie: "god-mode", saved: 42, deployment: "everything", roles: ["viewer"] }).view === "simple" && !isView("admin") && !isView(undefined));
  check("the deployment's value forgives case and spaces (it is typed into a secrets form)", r({ deployment: " Simple ", roles: ["admin"] }).view === "simple");
  check("atLeast orders the views", atLeast("expert", "standard") && atLeast("standard", "standard") && !atLeast("simple", "standard"));

  const can = (o) => ({ ...CAN_NOTHING, ...o });
  const hrefs = (v, c) => navFor(v, c).map((i) => i.href);
  const labels = (v, c) => navFor(v, c).map((i) => i.label);
  const full = can({ run: true, manage: true, admin: true, write: true });
  check("Simple's navigation: home, agents, approvals, documents, decks, settings — nothing more",
    JSON.stringify(hrefs("simple", full)) === JSON.stringify(["/", "/agents", "/approvals", "/knowledge", "/decks", "/settings"]), labels("simple", full).join(", "));
  check("Simple says Home and Documents", labels("simple", full).includes("Home") && labels("simple", full).includes("Documents"));
  check("Standard adds context, connections and admin, in plain names",
    hrefs("standard", full).includes("/context") && labels("standard", full).includes("Connections") && labels("standard", full).includes("Admin"));
  check("Expert names them as they are", labels("expert", full).includes("MCP servers") && labels("expert", full).includes("Control plane"));
  check("a view never adds what a role does not allow: Expert without admin has no control plane",
    !hrefs("expert", can({ run: true })).includes("/admin"));
  check("someone who may not run agents is not sent to approvals or decks in any view",
    ["simple", "standard", "expert"].every((v) => !hrefs(v, CAN_NOTHING).includes("/approvals") && !hrefs(v, CAN_NOTHING).includes("/decks")));

  // ── 2. the person's choice, saved ──────────────────────────────────────────
  console.log("\n— the choice, saved —");
  for (const p of Object.values(PEOPLE)) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: `Verify ${p.roles[0]}`, email: p.email });
  check("a new person has no preferences", JSON.stringify((await db.getPrincipal(PEOPLE.analyst.id))?.preferences) === "{}");
  await db.setPrincipalPreference(PEOPLE.analyst.id, "view", "simple");
  await db.setPrincipalPreference(PEOPLE.analyst.id, "other", 1);
  check("setPrincipalPreference saves one key and keeps the others",
    (await db.getPrincipal(PEOPLE.analyst.id))?.preferences?.view === "simple" && (await db.getPrincipal(PEOPLE.analyst.id))?.preferences?.other === 1);
  await db.setPrincipalPreference(PEOPLE.analyst.id, "view", null);
  const afterClear = (await db.getPrincipal(PEOPLE.analyst.id))?.preferences ?? {};
  check("null removes just that key", !("view" in afterClear) && afterClear.other === 1);
  check("a preference for nobody changes nothing and says so", (await db.setPrincipalPreference(`nobody-${stamp}`, "view", "simple")) === false);

  const { viewContext } = await import("./src/lib/viewServer.ts");
  const { setViewAction } = await import("./src/app/settings/actions.ts");
  const signIn = (p, cookie) => {
    globalThis.__views.user = p ? { id: `user_${p.id}`, email: p.email } : null;
    globalThis.__views.cookies = new Map(cookie ? [[views.VIEW_COOKIE, cookie]] : []);
  };

  signIn(PEOPLE.viewer, "expert");
  const viewerExpert = await viewContext();
  check("a viewer may choose Expert…", viewerExpert.view === "expert" && viewerExpert.from === "you");
  check("…and still may not run, manage, write or administer: a view never grants",
    !viewerExpert.can.run && !viewerExpert.can.manage && !viewerExpert.can.write && !viewerExpert.can.admin);
  signIn(PEOPLE.analyst);
  check("an analyst with nothing chosen gets Standard, from the role", (await viewContext()).view === "standard" && (await viewContext()).from === "role");
  check("and may run and write, not manage or administer",
    (await viewContext()).can.run && (await viewContext()).can.write && !(await viewContext()).can.manage && !(await viewContext()).can.admin);
  check("setViewAction refuses a view that does not exist", "error" in (await setViewAction("everything")));
  check("setViewAction chooses Simple", "ok" in (await setViewAction("simple")));
  check("it is kept in the browser's cookie", globalThis.__views.cookies.get(views.VIEW_COOKIE) === "simple");
  check("and on the person's row", (await db.getPrincipal(PEOPLE.analyst.id))?.preferences?.view === "simple");
  signIn(PEOPLE.analyst); // another browser: no cookie
  check("so another browser opens in it too", (await viewContext()).view === "simple" && (await viewContext()).saves === true);
  await setViewAction(null);
  check("going back to the default clears both", !globalThis.__views.cookies.has(views.VIEW_COOKIE) && !("view" in ((await db.getPrincipal(PEOPLE.analyst.id))?.preferences ?? {})));
  signIn(null);
  check("signed out, nothing is saved and nothing is allowed", "error" in (await setViewAction("simple")) && !(await viewContext()).can.run);
  process.env.HUB_DEFAULT_VIEW = "simple";
  signIn(PEOPLE.admin);
  check("HUB_DEFAULT_VIEW puts even an admin in Simple until they choose", (await viewContext()).view === "simple" && (await viewContext()).from === "deployment");
  delete process.env.HUB_DEFAULT_VIEW;

  // ── 3. the pages, per view ─────────────────────────────────────────────────
  console.log("\n— the pages, per view —");
  const agent = await db.createAgent({
    slug: `verify-views-${stamp}`,
    name: `Wren ${stamp}`,
    description: "Reads contracts and says what to watch for.",
    instructions: "Answer in one line.",
  });
  made.agents.push(agent);
  const skill = await db.createSkill({
    agentId: agent.id,
    slug: `verify-views-review-${stamp}`,
    name: "Review a contract",
    description: "What to watch for in a contract.",
    promptTemplate: "Review this contract: {{contract}}",
    parameters: [{ name: "contract", description: "The contract text", required: true }],
  });

  const { ViewProvider } = await import("./src/components/ViewProvider.tsx");
  const render = async (load, props = {}) => {
    const ctx = await viewContext();
    const { default: Page } = await load();
    try {
      const tree = await settle(React.createElement(Page, props));
      return text(renderToStaticMarkup(React.createElement(ViewProvider, { view: ctx.view, can: ctx.can }, tree)));
    } catch (err) {
      return /404/.test(String(err?.digest ?? err?.message)) ? "404" : `threw: ${err?.stack ?? err}`;
    }
  };
  const home = () => import("./src/app/page.tsx");
  const agents = () => import("./src/app/agents/page.tsx");
  const agentPage = () => import("./src/app/agents/[slug]/page.tsx");
  const settings = () => import("./src/app/settings/page.tsx");
  const admin = () => import("./src/app/admin/page.tsx");
  const slugProps = { params: Promise.resolve({ slug: agent.slug }) };
  const internals = [/hub_skill_/, /hub_agent_/, /\$\d/, /Spend/, /MCP/, /tokens?\b/i, /claude-[a-z]+-\d/, /JSON/];
  const leaks = (t) => internals.filter((re) => re.test(t)).map(String);

  signIn(PEOPLE.analyst, "simple");
  const sHome = await render(home);
  check("Simple home greets and offers help", /Good (morning|afternoon|evening), Verify\./.test(sHome) && /Who can help/.test(sHome), sHome.slice(0, 80));
  // Home shows the first six by name; the full list is the agents page, checked below.
  check("it lists agents with a way to talk to them, and a link to all of them", /Ask a question/.test(sHome) && /All agents/.test(sHome));
  check("it says what is waiting, in words", /Nothing is waiting for you|waiting for you/.test(sHome));
  check("it shows no internals — costs, models, tool names, MCP, JSON", leaks(sHome).length === 0, leaks(sHome).join(" "));
  const sAgents = await render(agents);
  check("Simple agents page is a directory, not an org chart", /Who can help\./.test(sAgents) && !/The company, by function/.test(sAgents) && sAgents.includes(agent.name));
  check("each agent has a way to talk to it, and one with skills a way to run a task", /Ask a question/.test(sAgents) && /Run a task/.test(sAgents) && sAgents.includes("Review a contract"));
  check("and shows no internals", leaks(sAgents).length === 0, leaks(sAgents).join(" "));
  const sAgent = await render(agentPage, slugProps);
  check("Simple agent page renders", !sAgent.startsWith("threw") && sAgent !== "404", sAgent.slice(0, 300));
  check("it has the conversation, your answers and the skills, with a Run button", /Your answers/.test(sAgent) && /Conversation/.test(sAgent) && /Skills/.test(sAgent) && /Review a contract/.test(sAgent) && /\bRun\b/.test(sAgent));
  check("it has no Settings, Memory or Hand-offs tab and no figures", !/\bSettings\b/.test(sAgent) && !/Hand-offs/.test(sAgent) && !/\bMemory\b/.test(sAgent));
  check("and shows no internals", leaks(sAgent).length === 0, leaks(sAgent).join(" "));
  const sSettings = await render(settings);
  check("Settings offers all three views and marks the current one",
    /Simple/.test(sSettings) && /Standard/.test(sSettings) && /Expert/.test(sSettings) && /Simple Current|SimpleCurrent/.test(sSettings.replace(/\s+/g, " ")), sSettings.match(/Simple[^.]{0,20}/)?.[0]);
  check("and says where the choice came from", /You chose it/.test(sSettings));

  signIn(PEOPLE.analyst, "standard");
  const stHome = await render(home);
  check("Standard home is the overview, with the week's figures", !/Who can help/.test(stHome) && /Latest runs|Needs attention|Activity/.test(stHome));
  check("Standard home says Connections, not tool servers", !/Tool servers/.test(stHome));
  const stAgents = await render(agents);
  check("Standard agents page is the org chart", /The company, by function/.test(stAgents));
  const stAgent = await render(agentPage, slugProps);
  check("Standard agent page adds Overview, Memory and Settings", /Overview/.test(stAgent) && /Memory/.test(stAgent) && /Settings/.test(stAgent));
  check("but not hand-offs or tool names", !/Hand-offs/.test(stAgent) && !/hub_skill_/.test(stAgent));

  signIn(PEOPLE.analyst, "expert");
  // The control for every "shows no internals" above: the same test, on a page that should trip it.
  const exHome = await render(home);
  check("the internals test can fail: Expert home trips it", leaks(exHome).length > 0, leaks(exHome).join(" "));
  const exAgent = await render(agentPage, slugProps);
  check("Expert agent page shows the skill's tool name and the hand-offs tab", /hub_skill_/.test(exAgent) && /Hand-offs/.test(exAgent));

  signIn(PEOPLE.admin, "standard");
  const stAdmin = await render(admin);
  check("Admin in Standard is about people, without the tool-server registry", /People and access/.test(stAdmin) && !/MCP servers/.test(stAdmin) && !/Control plane/.test(stAdmin));
  signIn(PEOPLE.admin, "expert");
  const exAdmin = await render(admin);
  check("Admin in Expert is the control plane, with the registry", /Control plane/.test(exAdmin) && /MCP servers/.test(exAdmin));

  // ── 3b. one agent or a team: the chooser (docs/effective-agents-review.md, A1) ──
  console.log("\n— one agent or a team —");
  const choose = () => import("./src/app/agents/choose/page.tsx");
  const patternsPage = () => import("./src/app/agents/patterns/page.tsx");
  const newAgent = () => import("./src/app/agents/new/page.tsx");
  const { PATTERNS, CHEAPER_MODEL } = await import("../../packages/db/src/index.ts");
  signIn(PEOPLE.analyst, "simple");
  const sChoose = await render(choose);
  const firstRow = sChoose.indexOf("One agent.");
  check("the chooser puts one agent first, before any team", firstRow > 0 && PATTERNS.every((p) => sChoose.indexOf(p.question) > firstRow), sChoose.slice(0, 160));
  check("every pattern's question is on it, in the pattern's own words", PATTERNS.every((p) => sChoose.includes(p.question) && sChoose.includes(p.summary)));
  check("in Simple it names no nicknames and shows no internals", !/Cluster|Elephant|Critic loop|Assembly line/.test(sChoose) && leaks(sChoose).length === 0, leaks(sChoose).join(" "));
  signIn(PEOPLE.admin, "expert");
  const exChoose = await render(choose);
  check("in Expert the nicknames are there", PATTERNS.every((p) => exChoose.includes(p.nickname)));
  const deep = await render(patternsPage, { searchParams: Promise.resolve({ pattern: "front-desk" }) });
  // The open pattern's section reads name, nickname, summary; the nav reads nickname, name — so the order tells them apart.
  check("the chooser's link opens that pattern on the patterns page", /One door, many specialists Front desk One agent people ask/.test(deep), deep.slice(deep.indexOf("Front desk One agent") - 60, deep.indexOf("Front desk One agent") + 40));
  const bogus = await render(patternsPage, { searchParams: Promise.resolve({ pattern: "no-such-pattern" }) });
  check("an unknown pattern in the link opens the first, not an error", !bogus.startsWith("threw") && /Long memory, short hands Elephant & goldfish An archivist/.test(bogus));
  check("the patterns page says one agent is enough for most jobs, and links the chooser", /Most jobs need one agent/.test(bogus) && /Not sure which shape/.test(bogus) && !/Hire a team, not an agent/.test(bogus));
  signIn(PEOPLE.analyst, "simple");
  const sNew = await render(newAgent);
  check("New agent below Expert points at the chooser, not straight at a team", /Not sure one agent is enough/.test(sNew) && !/ready-made team/.test(sNew.slice(0, sNew.indexOf("Not sure one agent"))));
  const { BRIEF_TEMPLATE } = await import("./src/app/agents/briefTemplate.ts");
  check("the brief template is headed sections that end with a self-check", /^## Who you are/m.test(BRIEF_TEMPLATE) && /## What a good answer looks like/.test(BRIEF_TEMPLATE) && /ONE example/.test(BRIEF_TEMPLATE) && /## Before you answer/.test(BRIEF_TEMPLATE) && /what you did not do/.test(BRIEF_TEMPLATE));
  const { MODELS } = await import("./src/app/agents/models.ts");
  check("the model list names the cheaper model as the one a team's bounded roles get", MODELS.some((m) => m.id === CHEAPER_MODEL && /worker|specialist|reviewer/.test(m.note)));

  // ── 3c. brief health and the memory budget (docs/effective-agents-review.md, B1, B3) ──
  console.log("\n— brief health —");
  const { briefHealth } = await import("./src/app/agents/briefHealth.ts");
  const catalog = [{ name: "pm-tool", label: "PM-tool" }, { name: "microsoft365", label: "Microsoft 365" }];
  const clean = briefHealth({ instructions: "## Who you are\nYou answer contract questions.\n\n## What a good answer looks like\nShort, with the clause. For example: \"Clause 4.2 lets either side end it with 30 days' notice.\"", servers: ["pm-tool"], catalog, keepsMemory: true, asks: [] });
  check("a short, headed brief with an example gets no hints", clean.hints.length === 0 && clean.words > 0 && clean.tokens > 0, clean.hints.join(" | "));
  const long = briefHealth({ instructions: "word ".repeat(14000), servers: [], catalog, keepsMemory: true, asks: [] });
  check("a very long brief is told what it costs on every turn", long.hints.some((h) => /read again on every turn/.test(h) && /reference material/.test(h)), long.hints.join(" | "));
  const bare = briefHealth({ instructions: "You are the delivery lead. ".repeat(40), servers: [], catalog, keepsMemory: true, asks: [] });
  check("a brief with no example and no headings is told so", bare.hints.some((h) => /No example of a good answer/.test(h)) && bare.hints.some((h) => /No headed sections/.test(h)), bare.hints.join(" | "));
  const unticked = briefHealth({ instructions: "Check PM-tool for the live status before answering.", servers: [], catalog, keepsMemory: false, asks: [] });
  check("a tool named in the brief but not given is pointed out", unticked.hints.some((h) => /Mentions PM-tool, but is not given it/.test(h)), unticked.hints.join(" | "));
  const noMem = briefHealth({ instructions: "Check your memory first, then answer.", servers: [], catalog, keepsMemory: false, asks: [] });
  check("talk of memory on an agent that keeps none is pointed out", noMem.hints.some((h) => /keeps none/.test(h)));
  const askNobody = briefHealth({ instructions: "Use agents_ask to get the Legal agent's view.", servers: [], catalog, keepsMemory: true, asks: [] });
  check("so is asking when it may ask nobody", askNobody.hints.some((h) => /may ask nobody/.test(h)));
  const rules = briefHealth({ instructions: "Always cite. Never guess. Always check. Never write. Always ask. Never assume. Always list. ".repeat(3), servers: [], catalog, keepsMemory: true, asks: [] });
  check("a brief that is mostly always and never is told it is brittle", rules.hints.some((h) => /absolute rules/.test(h)), rules.hints.join(" | "));
  check("an empty brief gets none", briefHealth({ instructions: "   ", servers: [], catalog, keepsMemory: true, asks: [] }).hints.length === 0);

  const { MemoryPanel } = await import("./src/app/agents/[slug]/MemoryPanel.tsx");
  const fake = (n, active) => Array.from({ length: n }, (_, i) => ({ id: `m${i}-${active}`, key: `key-${i}`, content: "a fact the agent keeps about a client ".repeat(12), active, scope: "agent", scopeRef: "", keptFor: "Shared", updatedAt: new Date().toISOString(), region: null, writtenBy: null, sourceRunId: null, createdAt: new Date().toISOString(), agentId: "x" }));
  const panel = (memories) => text(renderToStaticMarkup(React.createElement(ViewProvider, { view: "standard", can: CAN_NOTHING }, React.createElement(MemoryPanel, { agentId: "x", name: "Agent", memories }))));
  const light = panel([...fake(3, true), ...fake(2, false)]);
  check("the Memory tab says how much is read before every answer, in words", /3 memories are read before every answer — about [\d,]+ words/.test(light) && !/a lot to carry/.test(light), light.slice(0, 120));
  check("and warns when it is a lot", /a lot to carry/.test(panel(fake(25, true))));

  // ── 4. the navigation, rendered ────────────────────────────────────────────
  const { Sidebar } = await import("./src/components/Sidebar.tsx");
  const nav = async () => {
    const ctx = await viewContext();
    return text(renderToStaticMarkup(React.createElement(ViewProvider, { view: ctx.view, can: ctx.can }, React.createElement(Sidebar))));
  };
  signIn(PEOPLE.admin, "simple");
  const sNav = await nav();
  check("the rail in Simple: Home and Documents, no connections or control plane, a way to switch",
    /Home/.test(sNav) && /Documents/.test(sNav) && !/MCP servers|Connections|Control plane|Admin\b/.test(sNav) && /Simple/.test(sNav) && /Expert/.test(sNav), sNav.slice(0, 200));
  signIn(PEOPLE.admin, "expert");
  const exNav = await nav();
  check("the rail in Expert: MCP servers and the control plane", /MCP servers/.test(exNav) && /Control plane/.test(exNav));
  signIn(PEOPLE.viewer, "expert");
  const vNav = await nav();
  check("a viewer in Expert sees no control plane and no approvals", !/Control plane/.test(vNav) && !/Approvals/.test(vNav));

  // ── 5. running a skill from the page ───────────────────────────────────────
  console.log("\n— running a skill from the page —");
  const { runSkillAction, runStatusAction } = await import("./src/app/agents/actions.ts");
  signIn(PEOPLE.viewer, "simple");
  const refused = await runSkillAction(skill.id, { contract: "x" });
  check("someone who may not run agents is refused, in words", refused.status === "failed" && refused.error.length > 0, refused.error);
  signIn(PEOPLE.analyst, "simple");
  const ran = await runSkillAction(skill.id, { contract: "The supplier may raise prices at will.", ignored: { nested: true } });
  check("an analyst runs the skill and gets the agent's answer", ran.status === "done" && ran.output.includes(ANSWER), JSON.stringify(ran).slice(0, 160));
  const status = ran.runId ? await runStatusAction(ran.runId) : null;
  check("the run can be read back by whoever started it", status?.status === "done" && status.output.includes(ANSWER));
  const [row] = ran.runId ? await sql`select principal_id from agent_sessions where id = ${ran.runId}` : [];
  check("it ran as that person", row?.principal_id === PEOPLE.analyst.id);
  signIn(PEOPLE.admin, "expert");
  const theirs = ran.runId ? await runStatusAction(ran.runId) : null;
  check("another person, even an admin, cannot read it by its id", theirs?.status === "failed" && /not one of yours/.test(theirs.error));
  // "Your answers": the person's own runs, with what came back, and nobody else's.
  signIn(PEOPLE.analyst, "simple");
  const mineHtml = await render(agentPage, slugProps);
  check("the analyst's agent page lists the run under Your answers, with the answer", /Your answers/.test(mineHtml) && mineHtml.includes(ANSWER) && /Review a contract/.test(mineHtml), mineHtml.slice(0, 400));
  // The loop on one line (docs/skill-tests.md): Simple has no link to the run's numbers and no Tests; Standard has the link; managing has the case and the Tests button.
  check("in Simple there is no 'what went wrong' link and no Tests button", !/What went wrong/.test(mineHtml) && !/\bTests\b/.test(mineHtml));
  signIn(PEOPLE.analyst, "standard");
  const mineStd = await render(agentPage, slugProps);
  check("in Standard the answer links to its run, but an analyst who may not manage sees no Save as a test case and no Tests", /What went wrong\? See the run/.test(mineStd) && !/Save as a test case/.test(mineStd) && !/\bTests\b/.test(mineStd));
  signIn(PEOPLE.admin, "standard");
  const adminStd = await render(agentPage, slugProps);
  check("someone who may manage sees a Tests button on the skill", /\bTests\b/.test(adminStd));
  check("the Settings tab offers The web among the tool servers, with its cost in words", /The web/.test(adminStd) && /Every search is billed/.test(adminStd));
  check("and a Download SKILL.md link", /Download SKILL\.md/.test(adminStd));
  // The download itself (docs/skill-import.md, "Export"): the same door as the skill's page.
  const { GET: downloadSkill } = await import("./src/app/agents/[slug]/skills/[skill]/SKILL.md/route.ts");
  const dl = await downloadSkill(new Request("http://hub.test/x"), { params: Promise.resolve({ slug: agent.slug, skill: skill.slug }) });
  check("the SKILL.md route serves the skill as a Markdown attachment", dl.status === 200 && /text\/markdown/.test(dl.headers.get("content-type")) && dl.headers.get("content-disposition") === 'attachment; filename="SKILL.md"' && (await dl.text()).includes(`name: ${skill.slug}`), String(dl.status));
  check("and 404s for a skill that is not that agent's, and refuses someone signed out", (await downloadSkill(new Request("http://hub.test/x"), { params: Promise.resolve({ slug: agent.slug, skill: "nothing" }) })).status === 404 && (signIn(null), (await downloadSkill(new Request("http://hub.test/x"), { params: Promise.resolve({ slug: agent.slug, skill: skill.slug }) })).status === 401));
  signIn(PEOPLE.admin, "standard");
  check("listMyRuns returns only the person's own runs", (await db.listMyRuns(agent.id, PEOPLE.analyst.id)).length === 1 && (await db.listMyRuns(agent.id, PEOPLE.admin.id)).length === 0);
  signIn(PEOPLE.admin, "expert");
  const adminHtml = await render(agentPage, slugProps);
  check("an admin on the same page does not see the analyst's answer", /Your answers/.test(adminHtml) && !adminHtml.includes(ANSWER));
  signIn(PEOPLE.analyst, "simple");
  check("an unknown skill fails in words", (await runSkillAction("00000000-0000-0000-0000-000000000000", {})).status === "failed");

  // ── 6. a file on the Documents page ────────────────────────────────────────
  console.log("\n— a file on the Documents page —");
  const { addFileAction } = await import("./src/app/knowledge/actions.ts");
  const { zipSync, strToU8 } = await import("fflate");
  const upload = (name, bytes, fields = {}) => {
    const form = new FormData();
    form.set("file", new File([bytes], name));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return addFileAction(form);
  };
  const docx = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Refund policy ${stamp}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Refunds within 30 days &amp; no questions.</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
  const pdf = (line) => {
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    const stream = line ? `BT /F1 18 Tf 20 100 Td (${line}) Tj ET` : "";
    objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let out = "%PDF-1.4\n";
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return strToU8(out);
  };
  const uploaded = async (title) => (await sql`select id, title, source, source_type, collection from documents where title = ${title}`)[0];

  signIn(PEOPLE.viewer, "simple");
  const viewerUp = await upload(`Policy ${stamp}.docx`, docx);
  check("someone who may not add documents is refused", "error" in viewerUp && !(await uploaded(`Policy ${stamp}`)), viewerUp.error);
  signIn(PEOPLE.analyst, "simple");
  const word = await upload(`Policy ${stamp}.docx`, docx, { collection: `verify-views-${stamp}` });
  const wordRow = await uploaded(`Policy ${stamp}`);
  check("a Word file is added, titled from its name, in the folder chosen", !("error" in word) && wordRow?.source === `Policy ${stamp}.docx` && wordRow?.collection === `verify-views-${stamp}`, "error" in word ? word.error : "");
  check("and marked as an upload", wordRow?.source_type === "upload");
  const wordText = wordRow ? (await sql`select string_agg(content, ' ') as t from document_chunks where document_id = ${wordRow.id}`)[0]?.t ?? "" : "";
  check("its text is what was read from the file, heading kept", wordText.includes(`# Refund policy ${stamp}`) && wordText.includes("Refunds within 30 days & no questions."), wordText.slice(0, 80));
  const named = await upload(`notes-${stamp}.pdf`, pdf(`Price list ${stamp}`), { title: `Prices ${stamp}` });
  const pdfRow = await uploaded(`Prices ${stamp}`);
  const pdfText = pdfRow ? (await sql`select string_agg(content, ' ') as t from document_chunks where document_id = ${pdfRow.id}`)[0]?.t ?? "" : "";
  check("a PDF is read to text, under the title given", !("error" in named) && pdfText.includes(`Price list ${stamp}`), "error" in named ? named.error : pdfText.slice(0, 60));
  const scanned = await upload(`scan-${stamp}.pdf`, pdf(""));
  check("a PDF with no text is refused as probably scanned, in words", "error" in scanned && /scanned pages/.test(scanned.error), scanned.error);
  const old = await upload(`old-${stamp}.doc`, strToU8("binary"));
  check("an old .doc is refused, naming what can be read", "error" in old && /Word \(\.docx\)/.test(old.error) && /current format/.test(old.error));
  const broken = await upload(`broken-${stamp}.docx`, strToU8("not a zip"));
  check("a broken file says it could not be read", "error" in broken && /Could not read/.test(broken.error), broken.error);
  const big = await upload(`big-${stamp}.txt`, new Uint8Array(15 * 1024 * 1024 + 1).fill(97));
  check("a file over the limit is refused with the limit", "error" in big && /limit is 15 MB/.test(big.error), big.error);
  check("nothing was added for any refused file", (await sql`select count(*)::int as n from documents where source = any(${["scan", "old", "broken", "big"].map((n) => `${n}-${stamp}`).flatMap((b) => [`${b}.pdf`, `${b}.doc`, `${b}.docx`, `${b}.txt`])})`)[0].n === 0);

  // ── 7. the agent form saves through the shared rules ───────────────────────
  console.log("\n— the agent form —");
  const { saveAgentAction, saveSkillAction } = await import("./src/app/agents/actions.ts");
  signIn(PEOPLE.analyst, "standard");
  const refusedSave = await saveAgentAction(null, { slug: "", name: `Form ${stamp}` });
  check("someone who may not manage agents cannot save one from the form", "error" in refusedSave && !(await db.getAgent(`form-${stamp}`)));
  signIn(PEOPLE.admin, "expert");
  const formSaved = await saveAgentAction(null, { slug: "", name: `Form ${stamp}`, description: "From the form", instructions: "Brief.", model: "", mcpServers: [{ name: "microsoft365" }], knowledgeCollections: [], knowledgeAll: false, keepsMemory: true });
  const formRow = await db.getAgent(`form-${stamp}`);
  if (formRow) made.agents.push(formRow);
  check("an admin saves a new agent from the form", "ok" in formSaved && formRow?.description === "From the form" && formRow?.mcpServers?.some((e) => e.name === "microsoft365"), JSON.stringify(formSaved));
  const formEdit = await saveAgentAction(formRow.id, { slug: formRow.slug, name: formRow.name, description: "Edited", instructions: "Brief.", model: "claude-opus-4-8", mcpServers: [{ name: "microsoft365" }], knowledgeCollections: [], knowledgeAll: false, keepsMemory: true });
  check("and edits it", "ok" in formEdit && (await db.getAgent(formRow.id))?.description === "Edited" && (await db.getAgent(formRow.id))?.model === "claude-opus-4-8");
  const formSkill = await saveSkillAction({ agentId: formRow.id, slug: `form-skill-${stamp}`, name: "Form skill", description: "", promptTemplate: "Do {{x}}", parameters: [{ name: "x", description: "" }] });
  check("and gives it a skill", "skills" in formSkill && formSkill.skills.length === 1, JSON.stringify(formSkill).slice(0, 120));
  const crossSkill = await saveSkillAction({ id: formSkill.skills?.[0]?.id, agentId: agent.id, slug: `form-skill-${stamp}`, name: "Hijacked", description: "", promptTemplate: "x", parameters: [] });
  check("a skill id saved under another agent is refused before anything changes", "error" in crossSkill && (await db.listSkills(formRow.id))[0]?.name === "Form skill", JSON.stringify(crossSkill));
} finally {
  await sql`delete from documents where (title like ${`%${stamp}%`} or source like ${`%${stamp}%`}) and source_type = 'upload'`.catch(() => {});
  await sql`delete from agent_sessions where principal_id = any(${Object.values(PEOPLE).map((p) => p.id)})`.catch(() => {});
  for (const a of made.agents) await db.deleteAgent(a.id).catch(() => {});
  await sql`delete from principals where id = any(${Object.values(PEOPLE).map((p) => p.id)})`.catch(() => {});
  await sql.end({ timeout: 5 });
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: how the pages look — screenshot them after npm run build.");
