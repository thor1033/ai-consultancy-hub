// Test cases on a skill and trial sets that compare setups (lib/skillTests.ts,
// @ai-hub/db skillTests.ts, docs/skill-tests.md), driven through the shipping
// run path against a real database.
//
//   node --experimental-transform-types --env-file=.env.local verify-skill-tests.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend: a
// throwaway HTTP server stands in for the Messages API and plays the agent
// by the model it is asked for — the agent's own model answers well, the
// cheaper one answers badly half the time — so a comparison has a winner;
// a throwaway remote MCP server stands in for the PM-tool so trials have a
// write to propose.
//
// What is proven: a plan says how many runs before any run, and refuses a
// set over the ceiling, an unknown model, or a skill with no cases; a set
// runs every case k times under each setup as the person, records each
// trial as a run under the set, scores pass rate and pass-every-time per
// case and setup, and names the best; a case's own checks are judged on top
// of the skill's; a trial's held writes are rejected when it ends, its memory
// writes are refused, it hands off to nobody, and it is left out of Your
// answers; a case saved from a run keeps the run's exact prompt and is the
// skill's, not the person's; the setup hash tells a later set that the brief
// changed; a trial that fails is counted, not fatal; the pure scorer.
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
const AGENT = `verify-tests-agent-${stamp}`;
const NEXT = `verify-tests-next-${stamp}`;
const OTHER = `verify-tests-other-${stamp}`;
const CHEAP = "claude-haiku-4-5";

// ── the stand-in PM-tool ────────────────────────────────────────────────────
const FIXTURE_PORT = 8790 + Math.floor(Math.random() * 500);
const FIXTURE_TOKEN = `fixture-${stamp}`;
process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({ "verify-pm": { url: `http://127.0.0.1:${FIXTURE_PORT}/mcp`, label: "PM-tool (fixture)", tokenEnv: "VERIFY_PM_TOKEN" } });
process.env.VERIFY_PM_TOKEN = FIXTURE_TOKEN;
process.env.HUB_TRIAL_MAX_RUNS = "20";
const fixture = spawn(process.execPath, [fileURLToPath(new URL("../../packages/mcp/remote-fixture/server.mjs", import.meta.url))], {
  env: { ...process.env, PORT: String(FIXTURE_PORT), PM_TOOL_MCP_TOKEN: FIXTURE_TOKEN },
  stdio: "pipe",
});
await new Promise((resolve, reject) => {
  fixture.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  fixture.on("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  setTimeout(() => reject(new Error("fixture did not start")), 10_000);
});

// ── the stand-in Messages API ───────────────────────────────────────────────
// The agent ("TESTED BRIEF") first proposes a task and writes a memory, then
// answers "forty-two beans." On the cheap model every second answer is
// "about forty beans" instead, which fails the skill's check. A variant brief
// ("SHORT BRIEF") answers "42." — short, and failing a case that wants the
// word. "OTHER BRIEF" is another agent given the same prompt. The judge, when
// asked, approves anything with "forty-two".
const calls = [];
let cheapCalls = 0;
let mode = "normal";
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n"));
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const system = textOf(body.system);
  const who = /TESTED BRIEF/.test(system) ? "agent" : /SHORT BRIEF/.test(system) ? "short" : /OTHER BRIEF/.test(system) ? "other" : /NEXT BRIEF/.test(system) ? "next" : /You check an answer/.test(system) ? "judge" : "?";
  const last = body.messages.at(-1);
  const lastResult = last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? textOf(last.content) : null;
  const toolsSeen = body.messages.filter((m) => m.role === "assistant" && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.name));
  const tools = (body.tools ?? []).map((t) => t.name);
  calls.push({ who, model: body.model, tools, prompt: textOf(last?.content), lastResult, system });
  let blocks;
  let stop = "end_turn";
  if (mode === "outage" && who !== "judge") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "the model is out" } }));
    return;
  }
  if (who === "agent" && !toolsSeen.includes("pm_create_task") && tools.includes("pm_create_task")) {
    blocks = [{ type: "tool_use", id: `tu_${calls.length}`, name: "pm_create_task", input: { projectId: "p1", title: "Beans counted", reason: "The brief asked for a record." } }];
    stop = "tool_use";
  } else if (who === "agent" && !toolsSeen.includes("memory_write") && tools.includes("memory_write")) {
    blocks = [{ type: "tool_use", id: `tu_${calls.length}`, name: "memory_write", input: { key: "beans", content: "There were forty-two." } }];
    stop = "tool_use";
  } else if (who === "agent") {
    const cheap = body.model === CHEAP;
    if (cheap) cheapCalls++;
    blocks = [{ type: "text", text: cheap && cheapCalls % 2 === 0 ? "About forty beans, roughly." : "Forty-two beans, counted twice." }];
  } else if (who === "short") blocks = [{ type: "text", text: "42." }];
  else if (who === "other") blocks = [{ type: "text", text: "Forty-two beans, says the other agent." }];
  else if (who === "next") blocks = [{ type: "text", text: "Next agent ran." }];
  else if (who === "judge") blocks = [{ type: "text", text: /forty-two/i.test(textOf(last?.content)) ? "APPROVED" : "NOT YET\n1. No exact count." }];
  else blocks = [{ type: "text", text: "?" }];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { id: `m${calls.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
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
const { planTrials, startTrials, cleanVariants, currentSetupHash, MAX_TRIAL_RUNS } = await import("./src/lib/skillTests.ts");
const { runSkillForPrincipal } = await import("./src/lib/agentRuns.ts");
const sql = db.getSql();
const PERSON = { id: `verify-tests-person-${stamp}`, roles: ["admin"], source: "credential" };
const made = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilDone = async (id) => {
  for (let i = 0; i < 600; i++) {
    const set = await db.getTrialSet(id);
    if (set.status !== "running") return set;
    await sleep(200);
  }
  throw new Error("the set did not finish");
};

try {
  // ── 0. the scorer, pure ────────────────────────────────────────────────────
  console.log("— the scorer —");
  const run = (passed, cost = 0.01) => ({ runId: "r", status: "succeeded", passed, checks: [], latencyMs: 1000, costUsd: cost, words: 3, error: null });
  const scored = db.scoreTrials(
    [
      { variant: "A", caseId: "c1", caseName: "one", runs: [run(true), run(true)] },
      { variant: "A", caseId: "c2", caseName: "two", runs: [run(true), run(false)] },
      { variant: "B", caseId: "c1", caseName: "one", runs: [run(true, 0.001), run(true, 0.001)] },
      { variant: "B", caseId: "c2", caseName: "two", runs: [run(true, 0.001), run(true, 0.001)] },
    ],
    [{ label: "A" }, { label: "B" }],
    2,
  );
  check("pass rate and pass-every-time are counted per setup", scored.variants[0].passed === 3 && scored.variants[0].casesAllPassed === 1 && scored.variants[1].casesAllPassed === 2);
  check("the best setup is the one passing most cases every time", scored.best === "B");
  check("the table has a row per case with each setup's count", scored.byCase.length === 2 && scored.byCase[1].perVariant.A === 1 && scored.byCase[1].perVariant.B === 2);
  check("the verdict line names it", db.summarizeTrials(scored) === "Best: B · 2 of 2 cases passed every time · 4 of 4 trials", db.summarizeTrials(scored));
  const tie = db.scoreTrials([{ variant: "A", caseId: "c1", caseName: "one", runs: [run(true, 0.02)] }, { variant: "B", caseId: "c1", caseName: "one", runs: [run(true, 0.01)] }], [{ label: "A" }, { label: "B" }], 1);
  check("on a tie the cheaper setup wins", tie.best === "B");
  check("a trial that could not be judged is not a pass", db.trialPassed({ status: "succeeded", checks: [{ kind: "judge", ok: null }] }) === false && db.trialPassed({ status: "succeeded", checks: [] }) === true && db.trialPassed({ status: "failed", checks: [] }) === false);
  check("cleanVariants keeps what is set and drops empty fields", JSON.stringify(cleanVariants([{ label: " A ", model: "", effort: "low", instructions: " ", agent: "x" }, "junk"])) === '[{"label":"A","effort":"low","agent":"x"}]');

  // ── 1. the agents and the skill ────────────────────────────────────────────
  await db.upsertPrincipal({ id: PERSON.id, roles: PERSON.roles, displayName: "Verify tests", email: null });
  const agent = await db.createAgent({ slug: AGENT, name: "Counter", instructions: "TESTED BRIEF", keepsMemory: true, mcpServers: [{ name: "verify-pm", writes: "allow" }] });
  const next = await db.createAgent({ slug: NEXT, name: "Next", instructions: "NEXT BRIEF" });
  const other = await db.createAgent({ slug: OTHER, name: "Other", instructions: "OTHER BRIEF" });
  made.push(agent.id, next.id, other.id);
  const skill = await db.createSkill({
    agentId: agent.id,
    slug: `count-${stamp}`,
    name: "Count the beans",
    promptTemplate: "Count the beans in {{jar}}.",
    parameters: [{ name: "jar", description: "which", required: true }],
    checks: [{ kind: "mentions", value: "forty-two" }],
  });
  // A hand-off that would start a real run of the next agent, if a trial let it.
  await db.createHandoff({ fromAgentId: agent.id, skillId: skill.id, toAgentId: next.id, prompt: "After the count: {{output}}" });

  // ── 2. a plan before any run ───────────────────────────────────────────────
  console.log("\n— the plan —");
  const noCases = await planTrials({ skillRef: skill.id });
  check("a skill with no cases cannot be run, in words", /no test cases yet/.test(noCases.error ?? ""), noCases.error);
  const c1 = await db.createCase({ skillId: skill.id, name: "Jar one", args: { jar: "jar 1" }, createdBy: PERSON.id });
  const c2 = await db.createCase({ skillId: skill.id, name: "Says beans", args: { jar: "jar 2" }, checks: [{ kind: "mentions", value: "beans" }], reference: "Forty-two beans." });
  const plan = await planTrials({ skillRef: skill.id, k: 2, variants: [{ label: "As it is" }, { label: "Cheaper", model: CHEAP }, { label: "Short brief", instructions: "SHORT BRIEF" }, { label: "Other agent", agent: OTHER }] });
  check("a plan counts the runs and says so before anything runs", !plan.error && plan.runs === 16 && /16 runs of the real model: 2 cases × 2 times × 4 setups/.test(plan.sentence) && calls.length === 0, plan.error ?? plan.sentence);
  check(`a set over the ceiling (${MAX_TRIAL_RUNS}) is refused`, /the most one set may make is 20/.test((await planTrials({ skillRef: skill.id, k: 10, variants: [{ label: "a" }, { label: "b" }] })).error ?? ""));
  check("an unknown model, an off agent, two setups with one name: each refused in words",
    /Unknown model/.test((await planTrials({ skillRef: skill.id, variants: [{ label: "x", model: "gpt-9" }] })).error ?? "") &&
    /There is no agent/.test((await planTrials({ skillRef: skill.id, variants: [{ label: "x", agent: "nobody" }] })).error ?? "") &&
    /both called/.test((await planTrials({ skillRef: skill.id, variants: [{ label: "x" }, { label: "x" }] })).error ?? ""));
  const badCase = await db.createCase({ skillId: skill.id, name: "Bad", args: { jar: "x" }, checks: [{ kind: "maxWords", value: "lots" }] });
  check("a case whose own check could never be judged stops the plan", /Case "Bad": At most this many words needs a whole number/.test((await planTrials({ skillRef: skill.id })).error ?? ""));
  await db.deleteCase(badCase.id);

  // ── 3. the set runs ────────────────────────────────────────────────────────
  console.log("\n— a comparison of four setups —");
  const started = await startTrials(plan, PERSON, "four ways");
  check("a set starts at once, running, with its setup hash", started.status === "running" && started.k === 2 && started.variants.length === 4 && /^[0-9a-f]{12}$/.test(started.setupHash), JSON.stringify({ status: started.status, hash: started.setupHash }));
  const set = await untilDone(started.id);
  check("and finishes with every trial recorded", set.status === "done" && set.results.length === 8 && set.results.every((r) => r.runs.length === 2), `${set.status}, ${set.results?.length} case×setup rows`);
  const byVariant = Object.fromEntries(set.summary.variants.map((v) => [v.variant, v]));
  check("the agent as it is passes every case every time", byVariant["As it is"].passed === 4 && byVariant["As it is"].casesAllPassed === 2, JSON.stringify(byVariant["As it is"]));
  check("a setup's cost is a sum of numbers, not a string of them", typeof byVariant["As it is"].costUsd === "number" && byVariant["As it is"].costUsd > 0 && byVariant["As it is"].costUsd < 1, String(byVariant["As it is"].costUsd));
  check("the cheaper model passes some, not all: it answered badly every second time", byVariant.Cheaper.passed > 0 && byVariant.Cheaper.passed < 4, JSON.stringify(byVariant.Cheaper));
  check("the short brief fails the skill's own check on every case", byVariant["Short brief"].passed === 0, JSON.stringify(byVariant["Short brief"]));
  check("another agent given the same request passes the skill's check and the case's own", byVariant["Other agent"].passed === 4, JSON.stringify(byVariant["Other agent"]));
  check("the best setup is named, and it is not the one that fails", set.summary.best === "As it is" || set.summary.best === "Other agent", set.summary.best);
  const shortRun = set.results.find((r) => r.variant === "Short brief" && r.caseId === c2.id).runs[0];
  check("a failed trial says which checks failed, and links its run", shortRun.passed === false && shortRun.checks.length === 2 && shortRun.checks.every((c) => c.ok === false) && /^[0-9a-f-]{36}$/.test(shortRun.runId), JSON.stringify(shortRun.checks.map((c) => c.detail)));
  check("a case's own check is judged on top of the skill's", set.results.find((r) => r.variant === "As it is" && r.caseId === c2.id).runs[0].checks.map((c) => c.value).join() === "forty-two,beans");
  const trialRows = await sql`select id, trial_id as trial, system, model, principal_id as person, status from agent_sessions where trial_id = ${set.id} and parent_session_id is null`;
  check("every trial is a run under the set, as the person", trialRows.length === 16 && trialRows.every((r) => r.person === PERSON.id && r.status === "succeeded"), `${trialRows.length} runs`);
  check("a setup's overrides were what ran: the cheaper model, the short brief", trialRows.filter((r) => r.model === CHEAP).length === 4 && trialRows.filter((r) => r.system === "SHORT BRIEF").length === 4);
  const otherRows = await sql`select agent_id as agent from agent_sessions where trial_id = ${set.id} and agent_id = ${other.id}`;
  check("the other agent's trials ran as that agent", otherRows.length === 4);

  // ── 4. what a trial leaves behind: nothing ─────────────────────────────────
  console.log("\n— what a trial leaves behind —");
  const proposals = await sql`select status, note from proposals where run_id in (select id from agent_sessions where trial_id = ${set.id})`;
  check("every write a trial proposed was held even though the entry allows writes, and rejected when the trial ended", proposals.length === 8 && proposals.every((p) => p.status === "rejected" && /A test run/.test(p.note)), `${proposals.length} proposals: ${[...new Set(proposals.map((p) => p.status))].join(",")}`);
  const memories = await sql`select count(*)::int as n from agent_memories where agent_id = ${agent.id}`;
  const memoryTold = calls.find((c) => c.who === "agent" && /Not remembered: this is a test run/.test(c.lastResult ?? ""));
  check("its memory writes were refused and the model told; the agent remembers nothing", memories[0].n === 0 && Boolean(memoryTold));
  check("but its memory was loaded: the trial ran with the memory tools", calls.some((c) => c.who === "agent" && c.tools.includes("memory_list")));
  const nextRuns = await sql`select count(*)::int as n from agent_sessions where agent_id = ${next.id}`;
  check("the hand-off did not fire: the next agent never ran", nextRuns[0].n === 0 && !calls.some((c) => c.who === "next"));
  check("trial runs are left out of Your answers", (await db.listMyRuns(agent.id, PERSON.id)).length === 0);

  // ── 5. a case from a run, and the setup hash ───────────────────────────────
  console.log("\n— a case from a run; the brief changes —");
  const real = await runSkillForPrincipal({ skillRef: skill.id, args: { jar: "jar 9" }, principal: PERSON, deadlineMs: 60_000 });
  check("a real run of the skill is in Your answers (it is not a trial)", real.kind === "done" && (await db.listMyRuns(agent.id, PERSON.id)).length === 1);
  const fromRun = await db.createCase({ skillId: skill.id, name: "From a run", prompt: (await db.getRunStatus(real.runId, PERSON.id)).prompt, fromRunId: real.runId, createdBy: PERSON.id });
  check("a case saved from a run keeps the exact prompt, and which run", fromRun.prompt === "Count the beans in jar 9." && fromRun.fromRunId === real.runId);
  const promptPlan = await planTrials({ skillRef: skill.id, caseIds: [fromRun.id], k: 1 });
  const promptSet = await untilDone((await startTrials(promptPlan, PERSON)).id);
  const promptRun = await sql`select prompt from agent_sessions where id = ${promptSet.results[0].runs[0].runId}`;
  check("and runs with that prompt, not the template", promptSet.status === "done" && promptRun[0].prompt === "Count the beans in jar 9." && promptSet.results[0].runs[0].passed === true);
  check("the set's hash matches today's setup", (await currentSetupHash(await db.getSkill(skill.id))) === promptSet.setupHash);
  await db.updateAgent(agent.id, { instructions: "TESTED BRIEF, revised" });
  check("a changed brief changes the hash, so the set reads as before the change", (await currentSetupHash(await db.getSkill(skill.id))) !== promptSet.setupHash);

  // ── 6. a model outage during a set ─────────────────────────────────────────
  console.log("\n— a trial that fails —");
  mode = "outage";
  const outagePlan = await planTrials({ skillRef: skill.id, caseIds: [c1.id], k: 1 });
  const outageSet = await untilDone((await startTrials(outagePlan, PERSON)).id);
  mode = "normal";
  check("a trial whose run fails is counted as failed, not a pass, and the set still finishes", outageSet.status === "done" && outageSet.results[0].runs[0].passed === false && outageSet.results[0].runs[0].status === "failed" && outageSet.summary.variants[0].failed === 1, JSON.stringify(outageSet.results[0].runs[0]));

  // ── 7. erasing the person ──────────────────────────────────────────────────
  console.log("\n— erasing the person —");
  const setsBefore = (await db.listTrialSets(skill.id)).length;
  await db.erasePerson(PERSON.id, "verify");
  const after = await db.listCases(skill.id);
  check("erasing the person removes the sets they started and their name from the cases; the cases stay, the skill's", setsBefore === 3 && (await db.listTrialSets(skill.id)).length === 0 && after.length === 3 && after.every((c) => c.createdBy === null), `${setsBefore} sets before, ${after.length} cases after`);
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
console.log("Not proven here: whether a real model's pass rate means what a person thinks — that is the point of running k times, read on the Tests panel.");
