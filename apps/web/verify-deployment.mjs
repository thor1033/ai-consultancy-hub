// The client-owned deployment (docs/client-deployment.md): where the model
// runs, temporary vendor access, which seeded agents a release installs, and
// the deployment check — driven through the shipping code.
//
//   node --experimental-transform-types --env-file=.env.local verify-deployment.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend: a
// throwaway HTTP server stands in for the Messages API (and for Vertex AI's
// endpoint, which speaks the same stream) and records which model each
// request named.
//
// The empty-hub check briefly disables this database's standing admins so it
// looks empty, and re-enables exactly those rows in `finally` — as
// verify:data-protection does.
//
// What is proven: the provider is the deployment's choice and fails closed —
// an unknown provider, a Bedrock deployment without a region or a model
// mapping, a Vertex one without a project, a malformed mapping all refuse to
// call any model, with the setting named; the hub's model ids map to the
// platform's on the wire while runs keep the hub's; the Vertex client streams
// a run's request the same way. Temporary access: only an admin with standing
// access grants it, never to themselves, never over standing access, never
// longer than 72 hours, never without a reason, never by the vendor; it is on
// the audit trail; it lets its person in by browser and by credential and
// ends for both at once; the vendor has no standing access, is never
// provisioned or bootstrapped, and cannot be given a standing row; a
// temporary admin cannot change access, labels or other people's data; a
// schedule stops with its owner's access; the Admin page shows the grant and
// what was done with it. HUB_SEEDS chooses the seeds and refuses a typo. The
// deployment check reads the settings into words, marks what must be fixed,
// exits 1 for it, is Expert-only on the page, and the runtime code names no
// outside host it has not been told about.
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
const P = (key, roles, email) => ({ id: `verify-dep-${key}-${stamp}`, email: email ?? `verify-dep-${key}-${stamp}@client.example`, roles, name: `Verify ${key}` });
const VENDOR_DOMAIN = `vendor-${stamp}.example`;
const ADMIN = P("admin", ["admin"]);
const ANALYST = P("analyst", ["analyst"]);
const VENDOR_EMAIL = `ops@${VENDOR_DOMAIN}`;
const STANDING = P("standing", ["analyst"]);
process.env.ALLOWED_EMAILS = [ADMIN.email, ANALYST.email, VENDOR_EMAIL, STANDING.email].join(",");
process.env.HUB_VENDOR_ACCESS = VENDOR_DOMAIN;
process.env.HUB_AUTO_PROVISION_DOMAINS = VENDOR_DOMAIN; // the vendor must still not be provisioned
delete process.env.HUB_DEFAULT_VIEW;
delete process.env.LANGFUSE_PUBLIC_KEY;
delete process.env.HUB_MODEL_PROVIDER;
delete process.env.HUB_MODEL_IDS;

// ── the stand-in model endpoint: records the model each request named ──────
const seen = [];
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  seen.push({ path: req.url, model: body.model ?? null });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model ?? "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture answer" } });
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const FIXTURE = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_BASE_URL = FIXTURE;
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


const made = { schedules: [], credentials: [] };
let disabledAdmins = [];
const asP = (p) => ({ id: p.id, roles: p.roles, source: "oauth", email: p.email });

try {
  // ── where the model runs ─────────────────────────────────────────────────
  console.log("— where the model runs —");
  const agentPkg = await import("../../packages/agent/src/index.ts");
  const { modelProvider, providerProblem, providerModelId, runAgent } = agentPkg;
  check("the Claude API is the default", modelProvider({}).provider === "anthropic");
  const odd = { HUB_MODEL_PROVIDER: "openai-compatible" };
  check("a provider that is not one of the three is an error, not a fall back to the Claude API", "error" in modelProvider(odd) && /not one of/.test(providerProblem(odd) ?? ""));
  check("Bedrock without AWS_REGION is refused — the SDK would quietly use us-east-1", /AWS_REGION/.test(providerProblem({ HUB_MODEL_PROVIDER: "bedrock" }) ?? ""));
  const bedrock = { HUB_MODEL_PROVIDER: "bedrock", AWS_REGION: "eu-central-1" };
  let unmapped = "";
  try {
    providerModelId("claude-opus-4-8", bedrock);
  } catch (e) {
    unmapped = String(e.message);
  }
  check("on Bedrock a model with no mapping is refused, naming HUB_MODEL_IDS", /HUB_MODEL_IDS/.test(unmapped), unmapped);
  check("and a mapped one is sent as mapped", providerModelId("claude-opus-4-8", { ...bedrock, HUB_MODEL_IDS: '{"claude-opus-4-8":"eu.anthropic.claude-opus-4-8-v1"}' }) === "eu.anthropic.claude-opus-4-8-v1");
  check("Vertex needs its region and project", /CLOUD_ML_REGION/.test(providerProblem({ HUB_MODEL_PROVIDER: "vertex" }) ?? "") && /ANTHROPIC_VERTEX_PROJECT_ID/.test(providerProblem({ HUB_MODEL_PROVIDER: "vertex", CLOUD_ML_REGION: "europe-west1" }) ?? ""));
  check("and uses the hub's model id unless mapped", providerModelId("claude-sonnet-4-6", { HUB_MODEL_PROVIDER: "vertex", CLOUD_ML_REGION: "europe-west1", ANTHROPIC_VERTEX_PROJECT_ID: "p" }) === "claude-sonnet-4-6");
  check("a malformed mapping is an error, not an empty one", /HUB_MODEL_IDS/.test(providerProblem({ HUB_MODEL_IDS: "{not json" }) ?? ""));

  seen.length = 0;
  process.env.HUB_MODEL_PROVIDER = "openai-compatible";
  let refused = "";
  try {
    await runAgent({ prompt: "hello" });
  } catch (e) {
    refused = String(e.message);
  }
  check("a run on a misconfigured deployment fails with the reason, and no model is called", /HUB_MODEL_PROVIDER/.test(refused) && seen.length === 0, refused);
  delete process.env.HUB_MODEL_PROVIDER;
  process.env.HUB_MODEL_IDS = JSON.stringify({ "claude-opus-4-8": "claude-mapped-for-verify" });
  const mappedRun = await runAgent({ prompt: "hello", model: "claude-opus-4-8" });
  check("a mapped model id goes on the wire", seen.at(-1)?.model === "claude-mapped-for-verify", JSON.stringify(seen.at(-1)));
  check("while the run keeps the hub's id, for its record and its cost", mappedRun.model === "claude-opus-4-8" && mappedRun.text === "fixture answer");
  delete process.env.HUB_MODEL_IDS;
  const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
  const vertexEnv = { HUB_MODEL_PROVIDER: "vertex", CLOUD_ML_REGION: "europe-west1", ANTHROPIC_VERTEX_PROJECT_ID: "client-project" };
    // A stand-in for Google's auth client: the test has no Google account.
  const authClient = { projectId: vertexEnv.ANTHROPIC_VERTEX_PROJECT_ID, getRequestHeaders: async () => new Headers({ authorization: "Bearer fixture" }) };
  const vertex = new AnthropicVertex({ region: vertexEnv.CLOUD_ML_REGION, projectId: vertexEnv.ANTHROPIC_VERTEX_PROJECT_ID, authClient, baseURL: FIXTURE });
  const vMsg = await vertex.messages.stream({ model: providerModelId("claude-opus-4-8", vertexEnv), max_tokens: 100, messages: [{ role: "user", content: "hi" }] }).finalMessage();
  const vReq = seen.at(-1);
  check("the Vertex client streams the same request, to the client's project and region", vMsg.content[0]?.text === "fixture answer" && /projects\/client-project\/locations\/europe-west1\/.*claude-opus-4-8:streamRawPredict/.test(vReq?.path ?? ""), vReq?.path);

  // ── temporary access ─────────────────────────────────────────────────────
  console.log("\n— temporary access —");
  const authz = await import("../../packages/authz/src/index.ts");
  const { sessionPrincipal } = await import("./src/lib/sessionPrincipal.ts");
  for (const p of [ADMIN, ANALYST, STANDING]) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.name, email: p.email });
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  check("the vendor without a grant is not let in", authz.accessProblem({ enabled: true, email: VENDOR_EMAIL }) === "vendor_without_grant");
  check("temporary access lets its person in until it ends", authz.accessProblem({ enabled: true, email: VENDOR_EMAIL, accessExpiresAt: soon }) === null && authz.accessProblem({ enabled: true, accessExpiresAt: past }) === "temporary_access_ended");
  check("the vendor is never auto-provisioned, even when its domain is listed", !authz.autoProvisionable(VENDOR_EMAIL));

  // The vendor signing in first on an empty hub does not become its admin.
  disabledAdmins = (await sql`update principals set enabled = false where enabled and roles ? 'admin' and access_expires_at is null returning id`).map((r) => r.id);
  signIn({ email: VENDOR_EMAIL });
  const boot = await sessionPrincipal();
  const [bootRow] = await sql`select id from principals where email = ${VENDOR_EMAIL}`;
  check("on an empty hub the vendor signing in first is not made its admin", boot === null && !bootRow && !(await db.hasEnabledAdmin()));
  await sql`update principals set enabled = true where id = any(${disabledAdmins})`;
  disabledAdmins = [];

  const temp = await import("./src/app/admin/temporaryActions.ts");
  const access = await import("./src/app/admin/accessActions.ts");
  signIn(ANALYST);
  check("an analyst cannot grant it", "error" in (await temp.grantTemporaryAccessAction({ email: VENDOR_EMAIL, role: "admin", hours: 2, reason: "Fix the PM connection" })));
  signIn(ADMIN);
  check("an admin cannot grant it to themselves", "error" in (await temp.grantTemporaryAccessAction({ email: ADMIN.email, role: "admin", hours: 2, reason: "Because" })));
  check("nor over someone's standing access", /standing access/.test((await temp.grantTemporaryAccessAction({ email: STANDING.email, role: "admin", hours: 2, reason: "Fix things" })).error ?? ""));
  check("nor for more than 72 hours", "error" in (await temp.grantTemporaryAccessAction({ email: VENDOR_EMAIL, role: "admin", hours: 73, reason: "Fix the PM connection" })));
  check("nor without a reason", "error" in (await temp.grantTemporaryAccessAction({ email: VENDOR_EMAIL, role: "admin", hours: 2, reason: "" })));
  const vendorSave = await access.savePrincipalAction({ id: `verify-dep-vendor-${stamp}`, email: VENDOR_EMAIL, displayName: "Vendor", roles: ["admin"], agentId: "" });
  check("and the vendor cannot be given a standing row", "error" in vendorSave && /temporary access/.test(vendorSave.error));
  const granted = await temp.grantTemporaryAccessAction({ email: VENDOR_EMAIL, name: "Vendor ops", role: "admin", hours: 2, reason: "Fix the PM connection after the upgrade" });
  check("an admin grants it, with an end", granted.ok === true && Math.abs(new Date(granted.until).getTime() - Date.now() - 2 * 3_600_000) < 60_000);
  const [ev] = await sql`select detail, actor from auth_events where event = 'access.temporary.granted' and principal_id = ${VENDOR_EMAIL} order by at desc limit 1`;
  check("on the audit trail, with who, why and until when", ev?.actor === ADMIN.email && ev?.detail?.reason === "Fix the PM connection after the upgrade" && ev?.detail?.vendor === true);

  signIn({ email: VENDOR_EMAIL });
  const vendor = await sessionPrincipal();
  check("the vendor is let in, as temporary", vendor?.id === VENDOR_EMAIL && Boolean(vendor?.temporaryUntil) && vendor.roles.includes("admin"));
  const token = (await authz.issueApiCredential({ name: "verify", principalId: VENDOR_EMAIL, actor: "verify" })).token;
  const bearer = (t) => new Headers({ authorization: `Bearer ${t}` });
  check("and so is a credential they made with it", (await authz.authenticate(bearer(token)))?.id === VENDOR_EMAIL);

  console.log("\n— what temporary access cannot do —");
  check("it cannot open the access console", "error" in (await access.loadAccessAction()));
  check("or add people", "error" in (await access.savePrincipalAction({ id: `verify-dep-friend-${stamp}`, email: `friend-${stamp}@elsewhere.example`, displayName: "", roles: ["admin"], agentId: "" })));
  check("or grant itself more time", /standing access/.test((await temp.grantTemporaryAccessAction({ email: `x-${stamp}@client.example`, role: "admin", hours: 2, reason: "More time" })).error ?? ""));
  check("or relabel a collection", "error" in (await access.setCollectionSensitivityAction(`verify-dep-c-${stamp}`, "internal")));
  const mcpActions = await import("./src/app/mcp/actions.ts");
  check("or a connection", "error" in (await mcpActions.setServerSensitivityAction("teams", "internal")));
  check("or add a connection — a new place the data would go", "error" in (await mcpActions.addConnectionAction({ label: "Elsewhere", url: "https://elsewhere.invalid/mcp" })));
  const data = await import("./src/app/admin/dataActions.ts");
  check("or search, erase or download other people's data", "error" in (await data.findSubjectAction("someone")) && "error" in (await data.erasePersonAction(ANALYST.id, ANALYST.email)));
  const exportRoute = await import("./src/app/settings/export/route.ts");
  const exp = await exportRoute.GET(new Request(`https://hub.example/settings/export?principal=${encodeURIComponent(ANALYST.id)}`));
  check("including through the export link", exp.status === 403 || exp.status === 401, `status ${exp.status}`);
  const adminPage = () => import("./src/app/admin/page.tsx");
  const vendorView = await render(adminPage);
  check("its Admin page shows its own grant and no one's data", vendorView.includes("Temporary access") && vendorView.includes("Fix the PM connection after the upgrade") && !vendorView.includes("A person's data"), vendorView.startsWith("threw") ? vendorView.slice(0, 200) : "");

  signIn(ADMIN, "standard");
  const adminView = await render(adminPage);
  check("the client's admin sees who has access right now, and why", adminView.includes("has temporary access right now") && adminView.includes("Fix the PM connection after the upgrade"));

  console.log("\n— it ends everywhere at once —");
  const sched = await import("./src/lib/scheduler.ts");
  check("a schedule runs as its temporary owner while access lasts", !("error" in (await sched.ownerPrincipal({ ownerPrincipalId: VENDOR_EMAIL }))));
  signIn(ADMIN);
  check("an admin ends it early", (await temp.endTemporaryAccessAction(VENDOR_EMAIL)).ok === true);
  signIn({ email: VENDOR_EMAIL });
  check("the browser no longer lets them in", (await sessionPrincipal()) === null);
  check("nor does their credential", (await authz.authenticate(bearer(token))) === null);
  check("and their schedule stops", "error" in (await sched.ownerPrincipal({ ownerPrincipalId: VENDOR_EMAIL })));
  const [ended] = await sql`select 1 from auth_events where event = 'access.temporary.ended' and principal_id = ${VENDOR_EMAIL}`;
  check("on the audit trail", Boolean(ended));
  const rows = await db.listTemporaryAccess();
  const mine = rows.find((r) => r.id === VENDOR_EMAIL);
  check("the record stays, with what was done during it", mine && !mine.live && mine.events >= 1 && mine.reason === "Fix the PM connection after the upgrade");

  // ── which seeds ──────────────────────────────────────────────────────────
  console.log("\n— seeded agents —");
  const seeds = await import("../../packages/db/src/seeds/all.ts");
  check("unset, a release installs every seed (the vendor's own hub)", seeds.selectSeeds({}).seeds.length === seeds.SEEDS.length);
  check("none installs none", seeds.selectSeeds({ HUB_SEEDS: "none" }).seeds.length === 0);
  check("a list installs those", seeds.selectSeeds({ HUB_SEEDS: "context-steward" }).seeds.map((s) => s.agent.slug).join() === "context-steward");
  check("and a name that is not a seed stops the release", /not a seeded agent/.test(seeds.selectSeeds({ HUB_SEEDS: "context-stewart" }).error ?? ""));

  // ── the deployment check ─────────────────────────────────────────────────
  console.log("\n— the deployment check —");
  const { deploymentPosture, worst } = await import("./src/lib/deployment.ts");
  const client = {
    HUB_MODEL_PROVIDER: "bedrock",
    AWS_REGION: "eu-central-1",
    HUB_MODEL_IDS: '{"claude-opus-4-8":"eu.anthropic.claude-opus-4-8-v1"}',
    VOYAGE_API_KEY: "secret-voyage",
    ALLOWED_EMAILS: "a@client.example",
    HUB_VENDOR_ACCESS: "teqneo.co",
    HUB_SECRET_KEY: "secret-key-value",
    DATABASE_URL: "postgres://u:secret-password@ep-x.eu-central-1.aws.neon.tech/db",
    HUB_SEEDS: "context-steward",
  };
  const good = deploymentPosture(client, [{ name: "PM tool", url: "https://pm.client.example/mcp" }]);
  check("a client's own setup reads as ready", worst(good.items) !== "bad", JSON.stringify(good.items.filter((i) => i.status !== "ok").map((i) => i.key)));
  const text = JSON.stringify(good);
  check("and never shows a secret, only what it amounts to", !/secret-voyage|secret-key-value|secret-password/.test(text) && text.includes("ep-x.eu-central-1.aws.neon.tech"));
  check("it lists who receives the data, connections included", ["Amazon Bedrock", "Voyage AI", "WorkOS", "PM tool"].every((w) => good.recipients.some((r) => r.who === w)));
  const status = (env, key) => deploymentPosture(env).items.find((i) => i.key === key)?.status;
  check("a model outside the EU is marked to check", status({ ...client, AWS_REGION: "us-east-1" }, "model") === "warn");
  check("content tracing is marked to check", status({ ...client, LANGFUSE_PUBLIC_KEY: "x", LANGFUSE_SECRET_KEY: "y", HUB_TRACE_CONTENT: "1" }, "tracing") === "warn");
  check("a client's hub installing all the vendor's agents is marked to check", status({ ...client, HUB_SEEDS: "" }, "seeds") === "warn");
  check("no sign-in list, or no sealing key, must be fixed", status({ ...client, ALLOWED_EMAILS: "" }, "allowlist") === "bad" && status({ ...client, HUB_SECRET_KEY: "" }, "secret") === "bad");
  const { spawnSync } = await import("node:child_process");
  const cli = (env) => spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "deploy-check.mjs"], { cwd: new URL(".", import.meta.url), env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const ok = cli(client);
  const bad = cli({ ...client, AWS_REGION: "" });
  check("deploy:check exits 0 for a usable setup and 1 for one that must be fixed", ok.status === 0 && bad.status === 1 && /AWS_REGION/.test(bad.stdout), `${ok.status}/${bad.status} ${ok.stderr.slice(0, 200)}`);
  check("and prints no secret", !/secret-voyage|secret-key-value|secret-password/.test(ok.stdout));
  signIn(ADMIN, "expert");
  check("Admin shows it in the Expert view", (await render(adminPage)).includes("Who receives your data"));
  signIn(ADMIN, "standard");
  const std = await render(adminPage);
  check("and not in the simpler ones, which never name settings", !std.includes("Who receives your data") && !/HUB_[A-Z_]+|ALLOWED_EMAILS/.test(std));

  // ── nothing calls home ───────────────────────────────────────────────────
  console.log("\n— nothing calls home —");
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const roots = ["src", "../../packages/agent/src", "../../packages/db/src", "../../packages/mcp/src", "../../packages/mcp/servers", "../../packages/rag/src", "../../packages/authz/src"].map((r) => fileURLToPath(new URL(r, import.meta.url)));
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== "node_modules" && f !== "seeds") walk(p);
      } else if (/\.(ts|tsx|mjs)$/.test(f)) files.push(p);
    }
  };
  roots.forEach(walk);
  // Hosts the code may name: services a deployment opts into by configuring
  // them, documentation links, and placeholders. A new one belongs here and
  // in docs/client-deployment.md, on purpose.
  const KNOWN = new Set(["graph.microsoft.com", "login.microsoftonline.com", "api.voyageai.com", "api.github.com", "raw.githubusercontent.com", "github.com", "workos.com", "your-app.authkit.app", "localhost", "0.0.0.0", "127.0.0.1"]);
  const hosts = new Map();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      const h = m[1].toLowerCase();
      if (KNOWN.has(h) || /(^|\.)example\.(com|org)$|(^|\.)(contoso|acme)\./.test(h) || h.endsWith(".example")) continue;
      hosts.set(h, f.split("/ai-consultancy-hub/")[1]);
    }
  }
  check("the runtime names no outside host beyond the ones a deployment opts into", hosts.size === 0, JSON.stringify([...hosts]));
} finally {
  if (disabledAdmins.length) await sql`update principals set enabled = true where id = any(${disabledAdmins})`.catch(() => {});
  const ids = [ADMIN.id, ANALYST.id, STANDING.id, VENDOR_EMAIL];
  await sql`delete from api_credentials where principal_id = any(${ids})`.catch(() => {});
  await sql`delete from auth_events where principal_id = any(${ids}) or actor = any(${[...ids, ADMIN.email]}) or detail->>'email' = ${VENDOR_EMAIL}`.catch(() => {});
  await sql`delete from principals where id = any(${ids}) or email = ${VENDOR_EMAIL} or email like ${`%-${stamp}@%`}`.catch(() => {});
  await sql.end({ timeout: 5 });
  http.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failedChecks.length}/${checks.length} checks passed.`);
if (failedChecks.length) process.exit(1);
console.log("Not proven here: a run against real Bedrock or Vertex (no cloud accounts in this test; the Vertex request shape is proven against the stand-in), and the OAuth bearer door, which needs a WorkOS token — it applies the same accessProblem as the two doors proven.");
