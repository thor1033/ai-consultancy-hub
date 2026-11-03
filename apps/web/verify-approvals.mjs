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
// A colleague a write can be sent to, one whose role cannot decide writes,
// and a service identity with no email: only the first is someone to send to.
const DITLEV = { id: `verify-gate-ditlev-${stamp}`, roles: ["analyst"], source: "oauth", email: `ditlev-${stamp}@verify.test` };
const READER = { id: `verify-gate-reader-${stamp}`, roles: ["viewer"], source: "oauth", email: `reader-${stamp}@verify.test` };
// A second person who can decide, so a write can wait on two people at once.
const THOR = { id: `verify-gate-thor-${stamp}`, roles: ["analyst"], source: "oauth", email: `thor-${stamp}@verify.test` };
const principals = [OWNER, OTHER, ADMIN, DITLEV, READER, THOR];
const agents = [];
const runs = [];

try {
  for (const p of principals) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.id, email: p.email ?? null });
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
  const gated = gate.gate(mcp, { agentId: asks.id, principalId: OWNER.id, entries: asks.mcpServers });
  const exec = gated.execute;
  const shownWrite = gated.tools.find((t) => t.name === "pm_create_task");
  const shownRead = gated.tools.find((t) => t.name === "pm_list_projects");
  check(
    "a tool that will be held asks the model for a reason, as a required argument",
    shownWrite?.input_schema?.properties?.reason?.type === "string" && shownWrite.input_schema.required?.includes("reason") && shownWrite.input_schema.required?.includes("title"),
    JSON.stringify(shownWrite?.input_schema?.required),
  );
  check("a read tool is shown as the upstream declared it", Boolean(shownRead) && !shownRead.input_schema?.properties?.reason);
  check("the upstream's own schema is not changed by showing it", !mcp.tools.find((t) => t.name === "pm_create_task")?.input_schema?.properties?.reason);
  const listed = await exec("pm_list_projects", {});
  check("a read passes straight through to the upstream", /projects|Aurora|\[/.test(listed), listed.slice(0, 60));
  const held = await exec("pm_create_task", { projectId: "p1", title: "Held task", reason: "Agreed at 00:19:27: \"så prøver jeg at få det færdigt tæt på mandag\"." });
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
  check("the reason is stored on the proposal, and taken out of the arguments the upstream will get", /tæt på mandag/.test(proposal?.reason ?? "") && !("reason" in (proposal?.args ?? {})), proposal?.reason);
  const silent = await exec("pm_create_task", { projectId: "p1", title: "No reason given" });
  const silentId = silent.match(/proposal ([0-9a-f-]{36})/)?.[1];
  const silentProposal = silentId ? await db.getProposal(silentId) : null;
  check("a write without a reason is still held, with no reason recorded", silentProposal?.status === "pending" && silentProposal.reason === null);
  if (silentId) await db.rejectProposal(silentId, ADMIN.id, "test");
  // Memory: unheld while the run has read nothing from outside, held once it
  // has (docs/data-protection-review.md, F10). A fresh gate is a fresh run.
  const fresh = gate.gate(mcp, { agentId: asks.id, principalId: OWNER.id, entries: asks.mcpServers });
  const mem = await fresh.execute("memory_write", { key: "verify-gate", content: "remembered" });
  check("a memory write before reading anything outside is not held: the agent's own notebook", !/HELD/.test(mem) && !/error/i.test(mem), mem.slice(0, 60));
  const tainted = await exec("memory_write", { key: "verify-gate-after", content: "remembered after a read" });
  const [memProposal] = await sql`select id, reason from proposals where agent_id = ${asks.id} and tool = 'memory_write'`;
  check("after the run read from verify-pm, a memory write is held, with the hub's reason", /HELD FOR APPROVAL/.test(tainted) && /verify-pm/.test(memProposal?.reason ?? ""), memProposal?.reason);
  // Rejected here, so the count of waiting proposals below is about the PM-tool calls alone.
  if (memProposal) await gate.reject(memProposal.id, { id: OWNER.id, roles: ["analyst"], source: "credential" }, "verify: cleared");
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
  check("the call that ran carried no reason argument", !/reason/.test(approved.proposal?.result ?? ""), approved.proposal?.result?.slice(0, 80));
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

  // --- 3b. sending one on --------------------------------------------------
  console.log("\n— sending one on —");
  const people = await gate.peopleToSendTo(OWNER);
  check(
    "the people a write can be sent to: a colleague who can decide, not a viewer, not a service identity, not yourself",
    people.some((x) => x.id === DITLEV.id) && !people.some((x) => x.id === READER.id || x.id === OTHER.id || x.id === OWNER.id),
    people.filter((x) => x.id.includes(String(stamp))).map((x) => x.name).join(", "),
  );
  const toSend = await db.createProposal({ agentId: asks.id, principalId: OWNER.id, server: "verify-pm", tool: "pm_create_task", args: { projectId: "p1", title: "For Ditlev" }, reason: "Commercial: his call." });
  check("before it is sent, the colleague may not decide it", !(await gate.mayDecide(DITLEV, toSend)));
  const byStranger = await gate.sendOn(toSend.id, OTHER, [DITLEV.id], "x");
  check("someone who may not decide it cannot send it on", "error" in byStranger, byStranger.error);
  const toReader = await gate.sendOn(toSend.id, OWNER, [READER.id], "x");
  check("it cannot be sent to someone whose role cannot decide writes", "error" in toReader && /cannot decide/.test(toReader.error), toReader.error);
  const toSelf = await gate.sendOn(toSend.id, OWNER, [OWNER.id], "x");
  check("nor to yourself", "error" in toSelf, toSelf.error);
  const sentOn = await gate.sendOn(toSend.id, OWNER, [DITLEV.id], "Your call — commercial.");
  check(
    "sent to a colleague: recorded with who sent it, when, and the note",
    !("error" in sentOn) && sentOn.proposal.sentTo.map((x) => x.id).join() === DITLEV.id && sentOn.proposal.assignedBy === OWNER.id && Boolean(sentOn.proposal.assignedAt) && sentOn.proposal.assignNote === "Your call — commercial.",
    JSON.stringify({ to: sentOn.proposal?.sentTo, note: sentOn.proposal?.assignNote }),
  );
  check("the colleague may now decide it", await gate.mayDecide(DITLEV, sentOn.proposal));
  check("and the person it was sent from still may — a handoff never strands a write", await gate.mayDecide(OWNER, sentOn.proposal));
  check("an unrelated person still may not", !(await gate.mayDecide(OTHER, sentOn.proposal)));
  const theirList = await db.listProposals({ visibleTo: DITLEV.id, status: "pending" });
  check("it appears in the colleague's list", theirList.some((x) => x.id === toSend.id && x.sentTo[0]?.name === DITLEV.id));
  check("and counts as waiting on them, not on the sender", (await db.waitingOnCount(DITLEV.id)) === 1 && !(await db.listProposals({ visibleTo: OTHER.id, status: "pending" })).some((x) => x.id === toSend.id));
  const back = await gate.sendOn(toSend.id, OWNER, []);
  check("taking it back clears the handoff", !("error" in back) && back.proposal.sentTo.length === 0 && back.proposal.assignNote === null);
  await gate.sendOn(toSend.id, OWNER, [DITLEV.id], "Again.");
  const ditlevApproves = await gate.approve(toSend.id, DITLEV);
  check("the colleague approves: the call runs, attributed to them", !("error" in ditlevApproves) && ditlevApproves.proposal.status === "executed" && ditlevApproves.proposal.decidedBy === DITLEV.id, ditlevApproves.proposal?.status ?? ditlevApproves.error);
  const late = await gate.sendOn(toSend.id, OWNER, [DITLEV.id], "too late");
  check("a decided proposal cannot be sent on", "error" in late && /already executed/.test(late.error), late.error);

  // --- 3c. to several people at once --------------------------------------
  console.log("\n— to several people —");
  const both = await db.createProposal({ agentId: asks.id, principalId: OWNER.id, server: "verify-pm", tool: "pm_create_task", args: { projectId: "p1", title: "For both" } });
  const mixed = await gate.sendOn(both.id, OWNER, [DITLEV.id, READER.id], "x");
  check("one person in the list who cannot decide sends it to nobody", "error" in mixed && (await db.getProposal(both.id)).sentTo.length === 0, mixed.error);
  const toBoth = await gate.sendOn(both.id, OWNER, [THOR.id, DITLEV.id, THOR.id], "Either of you.");
  check(
    "sent to two people: both recorded, in the order picked, once each",
    !("error" in toBoth) && toBoth.proposal.sentTo.map((x) => x.id).join() === `${THOR.id},${DITLEV.id}`,
    JSON.stringify(toBoth.proposal?.sentTo),
  );
  check("each of them may decide it", (await gate.mayDecide(THOR, toBoth.proposal)) && (await gate.mayDecide(DITLEV, toBoth.proposal)));
  check(
    "it waits on each of them, and shows in each one's list",
    (await db.waitingOnCount(THOR.id)) === 1 && (await db.waitingOnCount(DITLEV.id)) === 1 &&
      (await db.listProposals({ visibleTo: THOR.id, status: "pending" })).some((x) => x.id === both.id) &&
      (await db.listProposals({ visibleTo: DITLEV.id, status: "pending" })).some((x) => x.id === both.id),
  );
  check("and no longer on the sender, who still may decide it", (await db.waitingOnCount(OWNER.id)) === 0 && (await gate.mayDecide(OWNER, toBoth.proposal)));
  const withSelf = await gate.sendOn(both.id, OWNER, [OWNER.id, DITLEV.id], "Us two.");
  check("the sender may keep it waiting on themselves too", !("error" in withSelf) && (await db.waitingOnCount(OWNER.id)) === 1 && (await db.waitingOnCount(DITLEV.id)) === 1);
  await gate.sendOn(both.id, OWNER, [THOR.id, DITLEV.id], "Either of you.");
  const [racer1, racer2] = await Promise.all([gate.approve(both.id, THOR), gate.approve(both.id, DITLEV)]);
  const winners = [racer1, racer2].filter((r) => !("error" in r) && r.proposal.decidedBy && r.proposal.status === "executed");
  const after = await db.getProposal(both.id);
  check(
    "both approve at once: the call runs once, attributed to whoever was first",
    after.status === "executed" && [THOR.id, DITLEV.id].includes(after.decidedBy) && [racer1, racer2].some((r) => "error" in r),
    `${after.status} by ${after.decidedBy}; ${[racer1, racer2].map((r) => ("error" in r ? r.error : "ok")).join(" / ")}`,
  );
  check("and it waits on nobody afterwards", (await db.waitingOnCount(THOR.id)) === 0 && (await db.waitingOnCount(DITLEV.id)) === 0, `${winners.length}`);

  // --- 3d. an agent that sends its approvals to people ----------------------
  console.log("\n— an agent's own setting —");
  const secretary = await db.createAgent({ slug: `verify-gate-sec-${stamp}`, name: "Verify secretary", mcpServers: [{ name: "verify-pm" }], sendApprovalsTo: [THOR.id, DITLEV.id] });
  agents.push(secretary.id);
  const heldTool = { name: "pm_create_task", server: "verify-pm", description: "Create a task", inputSchema: { type: "object", properties: {} } };
  const auto = await gate.hold(heldTool, { projectId: "p1", title: "From a meeting", reason: "Decided on Tuesday." }, { agentId: secretary.id, principalId: OWNER.id });
  check(
    "a write it holds goes to both people as it is made, sent by the agent's setting",
    auto.sentTo.map((x) => x.id).join() === `${THOR.id},${DITLEV.id}` && auto.assignedBy === null && Boolean(auto.assignedAt),
    JSON.stringify(auto.sentTo),
  );
  check("both can decide it, and the person the run acted as still can", (await gate.mayDecide(THOR, auto)) && (await gate.mayDecide(DITLEV, auto)) && (await gate.mayDecide(OWNER, auto)));
  await gate.reject(auto.id, THOR, "test");
  await sql`update principals set roles = ${["viewer"]} where id = ${THOR.id}`;
  const demoted = await gate.hold(heldTool, { projectId: "p1", title: "After a role change" }, { agentId: secretary.id, principalId: OWNER.id });
  check("someone in the setting who has since lost the role is skipped, not sent to", demoted.sentTo.map((x) => x.id).join() === DITLEV.id, JSON.stringify(demoted.sentTo));
  await sql`update principals set roles = ${["analyst"]} where id = ${THOR.id}`;
  await gate.reject(demoted.id, DITLEV, "test");
  const plain = await gate.hold(heldTool, { projectId: "p1", title: "No setting" }, { agentId: asks.id, principalId: OWNER.id });
  check("an agent without the setting: it waits on the person the run acted as, as before", plain.sentTo.length === 0 && (await db.waitingOnCount(OWNER.id)) === 1);
  await gate.reject(plain.id, OWNER, "test");

  const { saveAgentAs } = await import("./src/lib/agentDesign.ts");
  const refused = await saveAgentAs(ADMIN, secretary.id, { slug: secretary.slug, name: secretary.name, sendApprovalsTo: [DITLEV.id, READER.id] });
  check("the setting cannot name someone whose role cannot decide", "error" in refused && /cannot decide/.test(refused.error), refused.error);
  const byStranger2 = await saveAgentAs(OTHER, secretary.id, { slug: secretary.slug, name: secretary.name, sendApprovalsTo: [OTHER.id] });
  check("and only someone who may change agents may change it", "error" in byStranger2);
  const kept = await saveAgentAs(ADMIN, secretary.id, { slug: secretary.slug, name: "Verify secretary", instructions: "A new brief." });
  check("saving another field keeps it", !("error" in kept) && (await db.getAgent(secretary.id)).sendApprovalsTo.join() === `${THOR.id},${DITLEV.id}`);

  const erasedFrom = await gate.hold(heldTool, { projectId: "p1", title: "Before an erasure" }, { agentId: secretary.id, principalId: OWNER.id });
  await db.erasePerson(THOR.id, "verify");
  const afterErase = await db.getProposal(erasedFrom.id);
  check(
    "erasing a person takes them out of every list: the proposal and the agent's setting",
    afterErase.sentTo.map((x) => x.id).join() === DITLEV.id && (await db.getAgent(secretary.id)).sendApprovalsTo.join() === DITLEV.id,
    JSON.stringify(afterErase.sentTo),
  );
  await gate.reject(erasedFrom.id, DITLEV, "test");
  await db.upsertPrincipal({ id: THOR.id, roles: THOR.roles, displayName: THOR.id, email: THOR.email });

  // --- 4. the per-agent endpoint (a local agent in Claude Code) ------------
  console.log("\n— the per-agent endpoint —");
  await db.updateAgent(asks.id, { placement: "both" });
  const local = await connect(await buildAgentMcpServer(OWNER, (await db.getAgent(asks.id))));
  const localTools = (await local.listTools()).tools;
  const localWrite = localTools.find((t) => t.name === "pm_create_task");
  const localRead = localTools.find((t) => t.name === "pm_list_projects");
  check(
    "a local agent's held tool asks for the reason too; its reads do not",
    Boolean(localWrite?.inputSchema?.properties?.reason) && localWrite.inputSchema.required?.includes("reason") && !localRead?.inputSchema?.properties?.reason,
    JSON.stringify(localWrite?.inputSchema?.required),
  );
  const viaLocal = await call(local, "pm_create_task", { projectId: "p1", title: "From Claude Code", reason: "Asked for in the session." });
  const localId = String(viaLocal.text).match(/proposal ([0-9a-f-]{36})/)?.[1];
  check("a local agent's write is held the same way", /HELD FOR APPROVAL/.test(viaLocal.text) && Boolean(localId), viaLocal.text.slice(0, 60));
  const localProposal = localId ? await db.getProposal(localId) : null;
  check("and recorded against the agent and the person it acted as", localProposal?.agentId === asks.id && localProposal?.principalId === OWNER.id && localProposal?.args?.title === "From Claude Code");
  check("with its reason, and the arguments clean", localProposal?.reason === "Asked for in the session." && !("reason" in (localProposal?.args ?? {})));
  const viaLocalRead = await call(local, "pm_list_projects", {});
  check("its reads still pass through", !viaLocalRead.isError && !/HELD/.test(viaLocalRead.text));
  await local.close();

  // --- 5. the hub's MCP tools ----------------------------------------------
  console.log("\n— from a client —");
  const hubOwner = await connect(await buildHubMcpServer(OWNER));
  const mine = await call(hubOwner, "hub_list_proposals", {});
  check("hub_list_proposals shows the person their pending writes", Array.isArray(mine.body) && mine.body.some((p) => p.proposal === localId), mine.text.slice(0, 80));
  check("with the reason beside the arguments", Array.isArray(mine.body) && mine.body.find((p) => p.proposal === localId)?.reason === "Asked for in the session.");
  const fromClaude = await db.createProposal({ agentId: asks.id, principalId: OWNER.id, server: "verify-pm", tool: "pm_create_task", args: { projectId: "p1", title: "Via Claude Code" } });
  const viaTool = await call(hubOwner, "hub_send_proposal", { proposals: [fromClaude.id], to: DITLEV.email, note: "From the terminal." });
  check("hub_send_proposal sends by email from Claude Code", !viaTool.isError && (await db.getProposal(fromClaude.id))?.sentTo.map((x) => x.id).join() === DITLEV.id, viaTool.text.slice(0, 100));
  const viaToolBoth = await call(hubOwner, "hub_send_proposal", { proposals: [fromClaude.id], to: [DITLEV.email, THOR.email] });
  check("and to several people in one call", !viaToolBoth.isError && (await db.getProposal(fromClaude.id))?.sentTo.map((x) => x.id).join() === `${DITLEV.id},${THOR.id}`, viaToolBoth.text.slice(0, 100));
  const listedNow = await call(hubOwner, "hub_list_proposals", {});
  check("hub_list_proposals names everyone it waits on", Array.isArray(listedNow.body) && listedNow.body.find((p) => p.proposal === fromClaude.id)?.sentTo?.length === 2);
  const nobody = await call(hubOwner, "hub_send_proposal", { proposals: [fromClaude.id], to: [DITLEV.email, "nobody-at-all"] });
  check(
    "one name that matches no one sends nothing, and says who can decide",
    nobody.isError && /People who can/.test(nobody.text) && /Nothing was sent/.test(nobody.text) && (await db.getProposal(fromClaude.id))?.sentTo.length === 2,
    nobody.text.slice(0, 100),
  );
  await gate.reject(fromClaude.id, ADMIN, "test");
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
