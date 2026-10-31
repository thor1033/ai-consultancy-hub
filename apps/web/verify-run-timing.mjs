// Where a run's time went: recorded by the agent loop, stored with the run,
// read into a verdict, and shown on the run's page.
//
//   node --experimental-transform-types --env-file=.env.local verify-run-timing.mjs
//
// Needs DATABASE_URL and a migrated database (the timeline column). No API key
// and no spend: a throwaway HTTP server stands in for the Messages API and
// streams with delays this script chose, so every number on the page can be
// checked against a known cause.
//
// Three parts. The reading (lib/runTiming.ts) is pure and checked on made-up
// timelines: each kind of slowness gets the verdict that names it. Then a real
// run through runAgentForPrincipal — the agent's own memory server connected,
// one real tool call — lands its timeline in agent_sessions. Then the run's
// page (app/agents/[slug]/runs/[id]/page.tsx) is rendered from that row, and
// checked for what it says and for what it must not say: the answer.
//
// What it cannot prove: how the page looks. That is a screenshot after
// `npm run build` (docs/agent-testing.md, "Prompt speed").
import { registerHooks } from "node:module";
import { createServer } from "node:http";
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

const ANSWER = "Nothing in memory yet; the brief is all I have.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the stand-in Messages API ────────────────────────────────────────────────
// Turn 1 asks for memory_list after 300 ms of silence; turn 2 thinks for 400 ms
// and then writes the answer over 150 ms.
let calls = 0;
const http = createServer(async (req, res) => {
  for await (const _ of req) void _;
  calls++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({
    type: "message_start",
    message: { id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200 * calls, output_tokens: 0, cache_read_input_tokens: 800 } },
  });
  await sleep(300);
  if (calls === 1) {
    send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "memory_list", input: {} } });
    send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } });
  } else {
    send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Memory is empty." } });
    await sleep(400);
    send({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: ANSWER } });
    await sleep(150);
    send({ type: "content_block_stop", index: 1 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 90 } });
  }
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
process.env.HUB_REMOTE_MCP_SERVERS = "";
delete process.env.LANGFUSE_PUBLIC_KEY;

const { readTimeline, isTimeline } = await import("./src/lib/runTiming.ts");
const db = await import("../../packages/db/src/index.ts");
const { runAgentForPrincipal } = await import("./src/lib/agentRuns.ts");
const sql = db.getSql();

// ── 1. the reading, on made-up timelines ────────────────────────────────────
console.log("— the reading —");
const turn = (n, o) => ({
  turn: n, startMs: 0, firstTokenMs: 0, thinkingMs: 0, writingMs: 0, toolInputMs: 0, totalMs: 0,
  inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, stopReason: "end_turn", tools: [], ...o,
});
const tl = (turns, o = {}) => ({
  version: 1,
  prompt: { brief: 3000, context: 0, tools: 500, history: 0, prompt: 50 },
  turns,
  modelMs: turns.reduce((n, t) => n + t.totalMs, 0),
  toolMs: turns.reduce((n, t) => n + t.tools.reduce((m, c) => m + c.ms, 0), 0),
  ...o,
});

const slowRead = readTimeline(tl([
  turn(1, { firstTokenMs: 1000, totalMs: 1500, tools: [{ name: "pm_get_project", ms: 400, resultChars: 120_000, error: false }], stopReason: "tool_use" }),
  turn(2, { startMs: 1900, firstTokenMs: 9000, writingMs: 800, totalMs: 10_000, inputTokens: 31_000 }),
]));
check("a run mostly waiting for the first token is said to be reading the prompt", /before the first token/.test(slowRead.verdict) && /31,000 tokens/.test(slowRead.verdict), slowRead.verdict.slice(0, 90));
check(
  "and the tool result that made the prompt grow is named, with how many turns read it again",
  slowRead.notes.some((n) => /pm_get_project in turn 1, about 30,000 tokens, read again by 1 later turn/.test(n)),
  slowRead.notes.join(" | ").slice(0, 160),
);
check("the growth of the prompt is said", slowRead.notes.some((n) => /grew from about 1,000 to 31,000/.test(n)));
check("two model calls are called out as rounds to save", slowRead.notes.some((n) => /^2 model calls/.test(n)));

const thinker = readTimeline(tl([turn(1, { firstTokenMs: 500, thinkingMs: 20_000, writingMs: 1000, totalMs: 21_600 })]));
check("a thinking-bound run says to lower effort or say more plainly what to do", /was thinking\. Lower the agent's effort/.test(thinker.verdict), thinker.verdict.slice(0, 80));
const tie = readTimeline(tl([turn(1, { firstTokenMs: 500, thinkingMs: 10_000, writingMs: 9_000, totalMs: 19_500 })]));
check("a near tie names both causes", /was thinking\./.test(tie.verdict) && /Writing the answer took nearly as long \(46%\)/.test(tie.verdict), tie.verdict.slice(-60));
check("a clear winner names one", !/nearly as long/.test(thinker.verdict));
check("one turn is not called out as many rounds", !thinker.notes.some((n) => /model calls/.test(n)));

const toolBound = readTimeline(tl([
  turn(1, { firstTokenMs: 300, totalMs: 500, stopReason: "tool_use", tools: [{ name: "teams_transcript_get", ms: 14_000, resultChars: 800, error: false }, { name: "memory_list", ms: 40, resultChars: 200, error: false }] }),
  turn(2, { startMs: 14_600, firstTokenMs: 300, writingMs: 400, totalMs: 800 }),
]));
check("a tool-bound run names the slowest tool and says it is the server, not the prompt", /waiting on tools; the slowest was teams_transcript_get at 14\.0 s in turn 1\. That is the tool's server/.test(toolBound.verdict), toolBound.verdict);

const writer = readTimeline(tl([turn(1, { firstTokenMs: 400, writingMs: 30_000, totalMs: 30_500, outputTokens: 9000 })]));
check("a writing-bound run says the answer was long, with the tokens out", /writing the answer: 9,000 tokens out/.test(writer.verdict), writer.verdict.slice(0, 80));

const briefHeavy = readTimeline(tl([turn(1, { firstTokenMs: 400, writingMs: 300, totalMs: 800 })]));
check("the largest part of the first request is named when it is most of it", briefHeavy.notes.some((n) => /the agent's brief was the largest part: about 3,000 of 3,550 tokens/.test(n)), briefHeavy.notes.join(" | "));
const shares = slowRead.parts.reduce((n, p) => n + p.share, 0);
check("the parts add up to the whole run", Math.abs(shares - 1) < 0.001, shares.toFixed(3));
check("a row from before timings existed is not mistaken for one", !isTimeline(null) && !isTimeline({}) && !isTimeline({ version: 2, turns: [], prompt: {} }));

// ── 2. a real run stores its timeline ───────────────────────────────────────
console.log("\n— a run through the hub —");
const stamp = Date.now();
const PERSON = { id: `verify-timing-${stamp}`, roles: ["analyst"], source: "credential" };
let agent;
let other;
try {
  await db.upsertPrincipal({ id: PERSON.id, roles: PERSON.roles, displayName: "Verify timing", email: null });
  agent = await db.createAgent({ slug: `verify-timing-${stamp}`, name: "Verify Timing", instructions: "You are a stand-in. ".repeat(40), mcpServers: [] });
  other = await db.createAgent({ slug: `verify-timing-other-${stamp}`, name: "Verify Other", instructions: "Another stand-in.", mcpServers: [] });

  const out = await runAgentForPrincipal({ agentRef: agent.id, prompt: "What do you remember?\nSecond line that the page must not show.", principal: PERSON, deadlineMs: 60_000 });
  check("the run finishes", out.kind === "done", out.kind === "error" ? out.message : out.kind);
  const row = await db.getRunTiming(out.runId);
  const t = row?.timeline;
  check("its timeline is stored with the run", isTimeline(t) && t.turns.length === 2, `${t?.turns?.length} turns`);
  const [t1, t2] = t?.turns ?? [];
  const near = (ms, want) => ms >= want - 20 && ms < want + 250;
  check("the wait before each turn's first token is the stream's 300 ms", near(t1?.firstTokenMs ?? -1, 300) && near(t2?.firstTokenMs ?? -1, 300), `${t1?.firstTokenMs} ms, ${t2?.firstTokenMs} ms`);
  check("turn 2's thinking and writing are the stream's 400 and 150 ms", near(t2?.thinkingMs ?? -1, 400) && near(t2?.writingMs ?? -1, 150), `${t2?.thinkingMs} ms, ${t2?.writingMs} ms`);
  check("the real tool call is timed under turn 1", t1?.tools?.[0]?.name === "memory_list" && t1.tools[0].ms > 0 && t1.tools[0].resultChars > 0, JSON.stringify(t1?.tools));
  check("tokens per turn come from the stream", t1?.inputTokens === 1200 && t2?.inputTokens === 2400 && t2?.cacheReadTokens === 800 && t2?.outputTokens === 90);
  check("the brief's size is counted", (t?.prompt?.brief ?? 0) >= Math.round("You are a stand-in. ".repeat(40).length / 4), `≈${t?.prompt?.brief} tokens`);
  check("and the stored timeline holds no content", !/remember|Nothing in memory|stand-in|Second line/i.test(JSON.stringify(t)));
  check("getRunTiming refuses what is not a run id", (await db.getRunTiming("not-an-id")) === null && (await db.getRunTiming("00000000-0000-0000-0000-000000000000")) === null);

  // ── 3. the page ────────────────────────────────────────────────────────────
  console.log("\n— the run's page —");
  // The page is TSX, which Node does not strip. TypeScript's own transpiler
  // turns it into plain JSX calls beside the original (so its imports resolve
  // the same way), and it is imported natively: same modules, same database
  // pool as the rest of this script.
  const ts = (await import("typescript")).default;
  const { readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const pageTsx = fileURLToPath(new URL("./src/app/agents/[slug]/runs/[id]/page.tsx", import.meta.url));
  const compiled = pageTsx.replace(/page\.tsx$/, `.verify-page-${stamp}.mjs`);
  writeFileSync(
    compiled,
    ts.transpileModule(readFileSync(pageTsx, "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
  const { renderToStaticMarkup } = await import("react-dom/server");
  let RunPage;
  try {
    ({ default: RunPage } = await import(new URL(`file://${compiled}`).href));
  } finally {
    rmSync(compiled, { force: true });
  }
  const render = async (slug, id) => {
    try {
      return renderToStaticMarkup(await RunPage({ params: Promise.resolve({ slug, id }) }));
    } catch (err) {
      return /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(String(err?.digest ?? err?.message)) ? "404" : `threw: ${err?.message}`;
    }
  };
  const html = await render(agent.slug, out.runId);
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
  check("the page renders the verdict", /Where the time went/.test(text) && /Most of the time \(\d+%\)/.test(text), text.match(/Most of the time[^.]*\./)?.[0]);
  check("it shows both turns and the tool call", /Turn 1/.test(text) && /Turn 2/.test(text) && /memory_list/.test(text));
  check("it shows the prompt's first line only", /What do you remember\?/.test(text) && !/Second line/.test(text));
  check("it never shows the answer", !text.includes(ANSWER));
  check("it shows what the first request carried", /What the first request carried/.test(text) && /The agent's brief/.test(text));
  check("a run asked for under another agent's address is not found", (await render(other.slug, out.runId)) === "404");
  check("an unknown run is not found", (await render(agent.slug, "00000000-0000-0000-0000-000000000000")) === "404");
  await sql`update agent_sessions set timeline = null where id = ${out.runId}`;
  const before = await render(agent.slug, out.runId);
  check("a run from before timings existed says so instead of failing", /recorded before the hub kept timings/.test(before), before.slice(0, 60));
} finally {
  await sql`delete from agent_sessions where principal_id = ${PERSON.id}`;
  if (agent) await db.deleteAgent(agent.id);
  if (other) await db.deleteAgent(other.id);
  await sql`delete from principals where id = ${PERSON.id}`;
  await sql.end({ timeout: 5 });
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: how the page looks — screenshot it after npm run build.");
