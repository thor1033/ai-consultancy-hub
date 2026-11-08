// Checks on a skill, judged on its answer (lib/checks.ts, @ai-hub/db checks.ts,
// docs/effective-agents-review.md D1), driven through the shipping run path
// against a real database.
//
//   node --experimental-transform-types --env-file=.env.local verify-checks.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend: a
// throwaway HTTP server stands in for the Messages API and plays the agent
// and the judge by their briefs; a throwaway remote MCP server stands in for
// the PM-tool so the run has a write to propose.
//
// What is proven: the plain kinds (mentions, avoids, at most N words, N
// writes) are decided in code against the answer and the run's proposals; the
// judge kind is one model call with no tools, on the cheaper model, told the
// standard and the answer and nothing else, and its first line decides —
// APPROVED, NOT YET with the points, CANNOT JUDGE, or no verdict, which is
// "could not be judged", never a pass; a skill's checks are stored on the run
// and travel with its answer to the page's poll and to hub_run_status; a
// judge that fails does not fail the run; a check that could never pass is
// refused when the skill is saved; the verdict renders under the answer.
import { registerHooks, createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// TSX (the verdict component) is transpiled on load by TypeScript itself, as verify-views does.
const require = createRequire(import.meta.url);
const ts = require("typescript");
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  load(url, context, nextLoad) {
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
const AGENT = `verify-checks-agent-${stamp}`;

// ── the stand-in PM-tool, so the run has a write to propose ─────────────────
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

// ── the stand-in Messages API: the agent, then the judge ────────────────────
// The agent proposes one task (held) and answers "forty-two beans, counted
// twice." The judge is told apart by its brief; `verdict` is what it says.
let verdict = "APPROVED";
const calls = [];
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n"));
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const system = textOf(body.system);
  const who = /CHECKED BRIEF/.test(system) ? "agent" : /You check an answer written by another agent/.test(system) ? "judge" : "other";
  const last = body.messages.at(-1);
  const lastResult = last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? textOf(last.content) : null;
  calls.push({ who, model: body.model, tools: (body.tools ?? []).map((t) => t.name), prompt: textOf(last?.content), system });
  if (who === "judge" && verdict === "BOOM") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "the judge is out" } }));
    return;
  }
  let blocks;
  let stop = "end_turn";
  if (who === "agent" && !lastResult && (body.tools ?? []).some((t) => t.name === "pm_create_task")) {
    blocks = [{ type: "tool_use", id: `tu_${calls.length}`, name: "pm_create_task", input: { projectId: "p1", title: "Beans counted", reason: "The brief asked for a record." } }];
    stop = "tool_use";
  } else if (who === "agent") blocks = [{ type: "text", text: "forty-two beans, counted twice." }];
  else if (who === "judge") blocks = [{ type: "text", text: verdict }];
  else blocks = [{ type: "text", text: "Other." }];
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
const { runSkillForPrincipal } = await import("./src/lib/agentRuns.ts");
const { runChecks, readVerdict, judgePrompt } = await import("./src/lib/checks.ts");
const { saveSkillAs } = await import("./src/lib/agentDesign.ts");
const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
const { CheckVerdict } = await import("./src/components/CheckVerdict.tsx");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const sql = db.getSql();
const PERSON = { id: `verify-checks-person-${stamp}`, roles: ["admin"], source: "credential" };
const made = [];
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

try {
  // ── 0. the plain kinds, pure ───────────────────────────────────────────────
  console.log("— the plain kinds —");
  const answer = "The price is DKK 1,200 a month. Three tasks are late.";
  const plain = await runChecks({
    runId: "00000000-0000-0000-0000-000000000000",
    answer,
    checks: [
      { kind: "mentions", value: "dkk 1,200" },
      { kind: "mentions", value: "euro" },
      { kind: "avoids", value: "late" },
      { kind: "maxWords", value: "20" },
      { kind: "maxWords", value: "5" },
      { kind: "writes", value: "0" },
    ],
  });
  check("mentions is case-insensitive", plain[0].ok === true && /Mentions "dkk 1,200"/.test(plain[0].detail));
  check("a word it lacks fails, and says so", plain[1].ok === false && /Does not mention "euro"/.test(plain[1].detail));
  check("avoids fails on the word it finds", plain[2].ok === false && /Mentions "late"/.test(plain[2].detail));
  check("a word limit passes under it and fails over it, with the count", plain[3].ok === true && plain[4].ok === false && /11 words, over 5/.test(plain[4].detail), plain[4].detail);
  check("writes counts the run's proposals: none for a run that made none", plain[5].ok === true && /0 changes proposed, as expected/.test(plain[5].detail));
  check("the verdict line counts passes, then names what failed", db.summarizeChecks(plain) === 'Checked: 3 of 6 · Does not mention "euro" · Mentions "late" · and 1 more', db.summarizeChecks(plain));
  check("no checks, no line", db.summarizeChecks([]) === null && db.summarizeChecks(null) === null);
  check("checkProblem refuses a limit that is not a number, an empty phrase, an unknown kind", /whole number/.test(db.checkProblem({ kind: "maxWords", value: "many" })) && /needs something/.test(db.checkProblem({ kind: "mentions", value: " " })) && /not a kind/.test(db.checkProblem({ kind: "regex", value: "x" })) && db.checkProblem({ kind: "writes", value: "0" }) === null);
  check("cleanChecks trims, drops junk and keeps tool only on writes", JSON.stringify(db.cleanChecks([{ kind: "mentions", value: " a ", tool: "x" }, { kind: "writes", value: "1", tool: " pm_create_task " }, null, "x", { value: "no kind" }])) === '[{"kind":"mentions","value":"a"},{"kind":"writes","value":"1","tool":"pm_create_task"}]');

  // ── 1. the judge's verdict, read ───────────────────────────────────────────
  console.log("\n— reading a verdict —");
  check("APPROVED on the first line passes", readVerdict("APPROVED\nAll three points met.").ok === true);
  check("NOT YET fails, with the points as the detail", readVerdict("NOT YET\n2. No price is given.\n3. Ends with a question.").ok === false && readVerdict("NOT YET\n2. No price is given.\n3. Ends with a question.").detail === "2. No price is given. 3. Ends with a question.");
  check("CANNOT JUDGE is neither, and says why", readVerdict("CANNOT JUDGE\n1. needs the source contract.").ok === null && /Could not judge: 1\. needs the source contract/.test(readVerdict("CANNOT JUDGE\n1. needs the source contract.").detail));
  check("prose with no verdict is not a pass", readVerdict("Looks fine to me.").ok === null && /did not give a verdict/.test(readVerdict("Looks fine to me.").detail));
  check("markdown around the verdict is tolerated", readVerdict("**Approved.**").ok === true && readVerdict("# Not yet:\n1. x").ok === false);
  const judged = await runChecks({ runId: "00000000-0000-0000-0000-000000000000", answer: "forty-two", checks: [{ kind: "judge", value: "1. Gives a number." }], judge: async (standard, a) => (standard.includes("number") && a === "forty-two" ? "APPROVED" : "NOT YET\n1. no") });
  check("the judge is given the standard and the answer, and its verdict is the check's result", judged[0].ok === true && judged[0].detail === "Meets the standard.");
  check("the judge's prompt is the standard then the answer, under headings", judgePrompt("1. x", "the answer") === "## The standard\n1. x\n\n## The answer\nthe answer");

  // ── 2. through the run path ────────────────────────────────────────────────
  console.log("\n— a skill with checks, run —");
  await db.upsertPrincipal({ id: PERSON.id, roles: PERSON.roles, displayName: "Verify checks", email: null });
  const agent = await db.createAgent({ slug: AGENT, name: "Counter", description: "counts beans", instructions: "CHECKED BRIEF", keepsMemory: false, mcpServers: [{ name: "verify-pm" }] });
  made.push(agent.id);
  const saved = await saveSkillAs(PERSON, {
    agentId: agent.id,
    slug: `count-${stamp}`,
    name: "Count the beans",
    description: "",
    promptTemplate: "Count the beans in {{jar}}.",
    parameters: [{ name: "jar", description: "which", required: true }],
    checks: [
      { kind: "mentions", value: "Forty-Two" },
      { kind: "avoids", value: "lentils" },
      { kind: "maxWords", value: "10" },
      { kind: "writes", value: "1", tool: "pm_create_task" },
      { kind: "writes", value: "0", tool: "pm_update_task" },
      { kind: "judge", value: "1. Gives a number.\n2. Says how many times it counted." },
    ],
  });
  check("a skill saves its checks", !("error" in saved) && saved.saved.checks.length === 6 && saved.saved.checks[3].tool === "pm_create_task", saved.error);
  const bad = await saveSkillAs(PERSON, { agentId: agent.id, slug: `bad-${stamp}`, name: "Bad", description: "", promptTemplate: "x", parameters: [], checks: [{ kind: "maxWords", value: "short" }] });
  check("a check that could never be judged is refused at save", /whole number/.test(bad.error ?? ""), bad.error);

  verdict = "NOT YET\n2. It does not say how many times it counted.";
  const out = await runSkillForPrincipal({ skillRef: saved.saved.id, args: { jar: "jar 1" }, principal: PERSON, deadlineMs: 120_000 });
  check("the run finishes with its answer", out.kind === "done" && /forty-two beans/.test(out.output), out.kind === "error" ? out.message : out.kind);
  const results = out.checks ?? [];
  check("and carries every check judged: the plain ones in code, from the answer and the held write", results.length === 6 && results[0].ok === true && results[1].ok === true && results[2].ok === true && results[3].ok === true && results[4].ok === true, JSON.stringify(results.map((r) => [r.kind, r.ok])));
  check("the judge's NOT YET is the last check's failure, with its point", results[5]?.ok === false && results[5].detail === "2. It does not say how many times it counted.", JSON.stringify(results[5]));
  const judge = calls.find((c) => c.who === "judge");
  check("the judge was one call with no tools, on the cheaper model", Boolean(judge) && judge.tools.length === 0 && judge.model === db.CHEAPER_MODEL && calls.filter((c) => c.who === "judge").length === 1, JSON.stringify(judge && { tools: judge.tools, model: judge.model }));
  check("told the standard and the answer, and nothing from the run's brief or tools", judge?.prompt === "## The standard\n1. Gives a number.\n2. Says how many times it counted.\n\n## The answer\nforty-two beans, counted twice." && !/CHECKED BRIEF/.test(judge.system), JSON.stringify(judge?.prompt));
  const [row] = await sql`select checks, status from agent_sessions where id = ${out.runId}`;
  check("the checks are stored on the run", row?.status === "succeeded" && Array.isArray(row.checks) && row.checks.length === 6 && row.checks[5].ok === false);
  const status = await db.getRunStatus(out.runId, PERSON.id);
  check("and come back to the page's poll with the answer", status?.checks?.length === 6 && db.summarizeChecks(status.checks) === "Checked: 5 of 6 · 2. It does not say how many times it counted", db.summarizeChecks(status?.checks));
  const mine = (await db.listMyRuns(agent.id, PERSON.id)).find((r) => r.id === out.runId);
  check("and to Your answers", mine?.checks?.length === 6);

  // hub_run_status, through the real MCP server
  const server = await buildHubMcpServer(PERSON, { baseUrl: "https://hub.example" });
  const client = new Client({ name: "verify", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const polled = JSON.parse((await client.callTool({ name: "hub_run_status", arguments: { runId: out.runId } })).content[0].text);
  check("hub_run_status carries the verdict line and the checks not passed", polled.checked === "Checked: 5 of 6 · 2. It does not say how many times it counted" && polled.checksNotPassed?.length === 1 && polled.checksNotPassed[0].check === "judge" && polled.checksNotPassed[0].ok === false, JSON.stringify({ checked: polled.checked, open: polled.checksNotPassed }));
  await client.close();

  // the verdict under the answer
  const html = renderToStaticMarkup(createElement(CheckVerdict, { checks: results }));
  check("the verdict renders under the answer: the line, then the check not met", /Checked: 5 of 6/.test(text(html)) && /Not met · 2\. It does not say how many times it counted/.test(text(html)), text(html));
  check("and renders nothing for a run with no checks", renderToStaticMarkup(createElement(CheckVerdict, { checks: null })) === "" && renderToStaticMarkup(createElement(CheckVerdict, { checks: [] })) === "");

  // ── 3. the judge fails ─────────────────────────────────────────────────────
  console.log("\n— a judge that is out —");
  verdict = "BOOM";
  calls.length = 0;
  const outage = await runSkillForPrincipal({ skillRef: saved.saved.id, args: { jar: "jar 2" }, principal: PERSON, deadlineMs: 120_000 });
  const judgeOut = outage.checks?.[5];
  check("the run still succeeds with its answer", outage.kind === "done" && /forty-two beans/.test(outage.output), outage.kind === "error" ? outage.message : outage.kind);
  check("the judge check says it could not be judged, and is not a pass", judgeOut?.ok === null && /Could not judge/.test(judgeOut.detail), JSON.stringify(judgeOut));
  check("the plain checks were still judged", outage.checks?.slice(0, 5).every((r) => r.ok === true));
  check("the line says so", /Checked: 5 of 6 · 1 could not be judged/.test(db.summarizeChecks(outage.checks)), db.summarizeChecks(outage.checks));

  // ── 4. no checks ───────────────────────────────────────────────────────────
  const plainSkill = await db.createSkill({ agentId: agent.id, slug: `plain-${stamp}`, name: "Plain", promptTemplate: "Count." });
  calls.length = 0;
  const none = await runSkillForPrincipal({ skillRef: plainSkill.id, args: {}, principal: PERSON, deadlineMs: 120_000 });
  check("a skill with no checks stores none, and no judge is called", none.kind === "done" && none.checks === null && !calls.some((c) => c.who === "judge") && (await sql`select checks from agent_sessions where id = ${none.runId}`)[0].checks === null);
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
console.log("Not proven here: whether a real judge reads a standard well — the model's judgement, read under the answer.");
