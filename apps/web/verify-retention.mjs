// Retention, and a person's rights over their data (docs/retention.md,
// docs/data-protection-review.md 2.2 and 2.7), driven through the shipping
// sweep, scheduler pacing, export route, admin actions and pages.
//
//   node --experimental-transform-types --env-file=.env.local verify-retention.mjs
//
// Needs DATABASE_URL and a migrated database. No API key, no spend: runs and
// proposals are made directly and aged with SQL. The request is stubbed only
// where Next supplies it.
//
// NOTE: a sweep is global, as it is in production — it applies the default
// policy to this whole database (content older than 90 days, transcripts
// older than 7, audit entries older than 365). On a development database that
// is the point; do not point this at a database whose old content you need.
//
// What is proven: the policy reads the environment and refuses nonsense; a
// sweep removes a run's transcript after the short window and its question,
// answer and error after the long one, keeps the numbers, never touches a
// running run or a pending proposal, clears a decided proposal's details,
// deletes old audit entries but keeps erasure records, and is idempotent; the
// scheduler sweeps at most once per window; "Your answers" says an answer
// expired. A person downloads their own data, not someone else's; an admin
// downloads anyone's; each export is recorded. Only an admin erases, by
// typing the person's email, never themselves; erasure removes the person's
// runs, personal memories, schedules, proposals, grants and row, unlinks
// shared memories they wrote, keeps the record of the erasure, and they can no
// longer sign in. Only an admin searches for a name, which finds it in
// questions, memories and documents, and the search is recorded.
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
const P = (key, roles) => ({ id: `verify-rt-${key}-${stamp}`, email: `verify-rt-${key}-${stamp}@example.com`, roles, name: `Verify ${key}` });
const A = P("ana", ["analyst"]);
const B = P("bo", ["analyst"]);
const ADMIN = P("admin", ["admin"]);
process.env.ALLOWED_EMAILS = [A, B, ADMIN].map((p) => p.email).join(",");
for (const k of ["HUB_RETAIN_ANSWERS_DAYS", "HUB_RETAIN_TRANSCRIPTS_DAYS", "HUB_RETAIN_AUDIT_DAYS", "HUB_DEFAULT_VIEW", "LANGFUSE_PUBLIC_KEY"]) delete process.env[k];
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

const made = { agents: [], documents: [] };
const NAME = `Zebulon Quartermaine ${stamp}`;

try {
  const { createServer: _unused } = await import("node:http");
  for (const p of [A, B, ADMIN]) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.name, email: p.email });

  console.log("— the policy —");
  const pol = db.retentionPolicy;
  check("defaults: transcripts 7 days, answers 90, audit 365", JSON.stringify(pol({})) === JSON.stringify({ answersDays: 90, transcriptsDays: 7, auditDays: 365 }));
  check("the environment sets them", JSON.stringify(pol({ HUB_RETAIN_ANSWERS_DAYS: "30", HUB_RETAIN_TRANSCRIPTS_DAYS: "2", HUB_RETAIN_AUDIT_DAYS: "180" })) === JSON.stringify({ answersDays: 30, transcriptsDays: 2, auditDays: 180 }));
  check("nonsense falls back to the default, not to forever or to now",
    pol({ HUB_RETAIN_ANSWERS_DAYS: "forever" }).answersDays === 90 && pol({ HUB_RETAIN_ANSWERS_DAYS: "-1" }).answersDays === 90 && pol({ HUB_RETAIN_AUDIT_DAYS: "1.5" }).auditDays === 365);
  check("a transcript is never kept longer than the answer it holds", pol({ HUB_RETAIN_ANSWERS_DAYS: "3", HUB_RETAIN_TRANSCRIPTS_DAYS: "30" }).transcriptsDays === 3);

  console.log("\n— the sweep —");
  const agent = await db.createAgent({ slug: `verify-rt-${stamp}`, name: `RT ${stamp}`, instructions: "x" });
  made.agents.push(agent.id);
  const run = async (prompt, daysAgo, status = "succeeded") => {
    const id = await db.recordSession({ prompt, agentId: agent.id, principalId: A.id, transcript: [{ role: "user", content: prompt }, { role: "assistant", content: [{ type: "text", text: "secret answer" }] }], toolsUsed: ["pm_list_projects"], output: `answer to ${prompt}`, costUsd: 0.01, latencyMs: 1200 });
    await sql`update agent_sessions set created_at = now() - make_interval(days => ${daysAgo}::int), started_at = now() - make_interval(days => ${daysAgo}::int), finished_at = now() - make_interval(days => ${daysAgo}::int), status = ${status} where id = ${id}`;
    return id;
  };
  const old = await run(`old question ${stamp}`, 100);
  const mid = await run(`mid question ${stamp}`, 30);
  const recent = await run(`recent question ${stamp}`, 1);
  const stuck = await run(`running question ${stamp}`, 100, "running");
  const prop = async (status, daysAgo) => {
    const [r] = await sql`insert into proposals (agent_id, principal_id, server, tool, args, status, reason, result, decided_at, created_at)
      values (${agent.id}, ${A.id}, 'verify-pm', 'pm_create_task', ${sql.json({ title: "secret task" })}, ${status}, 'because', ${status === "executed" ? "done" : null},
              ${status === "pending" ? null : sql`now() - make_interval(days => ${daysAgo}::int)`}, now() - make_interval(days => ${daysAgo}::int)) returning id`;
    return r.id;
  };
  const oldDecided = await prop("executed", 100);
  const oldPending = await prop("pending", 100);
  const recentDecided = await prop("rejected", 5);
  await sql`insert into auth_events (event, principal_id, at, detail) values ('auth.denied', ${A.id}, now() - interval '400 days', '{}'), ('data.erased', null, now() - interval '400 days', ${sql.json({ subject: `old-${stamp}` })})`;

  const sweep = await db.sweepRetention();
  const row = async (id) => (await sql`select prompt, output, error, transcript, tools_used, cost_usd, latency_ms, status, content_expired_at, transcript_dropped_at from agent_sessions where id = ${id}`)[0];
  const o = await row(old);
  check("after the long window, a run's question, answer and transcript are removed", o.prompt === "" && o.output === null && JSON.stringify(o.transcript) === "[]" && o.content_expired_at !== null);
  check("and its numbers stay: tools, cost, timing, status", o.tools_used.includes("pm_list_projects") && Number(o.cost_usd) === 0.01 && o.latency_ms === 1200 && o.status === "succeeded");
  const m = await row(mid);
  check("after the short window, only the transcript goes; question and answer stay", JSON.stringify(m.transcript) === "[]" && m.transcript_dropped_at !== null && m.prompt === `mid question ${stamp}` && m.output !== null);
  const r = await row(recent);
  check("a recent run is untouched", r.transcript.length === 2 && r.content_expired_at === null);
  const s = await row(stuck);
  check("a run still running is never touched, however old", s.prompt === `running question ${stamp}` && s.transcript.length === 2);
  const pr = async (id) => (await sql`select args, result, reason, content_expired_at from proposals where id = ${id}`)[0];
  const od = await pr(oldDecided);
  check("an old decided proposal's details are cleared", JSON.stringify(od.args) === "{}" && od.result === null && od.reason === null && od.content_expired_at !== null);
  check("a pending one is not, however old", (await pr(oldPending)).args.title === "secret task");
  check("nor a recently decided one", (await pr(recentDecided)).args.title === "secret task");
  const [{ n: oldAudit }] = await sql`select count(*)::int as n from auth_events where principal_id = ${A.id} and event = 'auth.denied'`;
  const [{ n: keptErasure }] = await sql`select count(*)::int as n from auth_events where event = 'data.erased' and detail->>'subject' = ${`old-${stamp}`}`;
  check("old audit entries are deleted, records of erasure are kept", oldAudit === 0 && keptErasure === 1);
  check("the sweep counts what it did", sweep.answersExpired >= 1 && sweep.transcriptsDropped >= 1 && sweep.proposalsExpired >= 1 && sweep.auditDeleted >= 1, JSON.stringify(sweep));
  const again = await row(old);
  await db.sweepRetention();
  check("a second sweep changes nothing it already did", String((await row(old)).content_expired_at) === String(again.content_expired_at));
  const mine = await db.listMyRuns(agent.id, A.id);
  check("'Your answers' knows an answer expired", mine.find((x) => x.id === old)?.expired === true && mine.find((x) => x.id === recent)?.expired === false);

  const { maybeSweepRetention } = await import("./src/lib/scheduler.ts");
  await db.sweepRetentionAndRecord("verify");
  check("the scheduler does not sweep again inside the window", (await maybeSweepRetention()) === null);
  check("and does once the window has passed", (await maybeSweepRetention(new Date(Date.now() + 7 * 3600_000))) !== null);

  console.log("\n— a person's export —");
  await db.rememberMemory(agent.id, `mine-${stamp}`, "Ana's own note.", true, { scope: "personal", ref: A.id }, { writtenBy: A.id });
  await db.rememberMemory(agent.id, `shared-${stamp}`, "Shared knowledge Ana added.", true, undefined, { writtenBy: A.id });
  const { GET } = await import("./src/app/settings/export/route.ts");
  const get = async (q = "") => {
    const res = await GET(new Request(`https://hub.example/settings/export${q}`));
    return { status: res.status, disposition: res.headers.get("content-disposition"), body: await res.json() };
  };
  signIn(null);
  check("signed out, nothing", (await get()).status === 401);
  signIn(A);
  const own = await get();
  check("a person downloads their own data, as a file", own.status === 200 && /attachment; filename="hub-data-/.test(own.disposition ?? ""));
  check("with their questions and answers, as retention left them", own.body.runs.some((x) => x.question === `recent question ${stamp}`) && own.body.runs.some((x) => x.id === old && x.removedAfterRetention && x.question === ""));
  check("their memories — their own and what they added to shared ones", own.body.memories.some((x) => x.key === `mine-${stamp}` && x.keptFor === "only you") && own.body.memories.some((x) => x.key === `shared-${stamp}` && x.writtenByYou));
  check("their proposals, and the policy that applies", own.body.proposals.length === 3 && own.body.retention.answersDays === 90);
  check("not someone else's", (await get(`?principal=${encodeURIComponent(B.id)}`)).status === 403);
  signIn(ADMIN);
  const theirs = await get(`?principal=${encodeURIComponent(A.id)}`);
  check("an admin downloads anyone's", theirs.status === 200 && theirs.body.person?.email === A.email);
  const [exp] = await sql`select actor, detail from auth_events where event = 'data.exported' and principal_id = ${A.id} order by at desc limit 1`;
  check("each export is on the audit trail, with who did it", exp?.actor === ADMIN.email && exp?.detail?.byAdmin === true);

  console.log("\n— finding a name —");
  const actions = await import("./src/app/admin/dataActions.ts");
  await sql`update agent_sessions set prompt = ${`Write to ${NAME} about the renewal`} where id = ${recent}`;
  await db.rememberMemory(agent.id, `client-${stamp}`, `${NAME} prefers email.`);
  const rag = await import("../../packages/rag/src/index.ts");
  made.documents.push((await rag.ingestDocument({ title: "Contacts", content: `Account lead: ${NAME}.` })).documentId);
  signIn(B);
  check("only an admin searches", "error" in (await actions.findSubjectAction(NAME)));
  signIn(ADMIN);
  check("at least three characters", "error" in (await actions.findSubjectAction("ab")));
  const found = await actions.findSubjectAction(NAME);
  check("a name is found in questions, memories and documents",
    !("error" in found) && found.hits.runs.some((x) => x.id === recent && x.where === "question") && found.hits.memories.some((x) => x.key === `client-${stamp}`) && found.hits.documents.some((d) => d.title === "Contacts"));
  const [srch] = await sql`select detail from auth_events where event = 'data.searched' and principal_id = ${ADMIN.id} order by at desc limit 1`;
  check("and the search is on the audit trail", srch?.detail?.term === NAME);

  console.log("\n— erasure —");
  await sql`insert into agent_schedules (agent_id, name, prompt, kind, interval_minutes, owner_principal_id) values (${agent.id}, 'verify', 'x', 'every', 60, ${A.id})`;
  await db.upsertCollection({ name: `verify-rt-${stamp}`, visibility: "restricted" });
  await db.grantCollection(`verify-rt-${stamp}`, A.id, "verify");
  signIn(B);
  check("only an admin erases", "error" in (await actions.erasePersonAction(A.id, A.email)));
  signIn(ADMIN);
  check("not without typing their email", "error" in (await actions.erasePersonAction(A.id, "yes")));
  check("and not yourself", "error" in (await actions.erasePersonAction(ADMIN.id, ADMIN.email)));
  const erased = await actions.erasePersonAction(A.id, A.email.toUpperCase());
  check("an admin erases a person", !("error" in erased) && erased.erased.principal === true && erased.erased.runs >= 4, JSON.stringify(erased));
  const [{ runs }] = await sql`select count(*)::int as runs from agent_sessions where principal_id = ${A.id}`;
  const [{ props }] = await sql`select count(*)::int as props from proposals where principal_id = ${A.id}`;
  const [{ scheds }] = await sql`select count(*)::int as scheds from agent_schedules where owner_principal_id = ${A.id}`;
  const [{ grants }] = await sql`select count(*)::int as grants from collection_grants where principal_id = ${A.id}`;
  check("their runs, proposals, schedules and grants are gone", runs === 0 && props === 0 && scheds === 0 && grants === 0);
  const mems = await db.listMemories(agent.id);
  check("their personal memories are gone; a shared one they added stays, unlinked",
    !mems.some((x) => x.key === `mine-${stamp}`) && mems.find((x) => x.key === `shared-${stamp}`)?.writtenBy === null);
  const [er] = await sql`select actor, detail from auth_events where event = 'data.erased' and detail->>'subject' = ${A.id}`;
  check("the erasure is recorded, with who did it", er?.actor === ADMIN.email && er?.detail?.principal === true);
  const { sessionPrincipal } = await import("./src/lib/sessionPrincipal.ts");
  signIn(A);
  check("and they can no longer sign in", (await sessionPrincipal()) === null);
} finally {
  for (const id of made.agents) {
    await sql`delete from proposals where agent_id = ${id}`.catch(() => {});
    await sql`delete from agent_schedules where agent_id = ${id}`.catch(() => {});
    await sql`delete from agent_sessions where agent_id = ${id}`.catch(() => {});
    await db.deleteAgent(id).catch(() => {});
  }
  for (const id of made.documents) await sql`delete from documents where id = ${id}`.catch(() => {});
  await sql`delete from collections where name = ${`verify-rt-${stamp}`}`.catch(() => {});
  const ids = [A.id, B.id, ADMIN.id];
  await sql`delete from auth_events where principal_id = any(${ids}) or detail->>'subject' = any(${[...ids, `old-${stamp}`]}) or (event = 'retention.sweep' and actor = 'verify')`.catch(() => {});
  await sql`delete from principals where id = any(${ids})`.catch(() => {});
  await sql.end({ timeout: 5 });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: how the Admin and Settings sections look.");
