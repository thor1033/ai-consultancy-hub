// Verification of the tool-use loop's iteration cap — how many rounds an agent
// may take, and what happens when it runs out.
//
//   node packages/agent/verify-loop.mjs
//
// No Anthropic API key and no spend. A throwaway HTTP server stands in for the
// Messages API and the SDK is pointed at it with ANTHROPIC_BASE_URL, so the
// real runAgent runs against the real SDK — only the far end is fake. The
// fixture counts the calls it receives, which is the only honest way to check a
// cap: the tool output cannot tell you how many times the loop went round.
//
// The case that matters is the last kind: a run that hits the cap has NOT
// answered the question, and must not return its last half-formed sentence as
// though it had.
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The package's TypeScript uses extensionless imports, which bundlers resolve
// and Node does not. Harness-only; nothing in the package changes for a test.
// Same hook as packages/db/verify-agents.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".") || !context.parentURL) throw err;
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

// ── the throwaway Messages API ───────────────────────────────────────────────
// `plan.answerOn` is the turn the model finally stops asking for tools; Infinity
// means it never does, which is what a runaway agent looks like.
const plan = { calls: 0, answerOn: Infinity, textEachTurn: false };

const http = createServer(async (req, res) => {
  for await (const _ of req) void _; // drain
  plan.calls++;

  const answering = plan.calls >= plan.answerOn;
  const content = [];
  if (answering) {
    content.push({ type: "text", text: "Two meetings tomorrow: standup at 09:00, review at 13:00." });
  } else {
    if (plan.textEachTurn) content.push({ type: "text", text: `Checking the calendar (round ${plan.calls})…` });
    content.push({ type: "tool_use", id: `tu_${plan.calls}`, name: "probe", input: { round: plan.calls } });
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_${plan.calls}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content,
      stop_reason: answering ? "end_turn" : "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  );
});

await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
delete process.env.LANGFUSE_PUBLIC_KEY; // no tracing side-trips

const { runAgent, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CEILING } = await import("./src/runAgent.ts");

const TOOLS = [
  { name: "probe", description: "A tool the fixture model keeps asking for.", input_schema: { type: "object", properties: {} } },
];

let toolCalls = 0;
/** Runs one scenario with a fresh fixture state. */
async function run({ answerOn = Infinity, maxIterations, textEachTurn = false, tools = TOOLS } = {}) {
  plan.calls = 0;
  plan.answerOn = answerOn;
  plan.textEachTurn = textEachTurn;
  toolCalls = 0;
  const result = await runAgent({
    prompt: "What is on tomorrow?",
    tools,
    toolExecutor: async () => {
      toolCalls++;
      return "two events";
    },
    ...(maxIterations === undefined ? {} : { maxIterations }),
  });
  return result;
}

try {
  // ── the default ──────────────────────────────────────────────────────────
  const capped = await run();
  check(
    `a model that never stops asking for tools is cut off at the default of ${DEFAULT_MAX_ITERATIONS}`,
    plan.calls === DEFAULT_MAX_ITERATIONS && capped.iterations === DEFAULT_MAX_ITERATIONS,
    `${plan.calls} model calls, ${capped.iterations} iterations`,
  );
  check("the tools really did run each round", toolCalls === DEFAULT_MAX_ITERATIONS, `${toolCalls} tool calls`);
  check("the result reports the cap it ran under", capped.maxIterations === DEFAULT_MAX_ITERATIONS);

  // The point of the whole increment: a cut-off run must not look like an answer.
  check("a cut-off run is flagged exhausted", capped.exhausted === true);
  check(
    "and says so in the text, because that is what a person reads",
    /Stopped after 10 rounds of tool use/.test(capped.text),
    capped.text.slice(0, 72),
  );
  check(
    "the note explains what to do about it",
    /incomplete/.test(capped.text) && /iteration limit/.test(capped.text),
  );

  // ── a run that finishes ──────────────────────────────────────────────────
  const finished = await run({ answerOn: 3 });
  check("a run that reaches an answer stops there", plan.calls === 3 && finished.iterations === 3);
  check("and is not flagged exhausted", finished.exhausted === false);
  check(
    "and carries no warning note",
    /standup at 09:00/.test(finished.text) && !/Stopped after/.test(finished.text),
    finished.text.slice(0, 60),
  );
  check("stopReason is the model's own", finished.stopReason === "end_turn", finished.stopReason);

  // ── per-agent values ─────────────────────────────────────────────────────
  const tight = await run({ maxIterations: 3 });
  check("an agent can lower the cap", plan.calls === 3 && tight.maxIterations === 3, `${plan.calls} model calls`);

  const roomy = await run({ maxIterations: 25 });
  check("and raise it — the whole reason for the increment", plan.calls === 25 && roomy.exhausted === true, `${plan.calls} model calls`);

  const generous = await run({ maxIterations: 25, answerOn: 14 });
  check(
    "a raised cap is a ceiling, not a target: the run still stops when it has an answer",
    plan.calls === 14 && generous.exhausted === false,
    `${plan.calls} model calls`,
  );

  // ── clamping ─────────────────────────────────────────────────────────────
  // The row is editable, so the runtime — not the form — has to hold the line.
  const zero = await run({ maxIterations: 0 });
  check("a cap of 0 is clamped up to 1 rather than running nothing", zero.maxIterations === 1 && plan.calls === 1);

  const negative = await run({ maxIterations: -5 });
  check("so is a negative one", negative.maxIterations === 1 && plan.calls === 1);

  const fractional = await run({ maxIterations: 3.9 });
  check("a fractional cap truncates", fractional.maxIterations === 3 && plan.calls === 3);

  const absurd = await run({ maxIterations: 100000 });
  check(
    `an absurd cap is clamped to the ceiling of ${MAX_ITERATIONS_CEILING}`,
    absurd.maxIterations === MAX_ITERATIONS_CEILING && plan.calls === MAX_ITERATIONS_CEILING,
    `${plan.calls} model calls`,
  );

  // ── partial work ─────────────────────────────────────────────────────────
  const partial = await run({ maxIterations: 4, textEachTurn: true });
  check(
    "a partial answer is kept and the note appended, not swapped for it",
    /round 4/.test(partial.text) && /Stopped after 4 rounds/.test(partial.text),
    partial.text.replace(/\n+/g, " ").slice(0, 80),
  );

  // ── no tools ─────────────────────────────────────────────────────────────
  const plain = await run({ answerOn: 1, tools: [] });
  check(
    "an agent with no tools takes exactly one turn and is never exhausted",
    plan.calls === 1 && plain.iterations === 1 && plain.exhausted === false,
  );
} finally {
  http.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(
  failedChecks.length === 0
    ? `\nAgent loop OK (${checks.length} checks)`
    : `\nAgent loop FAILED (${failedChecks.length}/${checks.length})`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
