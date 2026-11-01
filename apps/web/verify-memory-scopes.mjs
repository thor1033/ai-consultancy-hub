// Memory scopes (docs/memory-scopes.md, docs/data-protection-review.md 2.1),
// driven through the shipping run path, memory server, gate, hub MCP tools,
// pages and actions.
//
//   node --experimental-transform-types --env-file=.env.local verify-memory-scopes.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend: a
// throwaway HTTP server stands in for the Messages API and does what each
// prompt says ("WRITE key :: content", "LIST", "FORGE key :: content"). The
// knowledge base's embedder is whatever the environment has; retrieval takes
// the nearest passages with no threshold, so each agent's one curated
// collection is what it retrieves.
//
// What is proven: a memory written by a run that retrieved from a restricted
// collection is kept for that collection's readers — another analyst's run
// does not load it, an admin's does; one written from open material is shared;
// a run that continues a conversation, or was started by another run, keeps
// what it remembers for its person alone; two people keep their own memory
// under one key; the model cannot choose a place — the argument is not in its
// schema and a forged one is overwritten; the memory server refuses a place
// that is not the run's person's or a collection they may read; memory written
// through the hub's MCP tools is the writer's own; the Memory tab shows each
// person what their runs would load and labels who a memory is for; only an
// admin can share a memory with everyone, on the audit trail; only its owner
// or a manager can forget a personal memory.
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
const P = (key, roles) => ({ id: `verify-ms-${key}-${stamp}`, email: `verify-ms-${key}-${stamp}@example.com`, roles, name: `Verify ${key}` });
const A = P("ana", ["analyst"]);
const B = P("bo", ["analyst"]);
const ADMIN = P("admin", ["admin"]);
process.env.ALLOWED_EMAILS = [A, B, ADMIN].map((p) => p.email).join(",");
delete process.env.HUB_DEFAULT_VIEW;
delete process.env.LANGFUSE_PUBLIC_KEY;
delete process.env.HUB_DEFAULT_COLLECTION_VISIBILITY;

// ── the stand-in Messages API: does what the prompt says ────────────────────
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n"));
const offered = [];
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  offered.push(body.tools ?? []);
  const firstUser = [...body.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string")?.content ?? "";
  const last = body.messages.at(-1);
  const lastResult = last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? textOf(last.content) : null;
  let block = null;
  if (!lastResult) {
    const w = firstUser.match(/^(WRITE|FORGE) (\S+) :: ([\s\S]+)$/);
    if (w) block = { name: "memory_write", input: { key: w[2], content: w[3], ...(w[1] === "FORGE" ? { __place: JSON.stringify({ scope: "agent", ref: "" }) } : {}) } };
    else if (/^LIST/.test(firstUser)) block = { name: "memory_list", input: { include_inactive: true } };
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
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `RESULT ${lastResult ?? "none"}` } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  }
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

const R = `verify-ms-restricted-${stamp}`;
const O = `verify-ms-open-${stamp}`;
const made = { agents: [], documents: [] };
const asP = (p) => ({ id: p.id, roles: p.roles, source: "oauth", email: p.email });

try {
  const rag = await import("../../packages/rag/src/index.ts");
  const { runAgentForPrincipal } = await import("./src/lib/agentRuns.ts");
  for (const p of [A, B, ADMIN]) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.name, email: p.email });
  await db.upsertCollection({ name: R, visibility: "restricted" });
  await db.upsertCollection({ name: O, visibility: "open" });
  await db.grantCollection(R, A.id, "verify");
  made.documents.push((await rag.ingestDocument({ title: "Layoffs", content: "Client X lets three people go in December.", collection: R })).documentId);
  made.documents.push((await rag.ingestDocument({ title: "Handbook", content: "The office opens at nine.", collection: O })).documentId);
  const agent = async (key, collections) => {
    const a = await db.createAgent({ slug: `verify-ms-${key}-${stamp}`, name: `MS ${key}`, instructions: "x", knowledgeCollections: collections });
    made.agents.push(a.id);
    return a;
  };
  const AR = await agent("restricted", [R]);
  const AO = await agent("open", [O]);
  const AN = await agent("none", []);
  const run = (a, who, prompt, extra = {}) => runAgentForPrincipal({ agentRef: a.slug, prompt, principal: asP(who), ...extra });
  const out = async (a, who, extra) => (await run(a, who, "LIST", extra)).output ?? "";
  const rows = async (a) => db.listMemories(a.id);

  console.log("— where a run's memory is kept —");
  const r1 = await run(AR, A, `WRITE layoffs-${stamp} :: Client X lets three people go in December.`);
  const kCol = (await rows(AR)).find((m) => m.key === `layoffs-${stamp}`);
  check("a run that retrieved from a restricted collection keeps its memory for that collection's readers",
    kCol?.scope === "collection" && kCol?.scopeRef === R, JSON.stringify(kCol && { scope: kCol.scope, ref: kCol.scopeRef }));
  check("recording who wrote it and in which run", kCol?.writtenBy === A.id && kCol?.sourceRunId === r1.runId);
  check("the run's answer says who it is kept for", /kept for readers of/.test(r1.output ?? ""), (r1.output ?? "").slice(0, 120));
  check("another analyst's run does not load it", !(await out(AR, B)).includes("three people"));
  check("a reader of the collection's run does", (await out(AR, A)).includes("three people"));
  check("an admin's run does", (await out(AR, ADMIN)).includes("three people"));

  await run(AO, A, `WRITE hours-${stamp} :: The office opens at nine.`);
  check("a memory written from open material is shared", (await rows(AO)).find((m) => m.key === `hours-${stamp}`)?.scope === "agent");
  check("and loaded for everyone", (await out(AO, B)).includes("opens at nine"));

  const history = [{ role: "user", content: "Earlier: something only Ana saw." }, { role: "assistant", content: "Noted." }];
  await run(AN, A, `WRITE note-${stamp} :: Ana's own note.`, { history });
  const kHist = (await rows(AN)).find((m) => m.key === `note-${stamp}`);
  check("a run that continues a conversation keeps what it remembers for its person", kHist?.scope === "personal" && kHist?.scopeRef === A.id);
  check("which nobody else's run loads", !(await out(AN, B)).includes("Ana's own note") && (await out(AN, A)).includes("Ana's own note"));
  await run(AN, A, `WRITE child-${stamp} :: From a hand-off.`, { parent: { sessionId: r1.runId, depth: 1 } });
  check("so does a run started by another run (an ask, a hand-off)", (await rows(AN)).find((m) => m.key === `child-${stamp}`)?.scope === "personal");

  await run(AN, A, `WRITE next-${stamp} :: Ana's next step.`, { history });
  await run(AN, B, `WRITE next-${stamp} :: Bo's next step.`, { history });
  const both = (await rows(AN)).filter((m) => m.key === `next-${stamp}`);
  check("two people keep their own memory under the same key", both.length === 2 && both.every((m) => m.scope === "personal"));
  const aList = await out(AN, A);
  check("and each run loads only its person's", aList.includes("Ana's next step") && !aList.includes("Bo's next step"));

  console.log("\n— the model does not choose —");
  offered.length = 0;
  await run(AR, A, `FORGE forged-${stamp} :: Pretend this is for everyone.`);
  const forged = (await rows(AR)).find((m) => m.key === `forged-${stamp}`);
  check("a place the model puts in its call is overwritten by the hub's", forged?.scope === "collection" && forged?.scopeRef === R, forged?.scope);
  const writeTool = offered.flat().find((t) => t.name === "memory_write");
  check("and the argument is not in the schema the model is shown", Boolean(writeTool) && !("__place" in (writeTool.input_schema?.properties ?? {})));

  const { connectMcpServers, memoryServerConfig } = await import("../../packages/mcp/src/index.ts");
  const direct = await connectMcpServers([memoryServerConfig(AN.id, { principalId: B.id, collections: { kind: "allow", collections: [] } })]);
  try {
    const asOther = await direct.execute("memory_write", { key: `x-${stamp}`, content: "x", __place: JSON.stringify({ scope: "personal", ref: A.id }) });
    check("the memory server refuses a personal place that is not the run's person's", /Not remembered/.test(asOther), asOther);
    const unreadable = await direct.execute("memory_write", { key: `y-${stamp}`, content: "y", __place: JSON.stringify({ scope: "collection", ref: R }) });
    check("and a collection the run's person may not read", /may not read/.test(unreadable), unreadable);
    const listed = await direct.execute("memory_list", { include_inactive: true });
    check("and lists only what that person may have", !listed.includes("Ana's own note") && listed.includes("Bo's next step"));
  } finally {
    await direct.close();
  }

  console.log("\n— the hub's own memory tools —");
  const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const hubAs = async (p) => {
    const server = await buildHubMcpServer({ ...asP(p), source: "credential", agentId: AN.slug });
    const client = new Client({ name: "verify", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return client;
  };
  const call = async (client, name, args) => (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? "";
  const hubB = await hubAs(B);
  await call(hubB, "hub_memory_write", { key: `local-${stamp}`, content: "Bo's local agent note." });
  check("memory written through the hub's MCP tools is the writer's own", (await rows(AN)).find((m) => m.key === `local-${stamp}`)?.scopeRef === B.id);
  const hubA = await hubAs(A);
  check("and another person's hub_memory_list does not show it", !(await call(hubA, "hub_memory_list", { include_inactive: true })).includes("Bo's local agent note"));
  await hubA.close();
  await hubB.close();

  console.log("\n— the pages and actions —");
  const agentPage = () => import("./src/app/agents/[slug]/page.tsx");
  signIn(B, "standard");
  const bPage = await render(agentPage, { params: Promise.resolve({ slug: AR.slug }) });
  check("the Memory tab shows another analyst only what their runs would load", !bPage.includes("three people") && !bPage.startsWith("threw"), bPage.slice(0, 100));
  signIn(ADMIN, "standard");
  const adminPage = await render(agentPage, { params: Promise.resolve({ slug: AR.slug }) });
  check("an admin sees every memory, labelled with who it is for", adminPage.includes("three people") && adminPage.includes(`Readers of ${R}`));
  signIn(A, "standard");
  check("a person's own memory reads as theirs", (await render(agentPage, { params: Promise.resolve({ slug: AN.slug }) })).includes("Only you"));

  const actions = await import("./src/app/agents/actions.ts");
  signIn(B);
  const bShare = await actions.shareMemoryAction(AN.id, kHist.id);
  check("only an admin can share a memory with everyone", !bShare.ok && (await db.getMemory(kHist.id))?.scope === "personal");
  const bForget = await actions.forgetMemoryAction(AN.id, kHist.id);
  check("nor can another person forget someone's personal memory", !bForget.ok && Boolean(await db.getMemory(kHist.id)));
  signIn(ADMIN);
  const shared = await actions.shareMemoryAction(AN.id, kHist.id);
  const [ev] = await sql`select event, detail from auth_events where event = 'memory.shared' and principal_id = ${ADMIN.id} order by at desc limit 1`;
  check("an admin shares it, on the audit trail", shared.ok && (await db.getMemory(kHist.id))?.scope === "agent" && ev?.detail?.key === `note-${stamp}`);
  check("and now everyone's runs load it", (await out(AN, B)).includes("Ana's own note"));
  const bothNext = both.find((m) => m.scopeRef === A.id);
  signIn(A);
  check("a person can forget their own memory", (await actions.forgetMemoryAction(AN.id, bothNext.id)).ok && !(await db.getMemory(bothNext.id)));
  check("an agent id in the call cannot reach another agent's memory", !(await actions.forgetMemoryAction(AO.id, (await rows(AN)).find((m) => m.scopeRef === B.id)?.id ?? "x")).ok);
} finally {
  for (const id of made.agents) {
    await sql`delete from proposals where agent_id = ${id}`.catch(() => {});
    await sql`delete from agent_sessions where agent_id = ${id}`.catch(() => {});
    await db.deleteAgent(id).catch(() => {});
  }
  for (const id of made.documents) await sql`delete from documents where id = ${id}`.catch(() => {});
  await sql`delete from collections where name = any(${[R, O]})`.catch(() => {});
  const ids = [A.id, B.id, ADMIN.id];
  await sql`delete from auth_events where principal_id = any(${ids})`.catch(() => {});
  await sql`delete from principals where id = any(${ids})`.catch(() => {});
  await sql.end({ timeout: 5 });
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: the steward's reads (verify:knowledge in mcp), and how the Memory tab looks.");
