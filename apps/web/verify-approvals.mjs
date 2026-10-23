// The approval gate (docs/approvals.md), driven end to end against a real
// database and a real remote MCP server standing in for the PM-tool:
//
//   node --experimental-transform-types --env-file=.env.local verify-approvals.mjs
//
// Needs DATABASE_URL and a migrated database. No API key: nothing here calls
// a model. What is proven: which calls are held and which pass; that a held
// call is not made; that only the right people can decide; that approving
// runs the very call that was held and records what it returned; and that
// the same gate stands at the per-agent endpoint and in the hub's MCP tools.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
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

// --- a stand-in PM-tool with one write tool (pm_create_task) ----------------
const FIXTURE_PORT = 8790 + Math.floor(Math.random() * 500);
const FIXTURE_TOKEN = `fixture-${Date.now()}`;
process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({
  "verify-pm": { url: `http://127.0.0.1:${FIXTURE_PORT}/mcp`, label: "PM-tool (fixture)", tokenEnv: "VERIFY_PM_TOKEN" },
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

const gate = await import("./src/lib/approvals.ts");
const { resolveServer } = await import("./src/lib/runSession.ts");
const { buildAgentMcpServer } = await import("./src/lib/mcp/agentServer.ts");
const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
const db = await import("../../packages/db/src/index.ts");
const { connectMcpServers, memoryServerConfig } = await import("../../packages/mcp/src/index.ts");
const sql = db.getSql();

const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
async function connect(server) {
  const client = new Client({ name: "verify", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content?.[0]?.text ?? "", body: parse(r.content?.[0]?.text ?? "") };
};

const stamp = Date.now();
const OWNER = { id: `verify-gate-owner-${stamp}`, roles: ["analyst"], source: "credential" };
const OTHER = { id: `verify-gate-other-${stamp}`, roles: ["analyst"], source: "credential" };
const ADMIN = { id: `verify-gate-admin-${stamp}`, roles: ["admin"], source: "credential" };
const principals = [OWNER, OTHER, ADMIN];
const agents = [];
const runs = [];

try {
  for (const p of principals) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.id });
  const asks = await db.createAgent({ slug: `verify-gate-asks-${stamp}`, name: "Verify asks", mcpServers: [{ name: "verify-pm" }] });
  const allows = await db.createAgent({ slug: `verify-gate-allows-${stamp}`, name: "Verify allows", mcpServers: [{ name: "verify-pm", writes: "allow" }] });
  agents.push(asks.id, allows.id);
  // An agent's own key: a credential bound to it.
  const BOUND = { id: OWNER.id, roles: ["analyst"], source: "credential", agentId: asks.id };

  // --- 1. the policy, as pure functions -------------------------------------
  console.log("— what is held —");
  const write = { name: "pm_create_task", server: "verify-pm", annotations: { readOnlyHint: false } };
  const read = { name: "pm_list_projects", server: "verify-pm", annotations: { readOnlyHint: true } };
  const bare = { name: "pm_mystery", server: "verify-pm" };
  check("a tool marked as a write is held", gate.needsApproval(write, { name: "verify-pm" }));
  check("a tool marked read-only passes", !gate.needsApproval(read, { name: "verify-pm" }));
  check("a tool with no annotation is held — not proven read-only is the safe reading", gate.needsApproval(bare, { name: "verify-pm" }));
  check("the agent's own memory is never held", !gate.needsApproval({ name: "memory_write", server: "memory" }, undefined));
  check("the hub's own tools are never held", !gate.needsApproval({ name: "hub_memory_write", server: "x" }, undefined));
  check('an entry with "writes": "allow" lets writes through', !gate.needsApproval(write, { name: "verify-pm", writes: "allow" }));
  check("anything but an explicit allow asks", gate.writesPolicy({ writes: "yes" }) === "ask" && gate.writesPolicy({}) === "ask" && gate.writesPolicy(undefined) === "ask");

  // --- 2. the executor, over a real connection ------------------------------
  console.log("\n— a run's tool calls —");
  const entry = asks.mcpServers[0];
  const mcp = await connectMcpServers([resolveServer("verify-pm", asks.id, undefined, entry), memoryServerConfig(asks.id)]);
  const exec = gate.gatedExecutor(mcp, { agentId: asks.id, principalId: OWNER.id, entries: asks.mcpServers });
  const listed = await exec("pm_list_projects", {});
  check("a read passes straight through to the upstream", /projects|Aurora|\[/.test(listed), listed.slice(0, 60));
  const held = await exec("pm_create_task", { projectId: "p1", title: "Held task" });
  const heldId = held.match(/proposal ([0-9a-f-]{36})/)?.[1];
  check("a write is held, and the model is told so in plain words", /HELD FOR APPROVAL/.test(held) && /NOT executed/.test(held) && Boolean(heldId), held.slice(0, 80));
  check("and told not to retry or assume it happened", /do not retry/.test(held) && /awaits approval/.test(held));
  const proposal = heldId ? await db.getProposal(heldId) : null;
  check(
    "the held call is recorded with its exact arguments",
    proposal?.status === "pending" && proposal.tool === "pm_create_task" && proposal.server === "verify-pm" &&
      proposal.args?.title === "Held task" && proposal.agentId === asks.id && proposal.principalId === OWNER.id,
    JSON.stringify(proposal?.args),
  );
  check("with the tool's own description, for the reader", /Create a task/.test(proposal?.description ?? ""), proposal?.description);
  const mem = await exec("memory_write", { key: "verify-gate", content: "remembered" });
  check("memory writes are not held: the agent's notebook never leaves the hub", !/HELD/.test(mem) && !/error/i.test(mem), mem.slice(0, 60));
  await mcp.close();

  const allowEntry = allows.mcpServers[0];
  const mcp2 = await connectMcpServers([resolveServer("verify-pm", allows.id, undefined, allowEntry)]);
  const direct = await gate.gatedExecutor(mcp2, { agentId: allows.id, principalId: OWNER.id, entries: allows.mcpServers })("pm_create_task", { projectId: "p1", title: "Direct" });
  check('an entry an admin set to "allow" writes without asking', /created/.test(direct) && /Direct/.test(direct), direct.slice(0, 80));
  await mcp2.close();

  // --- 3. who decides, and what approving does ------------------------------
  console.log("\n— deciding —");
  check("someone else may not decide", !(await gate.mayDecide(OTHER, proposal)));
  check("the person the run acted as may", await gate.mayDecide(OWNER, proposal));
  check("an admin may", await gate.mayDecide(ADMIN, proposal));
  check("a credential bound to the agent may not — an agent cannot approve its own writes", !(await gate.mayDecide(BOUND, proposal)));
  const notYours = await gate.reject(heldId, OTHER, "no");
  check("a rejection by someone else is refused", "error" in notYours, notYours.error);
  const byAgent = await gate.approve(heldId, BOUND);
  check("an approval by the agent's own credential is refused", "error" in byAgent, byAgent.error);
  check("and the proposal is still pending", (await db.getProposal(heldId))?.status === "pending");

  const approved = await gate.approve(heldId, OWNER);
  check(
    "approving runs the held call and records what the tool returned",
    !("error" in approved) && approved.proposal.status === "executed" && /Held task/.test(approved.proposal.result ?? ""),
    approved.proposal?.result?.slice(0, 80) ?? approved.error,
  );
  check("with the hub's credential for that server, not a person's", /"by":\s*"fixture-/.test(approved.proposal?.result ?? ""), approved.proposal?.result?.slice(0, 80));
  check("and who decided, when", approved.proposal?.decidedBy === OWNER.id && Boolean(approved.proposal?.decidedAt));
  const twice = await gate.approve(heldId, ADMIN);
  check("a decided proposal cannot be decided again", "error" in twice && /already executed/.test(twice.error), twice.error);

  const second = await db.createProposal({ agentId: asks.id, principalId: OWNER.id, server: "verify-pm", tool: "pm_create_task", args: { projectId: "p1", title: "Second" } });
  const rejected = await gate.reject(second.id, ADMIN, "Not this week.");
  check("an admin can reject, with a note", !("error" in rejected) && rejected.proposal.status === "rejected" && rejected.proposal.note === "Not this week.");
  check("a rejected proposal cannot then be approved", "error" in (await gate.approve(second.id, ADMIN)));

  const orphan = await db.createProposal({ agentId: asks.id, principalId: OWNER.id, server: "not-declared", tool: "x_write", args: {} });
  const failed = await gate.approve(orphan.id, ADMIN);
  check(
    "approving a call to a server this deployment no longer declares fails on the record, not silently",
    !("error" in failed) && failed.proposal.status === "failed" && /not a server/.test(failed.proposal.error ?? ""),
    failed.proposal?.error ?? failed.error,
  );
  check("pendingProposalCount counts only what is waiting", (await db.pendingProposalCount(OWNER.id)) === 0);

  // --- 4. the per-agent endpoint (a local agent in Claude Code) ------------
  console.log("\n— the per-agent endpoint —");
  await db.updateAgent(asks.id, { placement: "both" });
  const local = await connect(await buildAgentMcpServer(OWNER, (await db.getAgent(asks.id))));
  const viaLocal = await call(local, "pm_create_task", { projectId: "p1", title: "From Claude Code" });
  const localId = String(viaLocal.text).match(/proposal ([0-9a-f-]{36})/)?.[1];
  check("a local agent's write is held the same way", /HELD FOR APPROVAL/.test(viaLocal.text) && Boolean(localId), viaLocal.text.slice(0, 60));
  const localProposal = localId ? await db.getProposal(localId) : null;
  check("and recorded against the agent and the person it acted as", localProposal?.agentId === asks.id && localProposal?.principalId === OWNER.id && localProposal?.args?.title === "From Claude Code");
  const viaLocalRead = await call(local, "pm_list_projects", {});
  check("its reads still pass through", !viaLocalRead.isError && !/HELD/.test(viaLocalRead.text));
  await local.close();

  // --- 5. the hub's MCP tools ----------------------------------------------
  console.log("\n— from a client —");
  const hubOwner = await connect(await buildHubMcpServer(OWNER));
  const mine = await call(hubOwner, "hub_list_proposals", {});
  check("hub_list_proposals shows the person their pending writes", Array.isArray(mine.body) && mine.body.some((p) => p.proposal === localId), mine.text.slice(0, 80));
  const hubOther = await connect(await buildHubMcpServer(OTHER));
  const theirs = await call(hubOther, "hub_list_proposals", {});
  check("and nothing of anyone else's", /No pending proposals/.test(theirs.text), theirs.text.slice(0, 60));
  const hubBound = await connect(await buildHubMcpServer(BOUND));
  const bound = await call(hubBound, "hub_decide_proposal", { proposal: localId, decision: "approve" });
  check("hub_decide_proposal refuses the agent's own credential", bound.isError, bound.text.slice(0, 60));
  const decided = await call(hubOwner, "hub_decide_proposal", { proposal: localId, decision: "approve" });
  check("and lets the person approve: the call runs and its result comes back", !decided.isError && decided.body?.status === "executed" && /From Claude Code/.test(decided.body?.result ?? ""), decided.text.slice(0, 80));

  // hub_run_status carries what a run left waiting.
  const runId = await db.startRun({ prompt: "verify", agentId: asks.id, principalId: OWNER.id });
  runs.push(runId);
  await db.finishRun(runId, { output: "done, pending your approval" });
  const left = await db.createProposal({ agentId: asks.id, runId, principalId: OWNER.id, server: "verify-pm", tool: "pm_create_task", args: { projectId: "p1", title: "Left waiting" } });
  const status = await call(hubOwner, "hub_run_status", { runId });
  check("hub_run_status names the writes a run left waiting", status.body?.heldForApproval?.[0]?.proposal === left.id, status.text.slice(0, 100));
  for (const c of [hubOwner, hubOther, hubBound]) await c.close();
} catch (err) {
  console.error("\nverify-approvals crashed:", err);
  checks.push({ label: "script completed", ok: false });
} finally {
  for (const id of agents) await db.deleteAgent(id).catch(() => {});
  for (const id of runs) await sql`delete from agent_sessions where id = ${id}`.catch(() => {});
  for (const p of principals) await sql`delete from principals where id = ${p.id}`.catch(() => {});
  fixture.kill();
  await sql.end({ timeout: 2 }).catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
