// Connections added on the Connections page (lib/connections.ts,
// lib/secretBox.ts, app/mcp/actions.ts, docs/connections.md), driven through
// the shipping actions, registry and run path.
//
//   node --experimental-transform-types --env-file=.env.local verify-connections.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend: a
// throwaway HTTP server stands in for the Messages API, and the repo's remote
// MCP fixture (packages/mcp/remote-fixture) stands in for the system being
// connected. The request is stubbed only where Next would supply it: who is
// signed in (WorkOS's withAuth), next/headers, next/cache, next/navigation.
//
// What is proven: sealing opens only with the same key and for the same
// purpose, and says which key a value needs; only an admin may add, change or
// remove a connection; addresses and names are checked; a connection is dialled
// before it is saved, and a refused token is said in words with "save anyway"
// on offer; what is stored is sealed (neither the address nor the token is in
// the row); the connection joins the registry and an agent's run gets its
// tools, dialled with its token; the deployment's own servers keep their
// names; a connection whose key changed is reported with the reason, at run
// time too, and is fixed by typing it again; removing it takes it out of every
// run. What it cannot prove: how the pages look — screenshot after a build.
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.__conn = { user: null };
const stub = (code) => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const STUBS = {
  "server-only": "export default null;",
  "@workos-inc/authkit-nextjs": "export async function withAuth() { return { user: globalThis.__conn.user }; }",
  "next/headers": "export async function cookies() { return { get() {}, set() {}, delete() {} }; } export async function headers() { return new Headers(); }",
  "next/cache": "export function revalidatePath() {} export function revalidateTag() {}",
  "next/navigation": "export function notFound() { throw new Error('404'); } export function redirect() {} export const useRouter = () => ({});",
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
      for (const ext of [".ts", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw err;
    }
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
const ADMIN = { id: `verify-conn-admin-${stamp}`, email: `verify-conn-admin-${stamp}@example.com`, roles: ["admin"] };
const ANALYST = { id: `verify-conn-analyst-${stamp}`, email: `verify-conn-analyst-${stamp}@example.com`, roles: ["analyst"] };
process.env.ALLOWED_EMAILS = [ADMIN.email, ANALYST.email].join(",");
// Keys this script controls. The deployment's own are put back at the end of the process, which is all they live in.
const WORKOS = `verify-workos-cookie-password-${stamp}-0123456789`;
process.env.WORKOS_COOKIE_PASSWORD = WORKOS;
delete process.env.HUB_SECRET_KEY;
delete process.env.HUB_REMOTE_MCP_SERVERS;
delete process.env.LANGFUSE_PUBLIC_KEY;
const signIn = (p) => (globalThis.__conn.user = p ? { id: `user_${p.id}`, email: p.email } : null);

// ── the system being connected: the repo's remote MCP fixture ───────────────
const PORT = 8790 + Math.floor(Math.random() * 500);
const TOKEN = `fixture-token-${stamp}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("../../packages/mcp/remote-fixture/server.mjs", import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), PM_TOOL_MCP_TOKEN: TOKEN },
  stdio: "pipe",
});
await new Promise((resolve, reject) => {
  fixture.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  fixture.on("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  setTimeout(() => reject(new Error("fixture did not start")), 10_000);
});
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

// ── the stand-in Messages API: records the tools each run is offered ────────
const offered = [];
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  offered.push((body.tools ?? []).map((t) => t.name));
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } });
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";

const db = await import("../../packages/db/src/index.ts");
const mcp = await import("../../packages/mcp/src/index.ts");
const box = await import("./src/lib/secretBox.ts");
const conn = await import("./src/lib/connections.ts");
const actions = await import("./src/app/mcp/actions.ts");
const { runAgentForPrincipal } = await import("./src/lib/agentRuns.ts");
const { unavailableServers } = await import("./src/lib/runSession.ts");
const { serverDirectory } = await import("./src/app/mcp/directory.ts");
const sql = db.getSql();
const NAME = `crm-${stamp}`.slice(0, 40);
let agentId = null;

try {
  console.log("— sealing —");
  const sealed = box.sealSecret("s3cret", "mcp:x:token");
  check("a sealed value opens with the same key and purpose", box.openSecret(sealed, "mcp:x:token") === "s3cret" && sealed.startsWith("v1.workos."));
  check("not for another purpose (copied to another row or field)", (() => { try { box.openSecret(sealed, "mcp:y:token"); return false; } catch { return true; } })());
  const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
  check("not when it has been changed", (() => { try { box.openSecret(tampered, "mcp:x:token"); return false; } catch { return true; } })());
  check("two seals of the same value differ (a fresh IV each time)", box.sealSecret("same", "p") !== box.sealSecret("same", "p"));
  process.env.HUB_SECRET_KEY = `verify-hub-secret-key-${stamp}-0123456789abcdef`;
  const withHub = box.sealSecret("new", "p");
  check("with HUB_SECRET_KEY set, new seals use it, and older ones still open", withHub.startsWith("v1.hub.") && box.openSecret(sealed, "mcp:x:token") === "s3cret");
  delete process.env.HUB_SECRET_KEY;
  let msg = "";
  try { box.openSecret(withHub, "p"); } catch (e) { msg = e.message; }
  check("without the key it needs, opening says which key", /HUB_SECRET_KEY/.test(msg), msg);
  process.env.WORKOS_COOKIE_PASSWORD = "short";
  check("with no usable key, the page is told to set one", !box.sealingStatus().ok && /HUB_SECRET_KEY/.test(box.sealingStatus().reason));
  process.env.WORKOS_COOKIE_PASSWORD = WORKOS;

  console.log("\n— who may add, and what —");
  for (const p of [ADMIN, ANALYST]) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.id, email: p.email });
  signIn(ANALYST);
  const notAdmin = await actions.addConnectionAction({ label: "CRM", name: NAME, url: URL_, token: TOKEN });
  check("someone who is not an admin cannot add one", "error" in notAdmin && /Only an admin/.test(notAdmin.error));
  signIn(ADMIN);
  const plainHttp = await actions.addConnectionAction({ label: "CRM", name: NAME, url: "http://crm.example.com/mcp" });
  check("plain http to another machine is refused", "error" in plainHttp && /https/.test(plainHttp.error));
  const userinfo = await actions.addConnectionAction({ label: "CRM", name: NAME, url: "https://bob:pw@crm.example.com/mcp" });
  check("a password in the address is refused", "error" in userinfo && /token field/.test(userinfo.error));
  for (const reserved of ["memory", "agents", "microsoft365"]) {
    const r = await actions.addConnectionAction({ label: "X", name: reserved, url: URL_ });
    check(`"${reserved}" cannot be taken`, "error" in r, r.error);
  }
  process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({ [`env-${stamp}`]: { url: URL_, tokenEnv: "NOPE" } });
  const envName = await actions.addConnectionAction({ label: "X", name: `env-${stamp}`, url: URL_ });
  check("a name the deployment declares cannot be taken", "error" in envName && /deployment/.test(envName.error));
  delete process.env.HUB_REMOTE_MCP_SERVERS;

  console.log("\n— adding one —");
  // The fixture accepts any bearer (it stands in for an endpoint that reads a
  // person's token) and refuses none at all, so a missing token is the refusal.
  const wrong = await actions.addConnectionAction({ label: "CRM", name: NAME, url: URL_ });
  check("a refused token is said in words, with saving anyway on offer", "error" in wrong && /refused the token/.test(wrong.error) && wrong.canForce === true, wrong.error);
  check("and nothing was saved", (await db.listHubConnections()).every((r) => r.name !== NAME));
  const added = await actions.addConnectionAction({ label: "CRM", name: NAME, url: URL_, token: TOKEN, description: "Accounts and deals." });
  check("with the right token it is dialled, counted and added", "ok" in added && added.tools > 0, JSON.stringify(added));
  const [raw] = await sql`select * from mcp_servers where name = ${NAME}`;
  check("what is stored is sealed: neither the address nor the token is in the row",
    raw && !JSON.stringify(raw).includes(TOKEN) && !JSON.stringify(raw).includes(`127.0.0.1:${PORT}`) && raw.url_sealed.startsWith("v1.") && raw.token_sealed.startsWith("v1.") && raw.added_by === ADMIN.email);
  const twice = await actions.addConnectionAction({ label: "CRM", name: NAME, url: URL_, token: TOKEN, force: true });
  check("the same short name cannot be added twice", "error" in twice && /already a server/.test(twice.error));

  console.log("\n— in the registry and in a run —");
  const info = mcp.remoteServerInfo().find((r) => r.name === NAME);
  check("it joins the registry, as added on the page", info?.source === "hub" && info?.configured === true && info?.label === "CRM");
  check("dialled with its own token", mcp.remoteServerConfig(NAME)?.headers?.authorization === `Bearer ${TOKEN}`);
  const dir = await serverDirectory();
  check("the Connections page lists it as a remote connection added here", dir.entries.some((e) => e.name === NAME && e.connection.kind === "remote" && e.connection.source === "hub"));
  const { saveAgentAs } = await import("./src/lib/agentDesign.ts");
  const saved = await saveAgentAs({ id: ADMIN.id, roles: ADMIN.roles, source: "oauth", email: ADMIN.email }, null, {
    slug: `verify-conn-${stamp}`,
    name: `Verify conn ${stamp}`,
    instructions: "x",
    mcpServers: [{ name: NAME }],
  });
  agentId = "ok" in saved ? saved.id : null;
  check("an agent can be given it", Boolean(agentId) && (await db.getAgent(agentId))?.mcpServers?.some((e) => e.name === NAME));
  offered.length = 0;
  const run = await runAgentForPrincipal({ agentRef: `verify-conn-${stamp}`, prompt: "List the projects.", principal: { id: ADMIN.id, roles: ADMIN.roles, source: "oauth" } });
  check("and its run is offered the connection's tools", offered.some((t) => t.includes("pm_list_projects")), offered[0]?.join(", "));
  check("the run finished", run.kind === "done" || run.status === "done" || /Done/.test(JSON.stringify(run)), JSON.stringify(run).slice(0, 120));

  console.log("\n— changing it —");
  const badChange = await actions.updateConnectionAction(NAME, { removeToken: true });
  check("a change the server refuses (here, no token) is not saved unless asked", "error" in badChange && badChange.canForce && mcp.remoteServerConfig(NAME)?.headers?.authorization === `Bearer ${TOKEN}`);
  const relabel = await actions.updateConnectionAction(NAME, { label: "CRM (live)" });
  check("changing only the name keeps address and token", "ok" in relabel && mcp.remoteServerInfo().find((r) => r.name === NAME)?.label === "CRM (live)" && mcp.remoteServerConfig(NAME)?.headers?.authorization === `Bearer ${TOKEN}`);
  signIn(ANALYST);
  check("someone who is not an admin cannot change it", "error" in (await actions.updateConnectionAction(NAME, { label: "Mine" })));
  signIn(ADMIN);

  console.log("\n— when the key changes —");
  process.env.WORKOS_COOKIE_PASSWORD = `${WORKOS}-rotated`;
  await conn.loadHubConnections({ force: true });
  const problem = mcp.hubRemoteProblem(NAME);
  check("a connection that no longer opens is out of the registry, with the reason", !mcp.remoteServerNames().includes(NAME) && /WORKOS_COOKIE_PASSWORD has changed/.test(problem ?? ""), problem);
  const gone = unavailableServers([NAME], new Set());
  check("a run that names it says why, not that nobody declared it", /cannot be read/.test(gone[0]?.reason ?? "") && !/not declared/.test(gone[0]?.reason ?? ""), gone[0]?.reason);
  const half = await actions.updateConnectionAction(NAME, { label: "CRM" });
  check("changing only the name is still allowed", "ok" in half);
  const needBoth = await actions.updateConnectionAction(NAME, { token: TOKEN });
  check("a new token alone cannot be checked against an address that no longer opens", "error" in needBoth && /Type both again/.test(needBoth.error), needBoth.error);
  const fixed = await actions.updateConnectionAction(NAME, { url: URL_, token: TOKEN });
  check("typing both again fixes it", "ok" in fixed && mcp.remoteServerNames().includes(NAME) && !mcp.hubRemoteProblem(NAME));

  console.log("\n— removing it —");
  signIn(ANALYST);
  check("someone who is not an admin cannot remove it", "error" in (await actions.removeConnectionAction(NAME)));
  signIn(ADMIN);
  check("a bundled server's row is not a connection to remove", "error" in (await actions.removeConnectionAction("microsoft365")));
  const removed = await actions.removeConnectionAction(NAME);
  check("an admin removes it, and it leaves the registry", "ok" in removed && !mcp.remoteServerNames().includes(NAME));
  check("the agent that had it is told it is gone", /not declared/.test(unavailableServers([NAME], new Set())[0]?.reason ?? ""));
} finally {
  await sql`delete from mcp_servers where name = ${NAME} or name like ${`env-${stamp}`}`.catch(() => {});
  if (agentId) await sql`delete from agent_sessions where agent_id = ${agentId}`.catch(() => {});
  if (agentId) await db.deleteAgent(agentId).catch(() => {});
  await sql`delete from principals where id = any(${[ADMIN.id, ANALYST.id]})`.catch(() => {});
  await sql.end({ timeout: 5 });
  http.close();
  fixture.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: how the Connections page looks — screenshot it after npm run build.");
