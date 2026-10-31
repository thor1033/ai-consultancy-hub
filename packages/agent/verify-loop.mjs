// Verification of the tool-use loop: its iteration cap, and the streamed
// transport underneath it.
//
//   node packages/agent/verify-loop.mjs
//
// No Anthropic API key and no spend. A throwaway HTTP server stands in for the
// Messages API and the SDK is pointed at it with ANTHROPIC_BASE_URL, so the
// real runAgent runs against the real SDK — only the far end is fake. The
// fixture counts the calls it receives, which is the only honest way to check a
// cap: the tool output cannot tell you how many times the loop went round.
//
// The fixture speaks server-sent events, because runAgent now streams: the SDK
// only permits an output budget above its ten-minute line on a streamed
// request, and a non-streaming fixture would pass against a non-streaming
// runAgent that throws on every real call. So the fixture records what each
// request asked for, and the checks read that record rather than trusting the
// loop's own account of itself.
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
// means it never does, which is what a runaway agent looks like. `thinkOnly`
// reproduces the expensive silence: a turn that is all thinking, cut off at
// max_tokens before a visible character. `requests` keeps every request body
// the SDK actually sent, so a check can read `stream` and `max_tokens` off the
// wire instead of off the code.
// `pace` slows the stream down by kind — before the first block, inside a
// thinking block, inside a text block — so the timeline's split can be checked
// against delays the fixture chose.
const plan = { calls: 0, answerOn: Infinity, textEachTurn: false, thinkOnly: false, thinkFirst: false, pace: null, requests: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes one assistant message as the event stream the real API emits. Every
 * block is split across two deltas on purpose — a tool_use input that arrives
 * in two pieces of partial JSON is the thing streaming has to reassemble.
 */
async function writeStream(res, blocks, stopReason) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const halves = (s) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];

  send({
    type: "message_start",
    message: {
      id: `msg_${plan.calls}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });

  if (plan.pace?.firstMs) await sleep(plan.pace.firstMs);
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of halves(block.text)) {
        send({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      }
    } else if (block.type === "tool_use") {
      send({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      for (const piece of halves(JSON.stringify(block.input))) {
        send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } });
      }
    } else if (block.type === "thinking") {
      send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "fixture-signature" } });
    }
    const pause = block.type === "thinking" ? plan.pace?.thinkingMs : block.type === "text" ? plan.pace?.textMs : 0;
    if (pause) await sleep(pause);
    send({ type: "content_block_stop", index });
  }

  send({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  res.end();
}

const http = createServer(async (req, res) => {
  let raw = "";
  for await (const piece of req) raw += piece;
  plan.calls++;
  plan.requests.push(JSON.parse(raw));

  const answering = plan.calls >= plan.answerOn;
  const blocks = [];
  let stopReason;
  if (plan.thinkOnly) {
    // The whole budget spent reasoning over a large tool result: a thinking
    // block, no text, and the API's own verdict that the output limit was hit.
    blocks.push({ type: "thinking", thinking: "Reading a 94KB project state against the transcript…" });
    stopReason = "max_tokens";
  } else if (answering) {
    if (plan.thinkFirst) blocks.push({ type: "thinking", thinking: "Two events; the review needs the deck." });
    blocks.push({ type: "text", text: "Two meetings tomorrow: standup at 09:00, review at 13:00." });
    stopReason = "end_turn";
  } else {
    if (plan.textEachTurn) blocks.push({ type: "text", text: `Checking the calendar (round ${plan.calls})…` });
    blocks.push({
      type: "tool_use",
      id: `tu_${plan.calls}`,
      name: "probe",
      input: { round: plan.calls, note: "assembled from two partial-JSON deltas" },
    });
    stopReason = "tool_use";
  }
  writeStream(res, blocks, stopReason);
});

await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
delete process.env.LANGFUSE_PUBLIC_KEY; // no tracing side-trips

const { runAgent, clockLine, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CEILING, DEFAULT_MAX_TOKENS } =
  await import("./src/runAgent.ts");

const TOOLS = [
  { name: "probe", description: "A tool the fixture model keeps asking for.", input_schema: { type: "object", properties: {} } },
];

let toolCalls = 0;
let lastToolInput = null;
/** Runs one scenario with a fresh fixture state. */
async function run({
  answerOn = Infinity,
  maxIterations,
  maxTokens,
  textEachTurn = false,
  thinkOnly = false,
  thinkFirst = false,
  pace = null,
  toolMs = 0,
  tools = TOOLS,
} = {}) {
  plan.thinkFirst = thinkFirst;
  plan.pace = pace;
  plan.calls = 0;
  plan.answerOn = answerOn;
  plan.textEachTurn = textEachTurn;
  plan.thinkOnly = thinkOnly;
  plan.requests = [];
  toolCalls = 0;
  lastToolInput = null;
  const result = await runAgent({
    prompt: "What is on tomorrow?",
    tools,
    toolExecutor: async (_name, input) => {
      toolCalls++;
      lastToolInput = input;
      if (toolMs) await sleep(toolMs);
      return "two events";
    },
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
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

  // ── the transport ────────────────────────────────────────────────────────
  // Read off the wire, not off the code: the SDK refuses a non-streaming
  // request above ~21,333 max_tokens before it leaves the process, so a budget
  // that reached the fixture at all is the proof that streaming is in place.
  const NON_STREAMING_CEILING = 21333;
  check(
    "every request is a streamed one",
    plan.requests.length > 0 && plan.requests.every((r) => r.stream === true),
  );
  check(
    `the default output budget (${DEFAULT_MAX_TOKENS}) is above the old non-streaming ceiling and still reached the API`,
    DEFAULT_MAX_TOKENS > NON_STREAMING_CEILING &&
      plan.requests.every((r) => r.max_tokens === DEFAULT_MAX_TOKENS),
    `max_tokens on the wire: ${plan.requests[0]?.max_tokens}`,
  );
  check(
    "a tool_use input split across stream deltas arrives at the tool whole",
    lastToolInput?.note === "assembled from two partial-JSON deltas" && lastToolInput?.round === DEFAULT_MAX_ITERATIONS,
    JSON.stringify(lastToolInput),
  );

  // ── the model is told what day it is ─────────────────────────────────────
  const clock = plan.requests[0]?.system?.find((b) => /^Today is /.test(b.text ?? ""));
  check(
    "every request carries today's date as a system block",
    Boolean(clock) && plan.requests.every((r) => r.system?.some((b) => /^Today is /.test(b.text ?? ""))),
    clock?.text?.slice(0, 60),
  );
  check("after the cached persona block, so the cache prefix is unchanged", plan.requests[0]?.system?.[0]?.cache_control?.type === "ephemeral" && !clock?.cache_control);
  check(
    "in the deployment's timezone when HUB_TIMEZONE names one",
    /\(Europe\/Copenhagen\)/.test(clockLine(new Date("2026-10-22T19:40:00Z"), "Europe/Copenhagen")) &&
      /Thursday 22 October 2026, 21:40/.test(clockLine(new Date("2026-10-22T19:40:00Z"), "Europe/Copenhagen")),
    clockLine(new Date("2026-10-22T19:40:00Z"), "Europe/Copenhagen"),
  );
  check(
    "and falls back to UTC on a zone name that does not exist",
    /\(UTC\)/.test(clockLine(new Date(), "Mars/Olympus_Mons")),
    clockLine(new Date(), "Mars/Olympus_Mons"),
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
  check(
    "text split across deltas is joined, and usage is summed across turns",
    finished.text === "Two meetings tomorrow: standup at 09:00, review at 13:00." &&
      finished.usage.inputTokens === 300 &&
      finished.usage.outputTokens === 60,
    `in ${finished.usage.inputTokens}, out ${finished.usage.outputTokens}`,
  );
  check(
    "the transcript keeps the assembled tool_use blocks for a follow-up turn",
    finished.transcript.filter((m) => m.role === "assistant").length === 3 &&
      finished.transcript.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.input?.round === 1),
      ),
  );

  // ── the expensive silence ────────────────────────────────────────────────
  // All thinking, no text, cut off at the limit. Was stored as `succeeded` with
  // an empty string until commit 4db1740; the bigger budget makes it rarer, not
  // impossible, so the loud failure has to survive the transport change.
  const silent = await run({ thinkOnly: true });
  check(
    "a turn that is all thinking and cut off at max_tokens is a failed run, not an empty answer",
    silent.stopReason === "max_tokens" && /Produced no answer/.test(silent.text),
    silent.text.slice(0, 60),
  );
  check(
    "and the note names the limit that was hit",
    new RegExp(`${DEFAULT_MAX_TOKENS}-token output limit`).test(silent.text) && silent.iterations === 1,
  );

  // ── per-run budget ───────────────────────────────────────────────────────
  const small = await run({ answerOn: 1, maxTokens: 5000 });
  check(
    "a per-run maxTokens override is sent as given",
    plan.requests[0]?.max_tokens === 5000 && small.exhausted === false,
    `max_tokens on the wire: ${plan.requests[0]?.max_tokens}`,
  );

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

  // ── where the time went ──────────────────────────────────────────────────
  // Two turns: a tool call, then a thought and an answer. The fixture holds
  // the first block back 150 ms, thinks for 250 ms and writes for 100 ms; the
  // tool takes 200 ms. The timeline has to put each where it happened.
  const paced = await run({ answerOn: 2, thinkFirst: true, pace: { firstMs: 150, thinkingMs: 250, textMs: 100 }, toolMs: 200 });
  const tl = paced.timeline;
  const [t1, t2] = tl?.turns ?? [];
  const near = (ms, want) => ms >= want - 20 && ms < want + 150;
  check("the result carries a timeline, one entry per model turn", tl?.version === 1 && tl.turns.length === 2, `${tl?.turns?.length} turns`);
  check("the wait for the first token is measured", near(t1?.firstTokenMs ?? -1, 150) && near(t2?.firstTokenMs ?? -1, 150), `${t1?.firstTokenMs} ms, ${t2?.firstTokenMs} ms`);
  check("thinking is told apart from writing", near(t2?.thinkingMs ?? -1, 250) && near(t2?.writingMs ?? -1, 100), `thinking ${t2?.thinkingMs} ms, writing ${t2?.writingMs} ms`);
  check("a turn that only called a tool did no thinking or writing", t1?.thinkingMs === 0 && t1?.writingMs === 0 && t1?.stopReason === "tool_use");
  check(
    "the tool call is timed under the turn that asked for it, with the size of what it returned",
    t1?.tools?.length === 1 && t1.tools[0].name === "probe" && near(t1.tools[0].ms, 200) && t1.tools[0].resultChars === "two events".length && t2?.tools?.length === 0,
    JSON.stringify(t1?.tools),
  );
  check("the second turn starts after the first turn and its tool", (t2?.startMs ?? 0) >= (t1?.totalMs ?? 0) + 190, `${t2?.startMs} ms`);
  check(
    "model time and tool time add up to nearly the whole run",
    near(tl?.toolMs ?? -1, 200) && tl.modelMs + tl.toolMs <= paced.latencyMs && paced.latencyMs - (tl.modelMs + tl.toolMs) < 100,
    `model ${tl?.modelMs} + tools ${tl?.toolMs} of ${paced.latencyMs} ms`,
  );
  check("each turn carries its own tokens", t1?.inputTokens === 100 && t1?.outputTokens === 20 && t2?.inputTokens === 100);
  check(
    "the prompt's shape is counted by part",
    tl?.prompt?.prompt === Math.round("What is on tomorrow?".length / 4) && tl.prompt.tools > 0 && tl.prompt.brief > 0 && tl.prompt.context === 0 && tl.prompt.history === 0,
    JSON.stringify(tl?.prompt),
  );
  check(
    "and it holds no content: no prompt, answer or tool result in it",
    !/tomorrow|two events|Two meetings|standup/i.test(JSON.stringify(tl)),
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
