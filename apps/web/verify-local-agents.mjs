// Verification of local agents: an agent placed "local" or "both" in the hub,
// synced into Claude Code and served through /api/mcp/agents/<slug>.
//
//   node --experimental-transform-types --env-file=apps/web/.env.local \
//        apps/web/verify-local-agents.mjs
//
// No API key: the model runs in someone's Claude Code session, which is out of
// scope here. What is under test is everything the hub enforces — who may
// reach a local agent, that its tools are the hub's (dialled with the hub's
// credential), that its memory is its own, that the hub stops running a local
// agent, and what the export and the sync script hand to Claude Code.
//
// Drives the real servers through a real MCP client over InMemoryTransport,
// the real route handlers with real credentials, and a real remote MCP server
// (packages/mcp/remote-fixture) standing in for the PM-tool.
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Next resolves the `@/` alias to apps/web/src; raw Node does not. Harness-only.
    if (specifier.startsWith("@/")) {
      const base = new URL("./src/", import.meta.url);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier.slice(2) + ext, base);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      // Packages without an exports map (next/server) need the extension raw
      // Node will not guess.
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
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}

// --- a stand-in PM-tool, declared the way production declares the real one --
const FIXTURE_PORT = 8790 + Math.floor(Math.random() * 500);
const FIXTURE_TOKEN = `fixture-${Date.now()}`;
process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({
  "verify-pm": {
    url: `http://127.0.0.1:${FIXTURE_PORT}/mcp`,
    label: "PM-tool (fixture)",
    tokenEnv: "VERIFY_PM_TOKEN",
  },
});
process.env.VERIFY_PM_TOKEN = FIXTURE_TOKEN;
const fixture = spawn(
  process.execPath,
  [fileURLToPath(new URL("../../packages/mcp/remote-fixture/server.mjs", import.meta.url))],
  { env: { ...process.env, PORT: String(FIXTURE_PORT), PM_TOOL_MCP_TOKEN: FIXTURE_TOKEN }, stdio: "pipe" },
);
await new Promise((resolve, reject) => {
  fixture.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  fixture.on("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  setTimeout(() => reject(new Error("fixture did not start")), 10_000);
});

const { buildHubMcpServer, toolNameForAgent, toolNameForSkill } = await import("./src/lib/mcp/hubServer.ts");
const { buildAgentMcpServer, resolveLocalAgent } = await import("./src/lib/mcp/agentServer.ts");
const { runnableAgent } = await import("./src/lib/agentRuns.ts");
const { resolveServer } = await import("./src/lib/runSession.ts");
const { renderAgentFiles, agentEndpoint } = await import("./src/lib/localAgents.ts");
const exportRoute = await import("./src/app/api/agents/export/route.ts");
const agentRoute = await import("./src/app/api/mcp/agents/[slug]/route.ts");
const db = await import("../../packages/db/src/index.ts");
const { issueApiCredential } = await import("../../packages/authz/src/issue.ts");
const sql = db.getSql();

const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
async function connect(server) {
  const client = new Client({ name: "verify", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}
const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), body: parse(r.content?.[0]?.text ?? "") };
};

const stamp = Date.now();
const p = (id, roles, extra = {}) => ({ id: `verify-local-${id}-${stamp}`, roles, source: "credential", ...extra });
const ANALYST = p("analyst", ["analyst"]);
const VIEWER = p("viewer", ["viewer"]);

const created = [];
const principalsMade = [];
const tmpDirs = [];
let exitCode = 0;

try {
  const mk = async (suffix, input) => {
    const a = await db.createAgent({ name: `Verify ${suffix}`, slug: `verify-local-${suffix}-${stamp}`, instructions: `You are ${suffix}.`, ...input });
    created.push(a.id);
    return a;
  };
  const hubOnly = await mk("hub", {});
  const local = await mk("local", {
    placement: "local",
    description: "Answers delivery questions from PM data.",
    model: "claude-sonnet-4-6",
    maxIterations: 12,
    mcpServers: [{ name: "verify-pm" }],
    knowledgeAll: true,
  });
  // Reads nothing: the default, and what "memory and tools only" must mean.
  const both = await mk("both", { placement: "both" });
  // Works out of two drawers.
  const scoped = await mk("scoped", {
    placement: "local",
    knowledgeCollections: [`verify-${stamp}-a`, `verify-${stamp}-b`],
  });

  // --- the column -------------------------------------------------------
  check("an agent with no placement runs on the hub", hubOnly.placement === "hub");
  check("placement is stored", local.placement === "local" && both.placement === "both");
  const back = await db.updateAgent(both.id, { description: "changed" });
  check("an unrelated update keeps the placement", back.placement === "both");
  let rejected = false;
  try {
    await sql`update agents set placement = 'laptop' where id = ${hubOnly.id}`;
  } catch {
    rejected = true;
  }
  check("the database refuses a placement it does not know", rejected);

  // --- per-agent server settings reach the run ---------------------------
  const withMailbox = resolveServer("microsoft365", undefined, undefined, { name: "microsoft365", mailbox: "secretary@example.test" });
  check("an agent's mailbox reaches the bundled server's environment", withMailbox?.env?.M365_MAILBOX === "secretary@example.test");
  check("an agent without one leaves the deployment default alone", resolveServer("microsoft365")?.env === undefined);

  const skill = await db.createSkill({
    agentId: local.id,
    slug: `verify-local-skill-${stamp}`,
    name: "Weekly status",
    description: "Summarise the week for one project.",
    promptTemplate: "Write the weekly status for {{project}}.",
    parameters: [{ name: "project", description: "Project code", required: true }],
  });

  // --- the hub stops running a local agent --------------------------------
  const refused = await runnableAgent(local.slug, ANALYST);
  check("the hub refuses to run a local-only agent", "error" in refused, refused.error);
  check("the hub still runs a 'both' agent", !("error" in (await runnableAgent(both.slug, ANALYST))));

  const hub = await connect(await buildHubMcpServer(ANALYST));
  const hubTools = await toolNames(hub);
  check("a local agent gets no hub_agent_* tool", !hubTools.includes(toolNameForAgent(local.slug)));
  check("a local agent's skill gets no hub_skill_* tool", !hubTools.includes(toolNameForSkill(skill.slug)));
  check("a 'both' agent keeps its hub tool", hubTools.includes(toolNameForAgent(both.slug)));
  await hub.close();

  const owner = await db.upsertPrincipal({ id: ANALYST.id, roles: ["analyst"] });
  principalsMade.push(owner.id);
  await db.createSchedule({ agentId: local.id, name: "nightly", prompt: "x", kind: "every", intervalMinutes: 60, ownerPrincipalId: owner.id });
  await db.createSchedule({ agentId: both.id, name: "nightly", prompt: "x", kind: "every", intervalMinutes: 60, ownerPrincipalId: owner.id });
  const considered = (await db.schedulesToConsider()).map((s) => s.agentId);
  check("the scheduler skips a local-only agent", !considered.includes(local.id));
  check("the scheduler still runs a 'both' agent", considered.includes(both.id));

  // --- who may reach a local agent --------------------------------------
  const r1 = await resolveLocalAgent(VIEWER, local.slug);
  check("a viewer cannot reach a local agent", r1.status === 403);
  const r2 = await resolveLocalAgent(ANALYST, hubOnly.slug);
  check("a hub-only agent has no local endpoint", r2.status === 404);
  const r3 = await resolveLocalAgent({ ...ANALYST, agentId: both.slug }, local.slug);
  check("a credential bound to another agent is refused", r3.status === 403);
  const r4 = await resolveLocalAgent({ ...ANALYST, agentId: local.slug }, local.slug);
  check("a credential bound to this agent (by slug) is served", "agent" in r4);
  check("an analyst reaches a local agent", "agent" in (await resolveLocalAgent(ANALYST, local.slug)));

  // --- what the local agent is served -----------------------------------
  const localClient = await connect(await buildAgentMcpServer(ANALYST, local));
  const localTools = await toolNames(localClient);
  check("memory tools are served", ["hub_memory_list", "hub_memory_write", "hub_memory_search", "hub_memory_set_active", "hub_memory_forget"].every((t) => localTools.includes(t)), localTools.join(", "));
  check("knowledge search is served to an agent that reads everything", localTools.includes("hub_search_knowledge"));

  // --- what each knowledge scope is served ------------------------------
  const noneClient = await connect(await buildAgentMcpServer(ANALYST, both));
  const noneTools = await toolNames(noneClient);
  check(
    "an agent that reads nothing is served no knowledge tools",
    !noneTools.includes("hub_search_knowledge") && !noneTools.includes("hub_get_document"),
    noneTools.join(", "),
  );
  check("but still its memory", noneTools.includes("hub_memory_list"));
  await noneClient.close();

  const scopedClient = await connect(await buildAgentMcpServer(ANALYST, scoped));
  const scopedSearch = (await scopedClient.listTools()).tools.find((t) => t.name === "hub_search_knowledge");
  check(
    "a scoped agent's search tool names its collections",
    scopedSearch?.description.includes(`verify-${stamp}-a`) && scopedSearch?.description.includes(`verify-${stamp}-b`),
    scopedSearch?.description,
  );
  const outside = await call(scopedClient, "hub_search_knowledge", { query: "anything", collection: "somewhere-else" });
  const outsideText = typeof outside.body === "string" ? outside.body : JSON.stringify(outside.body);
  check(
    "a collection outside its set is refused by name, not searched",
    /does not work from "somewhere-else"/.test(outsideText) && outsideText.includes(`verify-${stamp}-a`),
    outsideText.slice(0, 120),
  );
  await scopedClient.close();
  check("the agent's own tool server is proxied", localTools.includes("pm_list_projects"), localTools.join(", "));
  check("no hub_agent_* runner is offered to a local agent", !localTools.some((t) => t.startsWith("hub_agent_") || t === "hub_run_agent"));

  const listed = (await localClient.listTools()).tools.find((t) => t.name === "pm_list_tasks");
  check("a proxied tool keeps its input schema", Boolean(listed?.inputSchema?.properties && Object.keys(listed.inputSchema.properties).length), JSON.stringify(listed?.inputSchema?.properties ?? {}));

  const projects = await call(localClient, "pm_list_projects");
  check("a proxied call reaches the PM-tool with the hub's credential", !projects.isError && JSON.stringify(projects.body).includes("Helios"), JSON.stringify(projects.body).slice(0, 80));

  const wrote = await call(localClient, "hub_memory_write", { key: "review-day", content: "Weekly review is on Wednesday." });
  check("a local agent can write its memory", !wrote.isError && wrote.body.saved === "review-day");
  const mine = await db.listMemories(local.id);
  check("the memory lands on that agent", mine.some((m) => m.key === "review-day"));
  const theirs = await db.listMemories(both.id);
  check("and not on any other", !theirs.some((m) => m.key === "review-day"));

  const bothClient = await connect(await buildAgentMcpServer(ANALYST, both));
  const otherList = await call(bothClient, "hub_memory_search", { query: "Wednesday" });
  check("another local agent cannot find it", JSON.stringify(otherList.body).includes("No memories"));
  await bothClient.close();
  await localClient.close();

  await new Promise((r) => setTimeout(r, 300)); // recordLocalCall is fire-and-forget
  const activity = await db.localActivity(local.id);
  check("local tool calls are recorded on the hub", activity.calls >= 2 && activity.people === 1, JSON.stringify(activity));
  const runs = await sql`select count(*)::int as n from agent_sessions where agent_id = ${local.id}`;
  check("and are NOT recorded as hub runs", runs[0].n === 0);

  // --- the files Claude Code receives -----------------------------------
  const base = "https://hub.example.test";
  const files = renderAgentFiles(local, await db.listSkills(local.id), base);
  const sub = files.find((f) => f.path.startsWith("agents/"));
  const sk = files.find((f) => f.path.startsWith("skills/"));
  check("one sub-agent and one skill are rendered", files.length === 2 && sub && sk, files.map((f) => f.path).join(", "));
  check("the sub-agent is named with the hub- prefix", sub.content.includes(`name: hub-${local.slug}`));
  check("the sub-agent points at its own endpoint", sub.content.includes(agentEndpoint(base, local.slug)));
  check("the sub-agent carries the model and turn limit", sub.content.includes("model: claude-sonnet-4-6") && sub.content.includes("maxTurns: 12"));
  check("the sub-agent holds no secret, only an env reference", sub.content.includes("${HUB_TOKEN:-}") && !sub.content.includes(FIXTURE_TOKEN));
  check("the skill runs inside its agent", sk.content.includes("context: fork") && sk.content.includes(`agent: hub-${local.slug}`));
  check("the skill keeps its template and parameters", sk.content.includes("{{project}}") && sk.content.includes("`project` (required)"));

  // --- the routes, with real credentials ---------------------------------
  const admin = await db.upsertPrincipal({ id: `verify-local-admin-${stamp}`, roles: ["admin"] });
  const viewer = await db.upsertPrincipal({ id: VIEWER.id, roles: ["viewer"] });
  principalsMade.push(admin.id, viewer.id);
  const adminTok = (await issueApiCredential({ name: "verify", principalId: admin.id, actor: "verify" })).token;
  const viewerTok = (await issueApiCredential({ name: "verify", principalId: viewer.id, actor: "verify" })).token;
  const boundTok = (await issueApiCredential({ name: "verify", principalId: admin.id, agentId: both.slug, actor: "verify" })).token;

  const exportAs = async (tok) =>
    exportRoute.GET(new Request("https://hub.example.test/api/agents/export", tok ? { headers: { authorization: `Bearer ${tok}` } } : {}));

  check("the export refuses an anonymous caller", (await exportAs(null)).status === 401);
  check("the export refuses a viewer", (await exportAs(viewerTok)).status === 403);
  const exported = await (await exportAs(adminTok)).json();
  const slugs = exported.agents.map((a) => a.slug);
  check("the export includes local and both agents", slugs.includes(local.slug) && slugs.includes(both.slug));
  check("the export leaves hub-only agents out", !slugs.includes(hubOnly.slug));
  const boundExport = await (await exportAs(boundTok)).json();
  check("a bound credential exports its own agent only", boundExport.agents.length === 1 && boundExport.agents[0].slug === both.slug, boundExport.agents.map((a) => a.slug).join(", "));

  const rpc = (tok, slug, body) =>
    agentRoute.POST(
      new Request(`https://hub.example.test/api/mcp/agents/${slug}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    );
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const ok = await rpc(adminTok, local.slug, list);
  const okBody = await ok.json();
  check("the endpoint serves a local agent over HTTP", ok.status === 200 && okBody.result?.tools?.some((t) => t.name === "hub_memory_list"), String(ok.status));
  check("the endpoint refuses a hub-only agent", (await rpc(adminTok, hubOnly.slug, list)).status === 404);
  check("the endpoint refuses a viewer", (await rpc(viewerTok, local.slug, list)).status === 403);
  check("the endpoint refuses a credential bound elsewhere", (await rpc(boundTok, local.slug, list)).status === 403);

  // --- the sync script, against a hub that serves this export ------------
  const fakeHub = createServer((req, res) => {
    if (req.url !== "/api/agents/export") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ...exported,
      // A hostile entry: must be ignored, never written.
      files: [...exported.files, { path: "../../evil.md", content: "x" }, { path: "agents/mine.md", content: "x" }],
    }));
  });
  await new Promise((r) => fakeHub.listen(0, "127.0.0.1", r));
  const hubUrl = `http://127.0.0.1:${fakeHub.address().port}`;
  const project = mkdtempSync(join(tmpdir(), "hub-sync-"));
  tmpDirs.push(project);
  mkdirSync(join(project, ".claude", "agents"), { recursive: true });
  writeFileSync(join(project, ".claude", "agents", "mine.md"), "hand-made");
  const script = fileURLToPath(new URL("../../scripts/sync-hub-agents.mjs", import.meta.url));
  // Async: the fake hub answers from this same process, so a synchronous child
  // would block the very server it is waiting on.
  const run = async (url) =>
    (
      await promisify(execFile)(process.execPath, [script, "--hook"], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, HUB_URL: url },
      })
    ).stdout;

  const out = JSON.parse(await run(hubUrl));
  check("the hook asks Claude Code to reload skills", out.hookSpecificOutput?.reloadSkills === true);
  check("the hook tells the session which sub-agents exist", out.hookSpecificOutput?.additionalContext?.includes(`hub-${local.slug}`));
  const agentsDir = readdirSync(join(project, ".claude", "agents"));
  check("sub-agent files are written", agentsDir.includes(`hub-${local.slug}.md`) && agentsDir.includes(`hub-${both.slug}.md`), agentsDir.join(", "));
  check("skill files are written", existsSync(join(project, ".claude", "skills", `hub-${skill.slug}`, "SKILL.md")));
  check("a path outside .claude/ is never written", !existsSync(join(project, "..", "evil.md")) && !existsSync(join(project, "evil.md")));
  check("a hand-made agent is never overwritten", readFileSync(join(project, ".claude", "agents", "mine.md"), "utf8") === "hand-made");

  // The hub moves `local` back to hub-only: its files must go, the rest stay.
  exported.agents = exported.agents.filter((a) => a.slug !== local.slug);
  exported.files = exported.files.filter((f) => !f.path.includes(local.slug) && !f.path.includes(skill.slug));
  await run(hubUrl);
  check("an agent moved back to the hub is removed locally", !existsSync(join(project, ".claude", "agents", `hub-${local.slug}.md`)) && !existsSync(join(project, ".claude", "skills", `hub-${skill.slug}`)));
  check("other synced agents stay", existsSync(join(project, ".claude", "agents", `hub-${both.slug}.md`)));
  check("hand-made files survive a removal pass", existsSync(join(project, ".claude", "agents", "mine.md")));

  const offline = JSON.parse(await run("http://127.0.0.1:1"));
  check("an unreachable hub does not fail the session", offline.hookSpecificOutput?.hookEventName === "SessionStart");
  check("and keeps the last synced agents", existsSync(join(project, ".claude", "agents", `hub-${both.slug}.md`)));
  fakeHub.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  for (const id of created) await db.deleteAgent(id).catch(() => {});
  for (const id of principalsMade) await sql`delete from principals where id = ${id}`.catch(() => {});
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  fixture.kill();
  await sql.end({ timeout: 2 }).catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length || exitCode ? 1 : 0);
