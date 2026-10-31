// One agent asking another while it runs (lib/askAgents.ts, docs/agent-patterns.md),
// driven through the shipping run path against a real database.
//
//   node --experimental-transform-types --env-file=.env.local verify-asks.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend: a
// throwaway HTTP server stands in for the Messages API and plays both agents
// by their briefs; a throwaway remote MCP server stands in for the PM-tool so
// the asked agent has a write to propose.
//
// What is proven: a coordinator is offered agents_ask listing exactly the
// agents its entry allows that are on; asking runs the worker AS THE SAME
// PERSON, under the coordinator's run, one deep; the worker is offered no
// ask tool (depth) and no memory tools (it keeps none); the worker's write is
// held for approval; the answer comes back into the coordinator's run and its
// timeline shows the ask as a tool call; an agent not on the list is refused
// in words; the budget stops a run that asks without end.
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
      for (const ext of [".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
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
const COORD = `verify-asks-coordinator-${stamp}`;
const WORKER = `verify-asks-worker-${stamp}`;
const OFF = `verify-asks-off-${stamp}`;
const STRANGER = `verify-asks-stranger-${stamp}`;

// ── the stand-in PM-tool, so the worker has a write to propose ──────────────
const FIXTURE_PORT = 8790 + Math.floor(Math.random() * 500);
const FIXTURE_TOKEN = `fixture-${stamp}`;
process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({ "verify-pm": { url: `http://127.0.0.1:${FIXTURE_PORT}/mcp`, label: "PM-tool (fixture)", tokenEnv: "VERIFY_PM_TOKEN" } });
process.env.VERIFY_PM_TOKEN = FIXTURE_TOKEN;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("../../packages/mcp/remote-fixture/server.mjs", import.meta.url))], {
  env: { ...process.env, PORT: String(FIXTURE_PORT), PM_TOOL_MCP_TOKEN: FIXTURE_TOKEN },
  stdio: "pipe",
});
await new Promise((resolve, reject) => {
  fixture.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  fixture.on("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  setTimeout(() => reject(new Error("fixture did not start")), 10_000);
});

// ── the stand-in Messages API: plays each agent by its brief ────────────────
// mode "normal": the coordinator asks the worker once, then answers with what
// came back; the worker proposes a task (held) and answers. "greedy": the
// coordinator asks until the tool refuses. "stranger": it asks a slug it may
// not. Every request is kept: the tools each agent was offered are the point.
let mode = "normal";
const calls = [];
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n"));
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const system = textOf(body.system);
  const who = /COORDINATOR BRIEF/.test(system) ? "coordinator" : /WORKER BRIEF/.test(system) ? "worker" : "other";
  const last = body.messages.at(-1);
  const lastResult = last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? textOf(last.content) : null;
  const asksSoFar = body.messages.filter((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === "agents_ask")).length;
  calls.push({ who, tools: (body.tools ?? []).map((t) => t.name), askEnum: (body.tools ?? []).find((t) => t.name === "agents_ask")?.input_schema?.properties?.agent?.enum, prompt: textOf(last?.content), lastResult });
  let blocks;
  let stop = "end_turn";
  if (who === "coordinator") {
    const wantsAsk = mode === "normal" ? asksSoFar === 0 : mode === "stranger" ? asksSoFar === 0 : !/times in this run, which is the limit/.test(lastResult ?? "");
    if (wantsAsk && (body.tools ?? []).some((t) => t.name === "agents_ask")) {
      const target = mode === "stranger" ? STRANGER : WORKER;
      blocks = [{ type: "tool_use", id: `tu_${calls.length}`, name: "agents_ask", input: { agent: target, task: `Count the beans in jar ${asksSoFar + 1}.` } }];
      stop = "tool_use";
    } else blocks = [{ type: "text", text: `Coordinator's answer. ${lastResult ?? "(asked nobody)"}` }];
  } else if (who === "worker") {
    if (!lastResult && (body.tools ?? []).some((t) => t.name === "pm_create_task")) {
      blocks = [{ type: "tool_use", id: `tu_${calls.length}`, name: "pm_create_task", input: { projectId: "p1", title: "Beans counted", reason: "The brief asked for a record." } }];
      stop = "tool_use";
    } else blocks = [{ type: "text", text: "forty-two beans" }];
  } else blocks = [{ type: "text", text: "Other." }];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { id: `m${calls.length}`, type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      send({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send({ type: "content_block_stop", index });
  });
  send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
delete process.env.LANGFUSE_PUBLIC_KEY;

const db = await import("../../packages/db/src/index.ts");
const { runAgentForPrincipal } = await import("./src/lib/agentRuns.ts");
const { ASK_BUDGET, ASK_MAX_DEPTH, askTool, askExecutor } = await import("./src/lib/askAgents.ts");
const sql = db.getSql();
const PERSON = { id: `verify-asks-person-${stamp}`, roles: ["analyst"], source: "credential" };
const made = [];

try {
  // ── 0. the tool, pure ──────────────────────────────────────────────────────
  console.log("— the tool —");
  const tool = askTool([{ slug: "a", name: "A", description: "does a" }, { slug: "b", name: "B", description: "" }]);
  check("the tool lists whom it may ask, in the description and as the only values the schema allows", /- a: A — does a/.test(tool.description) && JSON.stringify(tool.input_schema.properties.agent.enum) === '["a","b"]' && tool.input_schema.required.join() === "agent,task");
  const seen = [];
  const exec = askExecutor({ allowed: [{ slug: "a", name: "A", description: "" }], start: async (slug, task) => { seen.push({ slug, task }); return { kind: "done", runId: "r1", output: "yes" }; } });
  check("an ask of an allowed agent runs it with the task and returns its answer, naming the run", /^A answered \(run r1\):\n\nyes$/.test(await exec({ agent: "a", task: "do" })) && seen[0].task === "do");
  check("an ask of an agent not on the list is refused, naming the list", /You may not ask "z"\. You may ask: a\./.test(await exec({ agent: "z", task: "do" })) && seen.length === 1);
  check("an empty task is refused", /Say what you want A to do/.test(await exec({ agent: "a", task: " " })));
  const slow = askExecutor({ allowed: [{ slug: "a", name: "A", description: "" }], start: async () => ({ kind: "running", runId: "r2" }) });
  check("an agent that outlives the wait is reported, with where its answer lands", /A is still working after 10 minutes \(run r2\)/.test(await slow({ agent: "a", task: "do" })));
  check("the depth limit is one: an asked agent asks nobody", ASK_MAX_DEPTH === 1);

  // ── 1. the agents ─────────────────────────────────────────────────────────
  await db.upsertPrincipal({ id: PERSON.id, roles: PERSON.roles, displayName: "Verify asks", email: null });
  const worker = await db.createAgent({ slug: WORKER, name: "Worker", description: "counts beans", instructions: "WORKER BRIEF", keepsMemory: false, mcpServers: [{ name: "verify-pm" }, { name: "agents", agents: [COORD] }] });
  const off = await db.createAgent({ slug: OFF, name: "Off", instructions: "x", enabled: false });
  const stranger = await db.createAgent({ slug: STRANGER, name: "Stranger", instructions: "x" });
  // Stamina above the budget, so it is the budget that stops the greedy run
  // below and not the cap on tool rounds.
  const coord = await db.createAgent({ slug: COORD, name: "Coordinator", instructions: "COORDINATOR BRIEF", keepsMemory: true, maxIterations: 30, mcpServers: [{ name: "agents", agents: [WORKER, OFF, COORD, `verify-asks-nobody-${stamp}`] }] });
  made.push(worker.id, off.id, stranger.id, coord.id);

  // ── 2. one ask, through the run path ──────────────────────────────────────
  console.log("\n— a coordinator asks a worker —");
  const out = await runAgentForPrincipal({ agentRef: COORD, prompt: "How many beans?", principal: PERSON, deadlineMs: 120_000 });
  check("the coordinator's run finishes", out.kind === "done", out.kind === "error" ? out.message : out.kind);
  const coordCall = calls.find((c) => c.who === "coordinator");
  check("it was offered agents_ask, and nothing else (no servers of its own, memory aside)", coordCall?.tools.includes("agents_ask") && !coordCall.tools.includes("pm_create_task"), coordCall?.tools.join(", "));
  check("the tool allows only the agents on its list that exist and are on: not the off one, not itself, not a slug that is nobody", JSON.stringify(coordCall?.askEnum) === JSON.stringify([WORKER]), JSON.stringify(coordCall?.askEnum));
  check("the worker's answer came back into the coordinator's run and its final answer", /Worker answered \(run [0-9a-f-]{36}\):\n\nforty-two beans/.test(out.output ?? ""), (out.output ?? "").slice(0, 120));
  const workerCalls = calls.filter((c) => c.who === "worker");
  check("the worker ran with its own tools (the fixture's), no ask tool (it is one deep), and no memory tools (it keeps none)", workerCalls.length >= 1 && workerCalls[0].tools.includes("pm_create_task") && !workerCalls[0].tools.includes("agents_ask") && !workerCalls[0].tools.some((t) => /^memory_/.test(t)), workerCalls[0]?.tools.join(", "));
  check("the worker saw only the task it was sent", workerCalls[0]?.prompt === "Count the beans in jar 1.", workerCalls[0]?.prompt);
  const [child] = await sql`select id, status, depth, parent_session_id as parent, principal_id as principal, agent_id as agent from agent_sessions where agent_id = ${worker.id} order by created_at desc limit 1`;
  check("the worker's run hangs off the coordinator's, one deep, as the same person", child?.parent === out.runId && child.depth === 1 && child.principal === PERSON.id && child.status === "succeeded", JSON.stringify(child && { depth: child.depth, parentOk: child.parent === out.runId }));
  const [held] = await sql`select tool, principal_id as principal, run_id as run, status from proposals where run_id = ${child?.id}`;
  check("the write the worker proposed was held for approval, under its own run and the same person", held?.tool === "pm_create_task" && held.principal === PERSON.id && held.status === "pending", JSON.stringify(held));
  check("and the worker was told so, not that it happened", workerCalls[1]?.lastResult?.includes("HELD FOR APPROVAL"));
  const timing = await db.getRunTiming(out.runId);
  const askCall = timing?.timeline?.turns?.[0]?.tools?.[0];
  check("the coordinator's timeline shows the ask as a tool call that took the worker's whole run", askCall?.name === "agents_ask" && askCall.ms > 50 && askCall.resultChars > 20, JSON.stringify(askCall));
  const children = await db.listChildRuns(out.runId);
  check("the run page lists the worker's run under the coordinator's", children.length === 1 && children[0].agentSlug === WORKER && children[0].status === "succeeded");
  check("the coordinator's own run has a parent of nothing and depth 0", timing.parentSessionId === null && timing.depth === 0);

  // ── 3. an ask the list does not allow ──────────────────────────────────────
  console.log("\n— refusals —");
  mode = "stranger";
  calls.length = 0;
  const refused = await runAgentForPrincipal({ agentRef: COORD, prompt: "Ask the stranger.", principal: PERSON, deadlineMs: 120_000 });
  check("asking an agent not on the list is refused in the tool's answer, and no run starts", /You may not ask/.test(refused.output ?? "") && !calls.some((c) => c.who === "other") && (await sql`select count(*)::int as n from agent_sessions where agent_id = ${stranger.id}`)[0].n === 0, (refused.output ?? "").slice(0, 100));
  const workerAlone = await runAgentForPrincipal({ agentRef: WORKER, prompt: "Count.", principal: PERSON, deadlineMs: 120_000 });
  const alone = calls.filter((c) => c.who === "worker").at(-1);
  check("a person's run of the worker (depth 0) IS offered the ask tool, since its entry allows it", workerAlone.kind === "done" && alone?.tools.includes("agents_ask") && JSON.stringify(alone.askEnum) === JSON.stringify([COORD]), alone?.tools.join(", "));

  // ── 4. the budget ──────────────────────────────────────────────────────────
  console.log("\n— the budget —");
  mode = "greedy";
  calls.length = 0;
  const before = (await sql`select count(*)::int as n from agent_sessions where agent_id = ${worker.id}`)[0].n;
  const greedy = await runAgentForPrincipal({ agentRef: COORD, prompt: "Count every jar.", principal: PERSON, deadlineMs: 300_000 });
  const after = (await sql`select count(*)::int as n from agent_sessions where agent_id = ${worker.id}`)[0].n;
  check(`a run that asks without end is stopped at ${ASK_BUDGET} asks, and told`, greedy.kind === "done" && after - before === ASK_BUDGET && /times in this run, which is the limit/.test(greedy.output ?? ""), `${after - before} worker runs`);
} finally {
  await sql`delete from proposals where principal_id = ${PERSON.id}`;
  await sql`delete from agent_sessions where principal_id = ${PERSON.id}`;
  for (const id of made) await db.deleteAgent(id).catch(() => {});
  await sql`delete from principals where id = ${PERSON.id}`;
  await sql.end({ timeout: 5 });
  http.close();
  fixture.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: whether a real coordinator splits a question well — the model's judgement, read on the run pages.");
