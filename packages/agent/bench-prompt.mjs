// The prompt bench: how fast is this prompt, and which part of it is slow?
//
//   node --env-file=apps/web/.env.local packages/agent/bench-prompt.mjs <spec.json> [--out results.json] [--max-calls N]
//   npm run bench:prompt -w @ai-hub/agent -- bench/secretary-meeting.json
//
// THIS SPENDS MONEY: every run is a real call to the Messages API with
// ANTHROPIC_API_KEY. It says how many calls it will make before it starts,
// refuses more than --max-calls (default 40), and prints what it spent.
//
// What it measures is ONE model turn of a prompt — the agent's brief, the
// request, and (if given) the tool definitions — through the same runAgent the
// hub uses, so the timings split the way a run's page splits them: waiting for
// the first token, thinking, writing. It does not connect MCP servers or run
// tools: a slow tool is the tool's server, and a run's own page shows that.
// What this answers is the prompt's share.
//
// The spec (JSON):
//
//   {
//     "runs": 3,                         // per variant; the first is reported as "cold"
//     "base": {
//       "agent": "secretary",            // the agent's brief from the database (DATABASE_URL)
//       "skill": "meeting-to-pm",        // or a skill: its agent's brief + its filled template
//       "args": { "transcript": "@file:test-meeting.txt", "meetingDate": "2026-10-31" },
//       "system": "...", "systemFile": "brief.md",   // or a brief given directly
//       "prompt": "...", "promptFile": "ask.txt",    // the request, when no skill gives it
//       "toolsFile": "tools.json",       // Anthropic tool definitions to show the model (optional)
//       "model": "claude-opus-4-8", "effort": "medium", "thinking": true, "maxTokens": 8000
//     },
//     "ablate": true,                    // add a variant per "## " section of the brief or the request, without it
//     "variants": [
//       { "name": "as is" },
//       { "name": "effort low", "effort": "low" },
//       { "name": "no thinking", "thinking": false },
//       { "name": "without the rules", "dropSections": ["Rules you do not bend"] }   // from the brief or the request
//     ]
//   }
//
// Paths in the spec ("@file:…", "…File") are relative to the spec file.
// Variants run interleaved — A, B, C, A, B, C — so a slow minute on the API or
// a warm cache does not land on one variant. Each variant's first run is
// reported apart ("cold"): it pays for writing the prompt cache that the later
// ones read.
import { registerHooks } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function fail(message) {
  console.error(`\n${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const specPath = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--out" && argv[argv.indexOf(a) - 1] !== "--max-calls");
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!specPath) fail("Usage: bench-prompt.mjs <spec.json> [--out results.json] [--max-calls N]");
const specFile = resolve(specPath);
if (!existsSync(specFile)) fail(`No spec at ${specFile}.`);
const spec = JSON.parse(readFileSync(specFile, "utf8"));
const here = dirname(specFile);
const readRel = (p) => readFileSync(resolve(here, p), "utf8");
const maxCalls = Number(flag("--max-calls") ?? 40);

if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is not set. The bench calls the real model; nothing was run.");

const { runAgent } = await import("./src/runAgent.ts");
const { getAnthropic } = await import("./src/client.ts");
const { DEFAULT_MODEL } = await import("./src/models.ts");

// ── the base prompt ──────────────────────────────────────────────────────────
const base = spec.base ?? {};
let brief = base.system ?? (base.systemFile ? readRel(base.systemFile) : null);
let request = base.prompt ?? (base.promptFile ? readRel(base.promptFile) : null);
let source = brief ? "the spec's brief" : null;
let agentDefaults = {};

if (base.agent || base.skill) {
  if (!process.env.DATABASE_URL) fail(`"${base.skill ? "skill" : "agent"}" reads the database; DATABASE_URL is not set.`);
  const db = await import("../db/src/index.ts");
  try {
    if (base.skill) {
      const skill = await db.getSkill(base.skill);
      if (!skill) fail(`No skill "${base.skill}" in this database.`);
      const agent = await db.getAgent(skill.agentId);
      const { fillTemplate } = await import("../../apps/web/src/lib/skillPrompt.ts");
      const args = Object.fromEntries(
        Object.entries(base.args ?? {}).map(([k, v]) => [k, typeof v === "string" && v.startsWith("@file:") ? readRel(v.slice(6)) : v]),
      );
      const filled = fillTemplate(skill.promptTemplate, skill.parameters ?? [], args);
      if ("error" in filled) fail(`The skill's template could not be filled: ${filled.error}`);
      brief = brief ?? agent.instructions;
      request = request ?? filled.prompt;
      source = `${agent.name}, skill "${skill.name}"`;
      agentDefaults = { model: agent.model, effort: agent.effort };
    } else {
      const agent = await db.getAgent(base.agent);
      if (!agent) fail(`No agent "${base.agent}" in this database.`);
      brief = brief ?? agent.instructions;
      source = agent.name;
      agentDefaults = { model: agent.model, effort: agent.effort };
    }
  } finally {
    await db.getSql().end({ timeout: 5 });
  }
}
if (!brief) fail("The spec gives no brief: set base.agent, base.skill, base.system or base.systemFile.");
if (!request) fail("The spec gives no request: set base.prompt, base.promptFile, or base.skill with args.");
const tools = base.toolsFile ? JSON.parse(readRel(base.toolsFile)) : [];

// ── the brief's sections ─────────────────────────────────────────────────────
// A "## " heading starts a section; whatever comes before the first heading is
// the preamble. Dropping a section removes its heading and its body.
function sections(text) {
  const out = [];
  let current = { heading: "(preamble)", lines: [] };
  for (const line of text.split("\n")) {
    if (/^## /.test(line)) {
      out.push(current);
      current = { heading: line.slice(3).trim(), lines: [line] };
    } else current.lines.push(line);
  }
  out.push(current);
  return out.filter((s) => s.lines.join("").trim());
}
const parts = sections(brief);
const requestParts = sections(request);
const matches = (s, names) => names.some((n) => s.heading.toLowerCase().includes(n.toLowerCase()));
const joined = (ss) => ss.map((s) => s.lines.join("\n")).join("\n");
/** The brief and the request with the named sections taken out of either. */
function without(names) {
  if (![...parts, ...requestParts].some((s) => matches(s, names))) {
    const all = [...parts.map((s) => s.heading), ...requestParts.map((s) => `${s.heading} (request)`)];
    fail(`No section matches ${JSON.stringify(names)}. Sections: ${all.join(" · ")}`);
  }
  return {
    system: joined(parts.filter((s) => !matches(s, names))) || ".",
    prompt: joined(requestParts.filter((s) => !matches(s, names))) || ".",
  };
}

// ── the variants ─────────────────────────────────────────────────────────────
const variants = [...(spec.variants?.length ? spec.variants : [{ name: "as is" }])];
if (spec.ablate) {
  for (const s of parts) if (s.heading !== "(preamble)") variants.push({ name: `without "${s.heading}"`, dropSections: [s.heading] });
  for (const s of requestParts) if (s.heading !== "(preamble)") variants.push({ name: `without "${s.heading}" (request)`, dropSections: [s.heading] });
}
const resolved = variants.map((v, i) => {
  const settings = { ...agentDefaults, ...base, ...v };
  const dropped = v.dropSections ? without(v.dropSections) : null;
  return {
    name: v.name ?? `variant ${i + 1}`,
    system: v.system ?? dropped?.system ?? brief,
    prompt: v.prompt ?? dropped?.prompt ?? request,
    tools: v.tools === false ? [] : tools,
    model: settings.model ?? DEFAULT_MODEL,
    effort: settings.effort ?? undefined,
    thinking: settings.thinking ?? true,
    maxTokens: settings.maxTokens ?? 8000,
  };
});
const runs = Math.max(1, Math.trunc(spec.runs ?? 3));
const calls = runs * resolved.length;
console.log(`Prompt bench — ${source}`);
console.log(`${resolved.length} variant(s) × ${runs} run(s) = ${calls} real model call(s), interleaved.`);
if (calls > maxCalls) fail(`That is more than --max-calls ${maxCalls}. Lower "runs", drop variants, or pass --max-calls ${calls}. Nothing was run.`);

// ── exact token counts, by part ─────────────────────────────────────────────
// Counting is free and exact: the whole first request, then the same request
// without one part; the difference is that part's size.
const client = getAnthropic();
const first = resolved[0];
async function countTokens(system, prompt, withTools) {
  const r = await client.messages.countTokens({
    model: first.model,
    system,
    messages: [{ role: "user", content: prompt }],
    ...(withTools && tools.length ? { tools } : {}),
  });
  return r.input_tokens;
}
const total = await countTokens(brief, request, true);
const anatomy = [];
for (const s of parts) {
  const rest = joined(parts.filter((p) => p !== s)) || ".";
  anatomy.push({ part: s.heading === "(preamble)" ? "brief: preamble" : `brief: ${s.heading}`, tokens: total - (await countTokens(rest, request, true)) });
}
if (tools.length) anatomy.push({ part: "tool definitions", tokens: total - (await countTokens(brief, request, false)) });
if (requestParts.length > 1) {
  for (const s of requestParts) {
    const rest = joined(requestParts.filter((p) => p !== s)) || ".";
    anatomy.push({ part: s.heading === "(preamble)" ? "request: opening" : `request: ${s.heading}`, tokens: total - (await countTokens(brief, rest, true)) });
  }
} else {
  anatomy.push({ part: "the request", tokens: total - (await countTokens(brief, ".", true)) });
}

// ── the runs, interleaved ────────────────────────────────────────────────────
const results = resolved.map((v) => ({ name: v.name, runs: [] }));
const order = [];
for (let r = 0; r < runs; r++) {
  for (let i = 0; i < resolved.length; i++) {
    const v = resolved[i];
    order.push(v.name);
    process.stdout.write(`  run ${r + 1}/${runs} · ${v.name} … `);
    try {
      const out = await runAgent({
        prompt: v.prompt,
        system: v.system,
        model: v.model,
        effort: v.effort,
        thinking: v.thinking,
        maxTokens: v.maxTokens,
        maxIterations: 1,
        tools: v.tools,
      });
      const t = out.timeline.turns[0];
      results[i].runs.push({
        totalMs: out.latencyMs,
        firstTokenMs: t?.firstTokenMs ?? null,
        thinkingMs: t?.thinkingMs ?? 0,
        writingMs: (t?.writingMs ?? 0) + (t?.toolInputMs ?? 0),
        inputTokens: (t?.inputTokens ?? 0) + (t?.cacheReadTokens ?? 0) + (t?.cacheCreationTokens ?? 0),
        cacheReadTokens: t?.cacheReadTokens ?? 0,
        outputTokens: t?.outputTokens ?? 0,
        stopReason: t?.stopReason ?? null,
        costUsd: out.costUsd,
      });
      console.log(`${(out.latencyMs / 1000).toFixed(1)} s`);
    } catch (err) {
      results[i].runs.push({ error: err instanceof Error ? err.message : String(err) });
      console.log(`failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── the report ───────────────────────────────────────────────────────────────
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sec = (ms) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const summary = results.map((r) => {
  const ok = r.runs.filter((x) => !x.error);
  const warm = ok.slice(1);
  return {
    name: r.name,
    ok: ok.length,
    failed: r.runs.length - ok.length,
    coldMs: ok[0]?.totalMs ?? null,
    warmMs: median(warm.map((x) => x.totalMs)),
    medianMs: median(ok.map((x) => x.totalMs)),
    firstTokenMs: median(ok.map((x) => x.firstTokenMs)),
    thinkingMs: median(ok.map((x) => x.thinkingMs)),
    writingMs: median(ok.map((x) => x.writingMs)),
    inputTokens: median(ok.map((x) => x.inputTokens)),
    outputTokens: median(ok.map((x) => x.outputTokens)),
    costUsd: ok.reduce((n, x) => n + (x.costUsd ?? 0), 0),
  };
});
const ref = summary[0]?.medianMs;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const width = Math.max(10, ...summary.map((s) => s.name.length)) + 2;
console.log(`\n${pad("variant", width)}${lpad("median", 8)}${lpad("cold", 8)}${lpad("warm", 8)}${lpad("1st tok", 9)}${lpad("think", 8)}${lpad("write", 8)}${lpad("in tok", 9)}${lpad("out tok", 9)}${lpad("vs 1st", 8)}`);
for (const s of summary) {
  const delta = ref && s.medianMs !== null ? `${s.medianMs >= ref ? "+" : ""}${Math.round(((s.medianMs - ref) / ref) * 100)}%` : "—";
  console.log(
    `${pad(s.name, width)}${lpad(sec(s.medianMs), 8)}${lpad(sec(s.coldMs), 8)}${lpad(sec(s.warmMs), 8)}${lpad(sec(s.firstTokenMs), 9)}${lpad(sec(s.thinkingMs), 8)}${lpad(sec(s.writingMs), 8)}` +
      `${lpad(s.inputTokens ?? "—", 9)}${lpad(s.outputTokens ?? "—", 9)}${lpad(s === summary[0] ? "" : delta, 8)}${s.failed ? `  (${s.failed} failed)` : ""}`,
  );
}
console.log(`\nWhat "${first.name}" sends, by part (exact tokens, ${total} in all):`);
for (const a of [...anatomy].sort((x, y) => y.tokens - x.tokens)) {
  console.log(`  ${lpad(a.tokens, 7)}  ${lpad(`${Math.round((a.tokens / total) * 100)}%`, 4)}  ${a.part}`);
}
const spent = summary.reduce((n, s) => n + s.costUsd, 0);
console.log(`\nSpent $${spent.toFixed(2)} on ${calls} call(s).`);
console.log(
  "Reading it: output tokens drive most of a turn's time, so a variant that is faster usually wrote or thought less — " +
    "check its answer is still the answer you want. A smaller prompt mostly shortens the wait for the first token.",
);

const out = flag("--out");
if (out) {
  writeFileSync(resolve(out), JSON.stringify({ spec: specFile, source, at: new Date().toISOString(), order, anatomy, total, summary, results }, null, 2));
  console.log(`Results written to ${resolve(out)}.`);
}
