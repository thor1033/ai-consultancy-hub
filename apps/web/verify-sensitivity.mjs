// Sensitivity labels, detection, egress and the read log (docs/sensitivity.md,
// docs/data-protection-review.md 2.3–2.5 and F11), driven through the shipping
// run path, memory and knowledge servers, the hub's MCP server, a local
// agent's server, the REST routes, the actions and the pages.
//
//   node --experimental-transform-types --env-file=.env.local verify-sensitivity.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend: a
// throwaway HTTP server stands in for the Messages API (it does what each
// prompt says: "WRITE key :: content", "ASK slug :: task", anything else is
// echoed back as the answer) and for Langfuse's ingestion endpoint, so what a
// run sends to tracing is counted. Retrieval takes the nearest passages with
// no threshold, so each agent's one curated collection is what it retrieves.
//
// One step is global, as in verify:retention: the read log's expiry is proven
// by a sweep, which applies the whole policy to the whole database (with the
// transcript and answer periods at their maximum, so only audit entries and
// read-log entries over a year old go). Run it on a development database.
//
// What is proven: the detector finds CPR numbers by their date, card numbers
// by Luhn and IBANs by mod-97, and leaves look-alikes alone; a memory carrying
// one is refused by the gate, the memory server, the store and the hub's
// memory tool, and nothing is written; what is stored about a run is masked
// while the live answer is not; labels are admin-only, audited, and a labelled
// collection cannot be open; a run that touched special material has no
// memory, no transcript and no trace, and is told why; a confidential
// collection's memory stays with its readers even if the collection is
// opened behind the hub's back; a follow-up in a chat, a hand-off and an asked
// agent carry the label on; the hub's MCP server, a local agent and the REST
// routes do not return labelled material and replace a labelled answer with a
// link; the Context Steward does not read labelled conversations; every read
// of labelled material — by a run, a chat, the Documents page — is logged,
// shown to admins, exported, erased with the person and swept with the audit
// trail.
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
const P = (key, roles) => ({ id: `verify-sens-${key}-${stamp}`, email: `verify-sens-${key}-${stamp}@example.com`, roles, name: `Verify ${key}` });
const A = P("ana", ["analyst"]);
const B = P("bo", ["analyst"]);
const ADMIN = P("admin", ["admin"]);
process.env.ALLOWED_EMAILS = [A, B, ADMIN].map((p) => p.email).join(",");
delete process.env.HUB_DEFAULT_VIEW;
delete process.env.HUB_DEFAULT_COLLECTION_VISIBILITY;
delete process.env.HUB_TRACE_CONTENT;

// ── the stand-in Messages API and Langfuse ──────────────────────────────────
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n"));
const requests = [];
let ingested = 0;
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  if (req.url?.includes("/api/public/")) {
    ingested++;
    res.writeHead(207, { "content-type": "application/json" });
    res.end(JSON.stringify({ successes: [], errors: [] }));
    return;
  }
  const body = JSON.parse(raw || "{}");
  requests.push({ system: textOf(body.system), tools: (body.tools ?? []).map((t) => t.name) });
  const firstUser = [...body.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string")?.content ?? "";
  const last = body.messages.at(-1);
  const lastResult = last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? textOf(last.content) : null;
  let block = null;
  if (!lastResult) {
    const w = firstUser.match(/^WRITE (\S+) :: ([\s\S]+)$/);
    const a = firstUser.match(/^ASK (\S+) :: ([\s\S]+)$/);
    if (w) block = { name: "memory_write", input: { key: w[1], content: w[2] } };
    else if (a) block = { name: "agents_ask", input: { agent: a[1], task: a[2] } };
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  if (block) {
    send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: block.name, input: {} } });
    send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
  } else {
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: lastResult !== null ? `RESULT ${lastResult}` : `ANSWER ${firstUser}` } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  }
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const FIXTURE = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_BASE_URL = FIXTURE;
process.env.ANTHROPIC_API_KEY = "fixture-key";
// Tracing on, pointed at the fixture: a run that is traced is counted there.
process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-fixture";
process.env.LANGFUSE_SECRET_KEY = "sk-lf-fixture";
process.env.LANGFUSE_HOST = FIXTURE;
process.env.LANGFUSE_BASEURL = FIXTURE;

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

const signIn = (who, view) => {
  globalThis.__views.user = who ? { id: `user_${who.email}`, email: who.email } : null;
  globalThis.__views.cookies = new Map(view ? [[views.VIEW_COOKIE, view]] : []);
};
const { ViewProvider } = await import("./src/components/ViewProvider.tsx");
const { viewContext } = await import("./src/lib/viewServer.ts");
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


const I = `verify-sens-internal-${stamp}`;
const C = `verify-sens-confidential-${stamp}`;
const S = `verify-sens-special-${stamp}`;
const made = { agents: [], documents: [] };
const asP = (p) => ({ id: p.id, roles: p.roles, source: "oauth", email: p.email });
const CPR = "010190-1234";
const IBAN = "DK5000400440116243";
const CARD = "4111 1111 1111 1111";
let teamsBefore = null;

try {
  // ── the detector ─────────────────────────────────────────────────────────
  console.log("— the detector —");
  const detect = await import("../../packages/mcp/servers/detect.mjs");
  const kinds = (t) => detect.findIdentifiers(t).map((s) => s.kind).join(",");
  check("a CPR number is found, with or without its dash", kinds(`CPR ${CPR}`) === "cpr" && kinds("CPR 0101901234") === "cpr");
  check("but not one whose date does not exist (32 January, 29 February 2001)", kinds("320190-1234") === "" && kinds("290201-4123") === "");
  check("29 February in a leap year, by the century digit, is", kinds("290200-4123") === "cpr");
  check("a card number is found when it passes Luhn, and not when it does not", kinds(CARD) === "card" && kinds("4111 1111 1111 1112") === "");
  check("an IBAN is found when it passes mod-97, grouped or not", kinds(IBAN) === "iban" && kinds("DK50 0040 0440 1162 43") === "iban" && kinds("DK5000400440116244") === "");
  check("phone numbers, order numbers and dates are left alone", kinds("call 12 34 56 78, order 1234567890, due 2024-01-01") === "");
  const deep = detect.maskDeep([{ role: "user", content: [{ type: "tool_result", content: `card ${CARD}` }] }]);
  check("a transcript is masked all the way down", deep.masked === 1 && !JSON.stringify(deep.value).includes("4111"));

  // ── fixtures ─────────────────────────────────────────────────────────────
  const rag = await import("../../packages/rag/src/index.ts");
  const { runAgentForPrincipal } = await import("./src/lib/agentRuns.ts");
  for (const p of [A, B, ADMIN]) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.name, email: p.email });
  await db.upsertCollection({ name: I, visibility: "open" });
  await db.upsertCollection({ name: C, visibility: "restricted" });
  await db.upsertCollection({ name: S, visibility: "open" });
  for (const n of [C, S]) await db.grantCollection(n, A.id, "verify");
  const doc = async (title, content, collection) => {
    const id = (await rag.ingestDocument({ title, content, collection })).documentId;
    made.documents.push(id);
    return id;
  };
  const dI = await doc(`Handbook ${stamp}`, "The office opens at nine.", I);
  const dC = await doc(`Salaries ${stamp}`, "Ana earns fifty thousand a month.", C);
  await doc(`Sick leave ${stamp}`, "Bo was on sick leave for stress in March.", S);
  const agent = async (key, input) => {
    const a = await db.createAgent({ slug: `verify-sens-${key}-${stamp}`, name: `Sens ${key}`, instructions: "x", ...input });
    made.agents.push(a.id);
    return a;
  };
  const AI = await agent("internal", { knowledgeCollections: [I] });
  const AC = await agent("confidential", { knowledgeCollections: [C] });
  const AS = await agent("special", { knowledgeCollections: [S] });
  const AN = await agent("none", { knowledgeCollections: [] });
  const AP = await agent("asker", { knowledgeCollections: [], mcpServers: [{ name: "agents", agents: [AS.slug] }] });
  const run = (a, who, prompt, extra = {}) => runAgentForPrincipal({ agentRef: a.slug, prompt, principal: asP(who), ...extra });
  const row = async (id) => (await sql`select prompt, output, error, transcript, sensitivity, transcript_dropped_at as dropped from agent_sessions where id = ${id}`)[0];
  const memories = async (a) => db.listMemories(a.id);

  // ── labels: who may set them, and what they may not say ──────────────────
  console.log("\n— labels —");
  const access = await import("./src/app/admin/accessActions.ts");
  const mcpActions = await import("./src/app/mcp/actions.ts");
  signIn(B);
  check("an analyst cannot label a collection", "error" in (await access.setCollectionSensitivityAction(C, "confidential")));
  check("or a connection", "error" in (await mcpActions.setServerSensitivityAction("teams", "confidential")));
  signIn(ADMIN);
  const openLabel = await access.setCollectionSensitivityAction(S, "special");
  check("an open collection cannot be labelled — restrict it first", "error" in openLabel && /Restrict it first/.test(openLabel.error), openLabel.error);
  await access.setCollectionVisibilityAction(S, "restricted");
  check("an admin labels a restricted one", !("error" in (await access.setCollectionSensitivityAction(S, "special"))) && !("error" in (await access.setCollectionSensitivityAction(C, "confidential"))));
  const [labelled] = await sql`select detail from auth_events where event = 'collection.sensitivity' and actor = ${ADMIN.email} order by at desc limit 1`;
  check("on the audit trail", labelled?.detail?.collection === C && labelled?.detail?.sensitivity === "confidential", JSON.stringify(labelled?.detail));
  const reopen = await access.setCollectionVisibilityAction(C, "open");
  check("and a labelled collection cannot then be opened to everyone", "error" in reopen && (await db.restrictedCollectionNames()).includes(C), reopen.error);
  teamsBefore = (await db.serverSensitivities()).get("teams") ?? "internal";
  check("an admin labels a connection", (await mcpActions.setServerSensitivityAction("teams", "confidential")).ok === true && (await db.serverSensitivities()).get("teams") === "confidential");
  const [connLabel] = await sql`select detail from auth_events where event = 'connection.sensitivity' and actor = ${ADMIN.email} order by at desc limit 1`;
  check("also on the audit trail", connLabel?.detail?.connection === "teams");

  // ── never in memory ──────────────────────────────────────────────────────
  console.log("\n— identifiers are never remembered —");
  const r0 = await run(AN, A, `WRITE cpr-${stamp} :: Ana's CPR number is ${CPR}.`);
  check("a run's memory write carrying a CPR number is refused, and the agent told why", /Not remembered: it contains a CPR number/.test(r0.output ?? ""), (r0.output ?? "").slice(0, 120));
  check("and nothing was written", !(await memories(AN)).some((m) => m.key === `cpr-${stamp}`));
  await run(AN, A, `WRITE fine-${stamp} :: The client prefers Tuesdays.`);
  check("a memory without one is written as before", (await memories(AN)).some((m) => m.key === `fine-${stamp}`));
  const { connectMcpServers, memoryServerConfig, builtinServerConfig } = await import("../../packages/mcp/src/index.ts");
  const direct = await connectMcpServers([memoryServerConfig(AN.id, { principalId: A.id, collections: { kind: "allow", collections: [] } })]);
  try {
    const out = await direct.execute("memory_write", { key: `iban-${stamp}`, content: `Pay to ${IBAN}.` });
    check("the memory server refuses one on its own, whoever calls it", /bank account number \(IBAN\)/.test(out) && !(await memories(AN)).some((m) => m.key === `iban-${stamp}`), out);
  } finally {
    await direct.close();
  }
  let threw = "";
  try {
    await db.rememberMemory(AN.id, `card-${stamp}`, `Card ${CARD}`);
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  check("and so does the store", /payment card number/.test(threw), threw);

  const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
  const { buildAgentMcpServer } = await import("./src/lib/mcp/agentServer.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const connect = async (server) => {
    const client = new Client({ name: "verify", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return client;
  };
  const call = async (client, name, args) => (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? "";
  const hubA = await connect(await buildHubMcpServer({ ...asP(A), source: "credential", agentId: AN.slug }, { baseUrl: "https://hub.example" }));
  check("and the hub's memory tool for Claude Code", /CPR number/.test(await call(hubA, "hub_memory_write", { key: `hub-${stamp}`, content: `CPR ${CPR}` })) && !(await memories(AN)).some((m) => m.key === `hub-${stamp}`));

  // ── masked at rest ───────────────────────────────────────────────────────
  console.log("\n— masked at rest —");
  const r1 = await run(AN, A, `Pay ${IBAN} with card ${CARD}; CPR ${CPR}.`);
  const s1 = await row(r1.runId);
  check("the live answer is not changed", (r1.output ?? "").includes(IBAN) && (r1.output ?? "").includes(CPR));
  check("the stored question is masked", s1.prompt.includes("[IBAN removed]") && s1.prompt.includes("[card number removed]") && s1.prompt.includes("[CPR number removed]") && !s1.prompt.includes(IBAN), s1.prompt);
  check("so is the stored answer", (s1.output ?? "").includes("[IBAN removed]") && !(s1.output ?? "").includes(CPR));
  const raw1 = JSON.stringify(s1.transcript);
  check("and the transcript", raw1.length > 2 && !raw1.includes(IBAN) && !raw1.includes("4111") && raw1.includes("[CPR number removed]"));
  const failed = await db.startRun({ prompt: "x", agentId: AN.id, principalId: A.id });
  await db.failRun(failed, `Upstream said: no account ${IBAN}`);
  check("and a failed run's error", (await row(failed)).error === "Upstream said: no account [IBAN removed]");
  check("an ordinary run stays internal, and is traced", s1.sensitivity === "internal" && ingested > 0, `traced requests: ${ingested}`);

  // ── special: no memory, no transcript, no trace ──────────────────────────
  console.log("\n— special category —");
  requests.length = 0;
  const tracedBefore = ingested;
  const r2 = await run(AS, A, "How was the spring for the team?");
  const s2 = await row(r2.runId);
  check("a run that retrieved from a special collection is labelled special", s2.sensitivity === "special" && r2.sensitivity === "special");
  check("it is given no memory", requests.length > 0 && requests.every((q) => !q.tools.includes("memory_write")), JSON.stringify(requests.map((q) => q.tools)));
  check("and is told why", requests[0]?.system.includes("special-category material") && requests[0]?.system.includes(S));
  check("its transcript is never kept", Array.isArray(s2.transcript) && s2.transcript.length === 0 && s2.dropped !== null);
  check("it is not traced at all", ingested === tracedBefore, `${ingested - tracedBefore} trace requests`);
  check("its answer is still kept, for its person", (s2.output ?? "").startsWith("ANSWER"));

  // ── confidential: memory stays with the collection's readers ─────────────
  console.log("\n— confidential —");
  const r3 = await run(AC, A, `WRITE review-${stamp} :: Salaries are reviewed in May.`);
  const m3 = (await memories(AC)).find((m) => m.key === `review-${stamp}`);
  check("a run on a confidential collection is labelled confidential", (await row(r3.runId)).sensitivity === "confidential");
  check("and keeps its memory for that collection's readers", m3?.scope === "collection" && m3?.scopeRef === C, m3?.scope);
  await db.upsertCollection({ name: C, visibility: "open" }); // behind the hub's back
  await run(AC, A, `WRITE review2-${stamp} :: Salaries are reviewed again in November.`);
  const m3b = (await memories(AC)).find((m) => m.key === `review2-${stamp}`);
  check("even if someone opens the collection without the hub — a label is never open", m3b?.scope === "collection" && m3b?.scopeRef === C, m3b?.scope);
  await db.upsertCollection({ name: C, visibility: "restricted" });

  // ── the label travels ────────────────────────────────────────────────────
  console.log("\n— the label travels —");
  const r4 = await run(AN, A, "Follow up on that.", { parent: { sessionId: r2.runId, depth: 1 } });
  const s4 = await row(r4.runId);
  check("a run started by a special one (a hand-off) is special, and keeps no transcript", s4.sensitivity === "special" && s4.transcript.length === 0);
  const r5 = await run(AP, A, `ASK ${AS.slug} :: How was the spring for the team?`);
  const s5 = await row(r5.runId);
  check("a run that asked an agent which read special material is special too", s5.sensitivity === "special" && s5.transcript.length === 0, `${s5.sensitivity} / ${s5.transcript.length}`);
  const actions = await import("./src/app/agents/actions.ts");
  signIn(A);
  const follow = await actions.sendAgentMessageAction(AN.slug, [
    { role: "user", content: "How was the spring?" },
    { role: "assistant", content: "It was hard for Bo.", runId: r2.runId },
    { role: "user", content: "Tell me more." },
  ]);
  check("a follow-up in a chat carries the earlier answer's label", !("error" in follow) && (await row(follow.meta.runId)).sensitivity === "special");
  signIn(B);
  const borrowed = await actions.sendAgentMessageAction(AN.slug, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hi.", runId: r2.runId },
    { role: "user", content: "Go on." },
  ]);
  check("someone else's run id counts for nothing", !("error" in borrowed) && (await row(borrowed.meta.runId)).sensitivity === "internal");

  // ── what leaves the hub ──────────────────────────────────────────────────
  console.log("\n— the hub's MCP server —");
  const hubAdmin = await connect(await buildHubMcpServer({ ...asP(ADMIN), source: "credential" }, { baseUrl: "https://hub.example" }));
  check("search returns nothing from a confidential collection, even to an admin", /No passages matched/.test(await call(hubAdmin, "hub_search_knowledge", { query: "salary", collection: C })));
  check("or a special one", /No passages matched/.test(await call(hubAdmin, "hub_search_knowledge", { query: "sick leave", collection: S })));
  check("while an internal one is searched as before", (await call(hubAdmin, "hub_search_knowledge", { query: "office", collection: I })).includes(`Handbook ${stamp}`));
  check("a confidential document cannot be opened by id", /No document with id/.test(await call(hubAdmin, "hub_get_document", { id: dC })) && (await call(hubAdmin, "hub_get_document", { id: dI })).includes("opens at nine"));
  const listed = await call(hubAdmin, "hub_list_collections", {});
  check("nor are labelled collections listed", listed.includes(I) && !listed.includes(C) && !listed.includes(S));
  const hubRun = JSON.parse(await call(hubA, "hub_run_agent", { agent: AC.slug, task: "What do salaries look like?" }));
  check("an agent's answer drawn from confidential material is replaced by where to read it", hubRun.withheld === "confidential" && hubRun.output.includes(`https://hub.example/runs/${hubRun.runId}`) && !hubRun.output.includes("ANSWER"), hubRun.output);
  check("while the hub keeps the answer for its person", ((await row(hubRun.runId)).output ?? "").startsWith("ANSWER"));
  const status = JSON.parse(await call(hubA, "hub_run_status", { runId: hubRun.runId }));
  check("and polling for it says the same", status.withheld === "confidential" && !String(status.output).includes("ANSWER"));
  const plain = JSON.parse(await call(hubA, "hub_run_agent", { agent: AI.slug, task: "When does the office open?" }));
  check("an answer from internal material is returned as before", !plain.withheld && plain.output.startsWith("ANSWER"));
  await hubAdmin.close();
  await hubA.close();

  console.log("\n— a local agent —");
  const AL = await agent("local", { knowledgeCollections: [C, I], mcpServers: ["teams"], placement: "local" });
  const local = await connect(await buildAgentMcpServer(asP(A), AL));
  const tools = (await local.listTools()).tools.map((t) => t.name);
  check("a connection labelled confidential is not dialled for an agent running in Claude Code", !tools.some((t) => t.startsWith("teams_")), tools.join(","));
  check("and its model is told why", /labelled confidential/.test(local.getInstructions() ?? ""));
  check("its search leaves out confidential collections", /No passages matched/.test(await call(local, "hub_search_knowledge", { query: "salary", collection: C })));
  await local.close();

  console.log("\n— the REST routes —");
  const { issueApiCredential } = await import("../../packages/authz/src/index.ts");
  const token = (await issueApiCredential({ name: "verify", principalId: A.id, actor: "verify" })).token;
  const req = (path, body) =>
    new Request(`https://hub.example${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "hub.example" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const runRoute = await import("./src/app/api/agent/run/route.ts");
  const viaRest = await (await runRoute.POST(req("/api/agent/run", { agent: AC.slug, prompt: "Salaries?" }))).json();
  check("POST /api/agent/run withholds a confidential answer", viaRest.withheld === "confidential" && !String(viaRest.output).includes("ANSWER"), JSON.stringify(viaRest).slice(0, 160));
  const searchRoute = await import("./src/app/api/rag/search/route.ts");
  const found = await (await searchRoute.POST(req("/api/rag/search", { query: "salary sick leave office", k: 50 }))).json();
  const titles = (found.chunks ?? []).map((c) => c.title);
  check("POST /api/rag/search leaves labelled collections out", Array.isArray(found.chunks) && !titles.includes(`Salaries ${stamp}`) && !titles.includes(`Sick leave ${stamp}`), JSON.stringify(found).slice(0, 120));
  const docsRoute = await import("./src/app/api/documents/route.ts");
  const docs = (await (await docsRoute.GET(req("/api/documents"))).json()).documents ?? [];
  check("GET /api/documents too", docs.length > 0 && !docs.some((d) => d.collection === C || d.collection === S) && docs.some((d) => d.collection === I));

  console.log("\n— the Context Steward —");
  await db.setPrincipalPreference(A.id, "stewardMayRead", true);
  const steward = await connectMcpServers([builtinServerConfig("knowledge")]);
  try {
    const recent = await steward.execute("knowledge_recent_chats", { limit: 100 });
    check("does not see a labelled conversation, and still sees an internal one", !recent.includes(r2.runId) && !recent.includes(r3.runId) && recent.includes(r1.runId));
    check("nor open one by id", /No such chat/.test(await steward.execute("knowledge_chat_get", { sessionId: r2.runId })));
  } finally {
    await steward.close();
  }

  // ── the read log ─────────────────────────────────────────────────────────
  console.log("\n— the read log —");
  signIn(A);
  await actions.sendAgentMessageAction(AC.slug, [{ role: "user", content: "What about salaries?" }]);
  const knowledge = await import("./src/app/knowledge/actions.ts");
  await knowledge.getDocumentAction(dC);
  await knowledge.getDocumentAction(dI);
  signIn(B);
  const denied = await knowledge.getDocumentAction(dC);
  const reads = await db.listKnowledgeReads({ limit: 500 });
  const mine = (door, coll) => reads.filter((r) => r.principalId === A.id && r.door === door && r.collection === coll);
  check("a run given a confidential document is logged, with the document and the run", mine("run", C).some((r) => r.document === `Salaries ${stamp}` && r.runId === r3.runId && r.who === A.name));
  check("so is a special one, as special", mine("run", S).some((r) => r.sensitivity === "special"));
  check("a chat's reads, through its own door", mine("chat", C).length > 0);
  check("and opening it on the Documents page", mine("page", C).some((r) => r.documentId === dC));
  check("internal material is not logged", !reads.some((r) => r.collection === I));
  check("a refused read is not a read", "error" in denied && !reads.some((r) => r.principalId === B.id && r.collection === C));
  const leak = await sql`select count(*)::int as n from knowledge_reads where principal_id = ${A.id} and (to_jsonb(knowledge_reads)::text ilike '%salar%')`;
  check("what was asked is never in the log", leak[0].n === 0);

  const adminPage = () => import("./src/app/admin/page.tsx");
  signIn(ADMIN, "standard");
  const ap = await render(adminPage);
  check("admins read it under People's data", ap.includes("Who read confidential material") && ap.includes(`Salaries ${stamp}`) && ap.includes(A.name), ap.startsWith("threw") ? ap.slice(0, 200) : "");
  signIn(A, "standard");
  check("nobody else sees it", !(await render(adminPage)).includes("Who read confidential material"));
  const settings = await render(() => import("./src/app/settings/page.tsx"));
  check("Settings tells a person where their answers go", settings.includes("Where your answers go") && settings.includes("organisation"));

  const exported = await db.exportPerson(A.id);
  check("a person's export includes their reads", exported.readLog.some((r) => r.collection === C && r.document === `Salaries ${stamp}`));
  await sql`insert into knowledge_reads (principal_id, door, collection, sensitivity, at) values (${A.id}, 'page', ${C}, 'confidential', now() - interval '400 days')`;
  const swept = await db.sweepRetention({ transcriptsDays: 3650, answersDays: 3650, auditDays: 365 });
  const left = await db.listKnowledgeReads({ principalId: A.id, limit: 500 });
  check("reads older than the audit period are swept with it", swept.readsDeleted >= 1 && left.length > 0 && left.every((r) => Date.now() - new Date(r.at).getTime() < 400 * 86400000));
  const erased = await db.erasePerson(A.id, ADMIN.id);
  check("and erasing a person removes theirs", erased.reads > 0 && (await db.listKnowledgeReads({ principalId: A.id })).length === 0);
} finally {
  for (const id of made.agents) {
    await sql`delete from proposals where agent_id = ${id}`.catch(() => {});
    await sql`delete from agent_sessions where agent_id = ${id}`.catch(() => {});
    await db.deleteAgent(id).catch(() => {});
  }
  const ids = [A.id, B.id, ADMIN.id];
  await sql`delete from agent_sessions where principal_id = any(${ids})`.catch(() => {});
  await sql`delete from knowledge_reads where principal_id = any(${ids}) or collection = any(${[I, C, S]})`.catch(() => {});
  for (const id of made.documents) await sql`delete from documents where id = ${id}`.catch(() => {});
  await sql`delete from collections where name = any(${[I, C, S]})`.catch(() => {});
  if (teamsBefore) await db.setServerSensitivity("teams", teamsBefore).catch(() => {});
  const emails = [A.email, B.email, ADMIN.email];
  await sql`delete from auth_events where principal_id = any(${ids}) or actor = any(${[...ids, ...emails]}) or detail->>'subject' = any(${ids})`.catch(() => {});
  await sql`delete from principals where id = any(${ids})`.catch(() => {});
  await sql.end({ timeout: 5 });
  http.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failedChecks.length}/${checks.length} checks passed.`);
if (failedChecks.length) process.exit(1);
console.log("Not proven here: the hub's MCP server leaving out a labelled connection it would have proxied with a person's own token (that needs an OAuth sign-in), and how the label controls look.");
