// Verification of the prompt bench (bench-prompt.mjs), run as a person runs it:
// the real CLI, as a child process, against a throwaway Messages API.
//
//   node packages/agent/verify-bench.mjs
//
// No API key and no spend. The stand-in makes a longer prompt slower to its
// first token (1 ms per 40 characters of system prompt), so the bench's claim
// — "without this section it is faster, and this section is the biggest" —
// can be checked against a cause this script chose. It also counts tokens
// (characters / 4) on the count_tokens route, so the exact-by-part table can
// be checked to add up.
//
// With DATABASE_URL set it also runs a spec naming a skill, and checks the
// request the bench sent is the agent's brief plus the skill's filled
// template. Without it, that half is skipped and says so.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The db package uses extensionless imports; this resolves them for the skill half.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the stand-in API ─────────────────────────────────────────────────────────
const seen = { messages: [], counts: 0 };
const textOf = (blocks) => (typeof blocks === "string" ? blocks : (blocks ?? []).map((b) => b.text ?? "").join("\n"));
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const system = textOf(body.system);
  const prompt = textOf(body.messages?.at(-1)?.content);
  if (req.url.startsWith("/v1/messages/count_tokens")) {
    seen.counts++;
    const chars = system.length + prompt.length + (body.tools ? JSON.stringify(body.tools).length : 0);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
    return;
  }
  seen.messages.push({ system, prompt, thinking: body.thinking?.type, effort: body.output_config?.effort });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: Math.ceil((system.length + prompt.length) / 4), output_tokens: 0 } } });
  await sleep(Math.round(system.length / 40));
  let index = 0;
  if (body.thinking?.type !== "disabled") {
    send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
    send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "…" } });
    await sleep(60);
    send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "s" } });
    send({ type: "content_block_stop", index });
    index++;
  }
  send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
  send({ type: "content_block_delta", index, delta: { type: "text_delta", text: "Done." } });
  await sleep(20);
  send({ type: "content_block_stop", index });
  send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));

const BENCH = fileURLToPath(new URL("./bench-prompt.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "verify-bench-"));
function bench(specObj, args = [], env = {}) {
  const spec = join(dir, `spec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(spec, JSON.stringify(specObj));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BENCH, spec, ...args], {
      env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${http.address().port}`, ANTHROPIC_API_KEY: "fixture-key", LANGFUSE_PUBLIC_KEY: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const BIG = "Read every line of the transcript twice and check each name against the roster. ".repeat(60);
const BRIEF = `You are a test brief.\n\n## Small\nBe brief.\n\n## Big\n${BIG}\n\n## Last\nSay done.`;
const base = { system: BRIEF, prompt: "Summarise.\n\n## Detail\nEvery detail matters here.", model: "claude-haiku-4-5" };

try {
  // ── refusals ─────────────────────────────────────────────────────────────
  console.log("— refusals —");
  let before = seen.messages.length;
  const noKey = await bench({ runs: 1, base }, [], { ANTHROPIC_API_KEY: "" });
  check("without an API key it refuses, and says nothing was run", noKey.code === 2 && /ANTHROPIC_API_KEY is not set.*nothing was run/.test(noKey.out) && seen.messages.length === before, noKey.out.trim().split("\n").at(-1));
  const tooMany = await bench({ runs: 5, base, ablate: true, variants: [{ name: "a" }, { name: "b" }] }, ["--max-calls", "10"]);
  check("over --max-calls it refuses before any call", tooMany.code === 2 && /30 real model call\(s\)/.test(tooMany.out) && /Nothing was run/.test(tooMany.out) && seen.messages.length === before, tooMany.out.trim().split("\n").at(-1));
  const badSection = await bench({ runs: 1, base, variants: [{ name: "x", dropSections: ["Nonexistent"] }] });
  check("a section that does not exist is refused, listing the sections there are", badSection.code === 2 && /Sections: \(preamble\) · Small · Big · Last · \(preamble\) \(request\) · Detail \(request\)/.test(badSection.out), badSection.out.trim().split("\n").at(-1));

  // ── a bench ──────────────────────────────────────────────────────────────
  console.log("\n— a bench —");
  before = seen.messages.length;
  const out = join(dir, "results.json");
  const run = await bench({ runs: 2, base, ablate: true, variants: [{ name: "as is" }, { name: "no thinking", thinking: false }, { name: "effort low", effort: "low" }] }, ["--out", out]);
  check("it runs and exits cleanly", run.code === 0, run.out.trim().split("\n").at(-1));
  const res = JSON.parse(readFileSync(out, "utf8"));
  const names = res.summary.map((s) => s.name);
  check(
    "ablate adds one variant per section, of the brief and of the request",
    JSON.stringify(names) === JSON.stringify(["as is", "no thinking", "effort low", 'without "Small"', 'without "Big"', 'without "Last"', 'without "Detail" (request)']),
    names.join(" · "),
  );
  const made = seen.messages.slice(before);
  check("it made exactly runs × variants model calls", made.length === 14, `${made.length}`);
  check("interleaved: every variant once, then every variant again", JSON.stringify(res.order) === JSON.stringify([...names, ...names]));
  const byName = Object.fromEntries(res.summary.map((s) => [s.name, s]));
  check("without the big section the first token comes sooner", byName['without "Big"'].firstTokenMs < byName["as is"].firstTokenMs - 50, `${byName['without "Big"'].firstTokenMs} vs ${byName["as is"].firstTokenMs} ms`);
  check("dropping a section really removes it from what is sent", made.some((m) => !m.system.includes("## Big") && m.system.includes("## Small")) && made.some((m) => !m.prompt.includes("## Detail") && m.prompt.includes("Summarise.")));
  check("no thinking is sent as thinking disabled, and records no thinking time", made.some((m) => m.thinking === "disabled") && byName["no thinking"].thinkingMs === 0 && byName["as is"].thinkingMs >= 50);
  check("effort is sent as asked", made.some((m) => m.effort === "low"));
  check("each variant reports a cold run and a warm median", res.summary.every((s) => s.coldMs !== null && s.warmMs !== null && s.ok === 2));
  const big = res.anatomy.find((a) => a.part === "brief: Big");
  const sorted = [...res.anatomy].sort((a, b) => b.tokens - a.tokens);
  check("the exact count by part names the big section as the largest", sorted[0].part === "brief: Big" && big.tokens > res.total / 2, `${sorted[0].part} ${sorted[0].tokens} of ${res.total}`);
  const sum = res.anatomy.reduce((n, a) => n + a.tokens, 0);
  check("and the parts add up to the whole, within rounding", Math.abs(sum - res.total) <= res.anatomy.length * 2, `${sum} of ${res.total}`);
  check("the report prints a table with the change against the first variant", /variant\s+median\s+cold\s+warm/.test(run.out) && /without "Big"\s.*-\d+%/.test(run.out));
  check("and what it spent", /Spent \$\d+\.\d\d on 14 call\(s\)\./.test(run.out));

  // ── from a skill in the database ─────────────────────────────────────────
  console.log("\n— a skill from the database —");
  if (!process.env.DATABASE_URL) {
    console.log("skip  DATABASE_URL is not set — run with --env-file=apps/web/.env.local to check a skill spec");
  } else {
    const db = await import("../db/src/index.ts");
    const stamp = Date.now();
    const agent = await db.createAgent({ slug: `verify-bench-${stamp}`, name: "Verify Bench", instructions: "You are the bench's agent.\n\n## Rules\nNever guess.", mcpServers: [] });
    try {
      await db.createSkill({ agentId: agent.id, slug: `verify-bench-skill-${stamp}`, name: "Verify meeting", promptTemplate: "Meeting on {{meetingDate}}:\n{{transcript}}\n\n## Output\nA list.", parameters: [{ name: "meetingDate", description: "d", required: true }, { name: "transcript", description: "t", required: true }] });
      writeFileSync(join(dir, "meeting.txt"), "00:00:01 Ditlev: TEST line.");
      before = seen.messages.length;
      const skillRun = await bench({ runs: 1, base: { skill: `verify-bench-skill-${stamp}`, args: { meetingDate: "2026-10-31", transcript: "@file:meeting.txt" } }, ablate: true });
      const sent = seen.messages.slice(before);
      check("a skill spec sends the agent's brief and the filled template", skillRun.code === 0 && sent[0]?.system.startsWith("You are the bench's agent.") && sent[0]?.prompt.includes("Meeting on 2026-10-31:\n00:00:01 Ditlev: TEST line."), skillRun.out.trim().split("\n")[0]);
      check("and ablates the brief's and the template's sections", /without "Rules"/.test(skillRun.out) && /without "Output" \(request\)/.test(skillRun.out));
    } finally {
      await db.deleteAgent(agent.id);
      await db.getSql().end({ timeout: 5 });
    }
  }
} finally {
  http.close();
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: real timings — run the bench with a key (it spends money; it says how much first).");
