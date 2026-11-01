// What a trace carries (src/tracing.ts, docs/data-protection-review.md 2.6).
//
//   node --experimental-transform-types verify-tracing.mjs
//
// No database, no API key, no spend. Two throwaway HTTP servers: one stands in
// for the Messages API (a tool call, then an answer), one for Langfuse's
// ingestion endpoint, keeping every batch the SDK sends. The run goes through
// the shipping runAgent with the real Langfuse SDK, so what is asserted is what
// would leave the hub.
//
// What is proven: by default a trace carries no prompt, message, tool input,
// tool output or answer — only names, sizes, tokens and timings; and with
// HUB_TRACE_CONTENT=1 the content is there, so the switch is what decides.
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The package's TypeScript uses extensionless imports; same hook as verify-loop.mjs.
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

const SECRET_PROMPT = "Summarise Peter Hansen's sick leave, CPR 010190-1234";
const SECRET_TOOL_IN = "mailbox:hr-confidential";
const SECRET_TOOL_OUT = "Peter was off 14 days in October (doctor's note).";
const SECRET_ANSWER = "Peter Hansen has had 14 sick days this quarter.";

// ── the stand-in Messages API ────────────────────────────────────────────────
let call = 0;
const anthropic = createServer(async (req, res) => {
  for await (const _ of req);
  call++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({ type: "message_start", message: { id: `m${call}`, type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 0 } } });
  if (call % 2 === 1) {
    send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tu${call}`, name: "read_mail", input: {} } });
    send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ folder: SECRET_TOOL_IN }) } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
  } else {
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SECRET_ANSWER } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
  }
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));

// ── the stand-in Langfuse ────────────────────────────────────────────────────
let received = [];
const langfuse = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  if (req.url?.includes("/api/public/ingestion")) received.push(raw);
  res.writeHead(207, { "content-type": "application/json" });
  res.end(JSON.stringify({ successes: [], errors: [] }));
});
await new Promise((r) => langfuse.listen(0, "127.0.0.1", r));

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-fixture";
process.env.LANGFUSE_SECRET_KEY = "sk-lf-fixture";
process.env.LANGFUSE_HOST = `http://127.0.0.1:${langfuse.address().port}`;
delete process.env.HUB_TRACE_CONTENT;

const { runAgent } = await import("./src/runAgent.ts");
const run = () =>
  runAgent({
    prompt: SECRET_PROMPT,
    tools: [{ name: "read_mail", description: "Read a mail folder.", input_schema: { type: "object", properties: { folder: { type: "string" } } } }],
    toolExecutor: async () => SECRET_TOOL_OUT,
  });

try {
  const first = await run();
  const sent = received.join("\n");
  check("the run itself is unchanged: it answers", first.text.includes(SECRET_ANSWER), first.text.slice(0, 60));
  check("a trace was sent", sent.length > 0 && /agent\.run/.test(sent));
  check("it carries the trace's shape: turns, the tool's name, token usage", /claude\.turn\.1/.test(sent) && /tool\.read_mail/.test(sent) && /"input":120|"input":\s*120/.test(sent));
  check("and sizes in place of content", /content is not traced/.test(sent) && /"chars":\d+/.test(sent));
  for (const [what, secret] of [
    ["the prompt", "Peter Hansen's sick leave"],
    ["a personal number in it", "010190-1234"],
    ["the tool's input", SECRET_TOOL_IN],
    ["the tool's output", "doctor's note"],
    ["the answer", "14 sick days"],
  ]) {
    check(`by default it does not carry ${what}`, !sent.includes(secret.replace(/'/g, "\\u0027")) && !sent.includes(secret));
  }

  received = [];
  call = 0;
  process.env.HUB_TRACE_CONTENT = "1";
  await run();
  const withContent = received.join("\n");
  check("with HUB_TRACE_CONTENT=1, the content is traced (the switch decides)", withContent.includes("010190-1234") && withContent.includes("14 sick days") && withContent.includes(SECRET_TOOL_IN));
} finally {
  anthropic.close();
  langfuse.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
