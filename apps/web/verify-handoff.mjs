// Hand-offs between agents (lib/handoffs.ts, docs/agent-patterns.md), driven
// through the shipping run path against a real database — including the
// first one, the Secretary's meeting skills to the Context Steward.
//
//   node --experimental-transform-types --env-file=.env.local verify-handoff.mjs
//
// Needs DATABASE_URL, a migrated database and the Context Steward seeded
// (`npm run seed:context-steward -w @ai-hub/db`). No API key and no spend: a
// throwaway HTTP server stands in for the Messages API and streams a text
// answer to every call. Remote MCP servers are switched off — this must not
// reach the live PM-tool.
//
// What is proven: a run of a skill with a hand-off row ends with a run of the
// next agent AS THE SAME PERSON, pointed at that session, started only once
// the session is recorded with its transcript (the steward reads it); the
// answer says so, in the run's stored output as well as the returned one; a
// run with no hand-off row hands nothing off; a switched-off next agent is
// reported, not silently skipped; a hand-off keyed to any run carries the
// finished run's answer; and two agents that hand to each other stop at the
// depth limit, each refusal said. The steward's own seed declares its two
// hand-offs, and both are there.
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

const stamp = Date.now();
const HANDOFF_SKILL = `verify-handoff-meeting-${stamp}`;
const PLAIN_SKILL = `verify-handoff-plain-${stamp}`;

// --- the fake Messages API: a streamed text answer, and a record of each call --
// On a call whose prompt names a session (a hand-off to the steward), it reads
// the state of that session there and then: that is the moment the steward
// would read it.
const calls = [];
let sql;
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const user = body.messages?.at(-1)?.content;
  const prompt = typeof user === "string" ? user : (user ?? []).map((b) => b.text ?? "").join("");
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("");
  const call = { system, prompt, handedSession: null };
  const named = /session ([0-9a-f-]{36})/.exec(prompt);
  if (/^Hand-off:/.test(prompt) && named) {
    const [row] = await sql`select status, jsonb_array_length(transcript) as turns, output from agent_sessions where id = ${named[1]}`;
    call.handedSession = row ?? { status: "missing" };
  }
  calls.push(call);
  const answer = /CHAIN-B/.test(system) ? "B's answer: the beans are counted." : /CHAIN-C/.test(system) ? "C's answer." : "Noted. Nothing to propose from this.";
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } });
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
process.env.HUB_REMOTE_MCP_SERVERS = "";
delete process.env.LANGFUSE_PUBLIC_KEY;

const db = await import("../../packages/db/src/index.ts");
const seeds = await import("../../packages/db/src/seeds/context-steward.ts");
const secretary = await import("../../packages/db/src/seeds/secretary.ts");
const handoffs = await import("./src/lib/handoffs.ts");
const { runSkillForPrincipal, runAgentForPrincipal } = await import("./src/lib/agentRuns.ts");
sql = db.getSql();

const PERSON = { id: `verify-handoff-person-${stamp}`, roles: ["analyst"], source: "credential" };
const made = [];
let stewardWasEnabled;

async function stewardSessions() {
  return sql`
    select s.id, s.status, s.prompt, s.principal_id as "principalId", s.agent_skill_id as "skillId", s.output, s.depth, s.parent_session_id as parent
      from agent_sessions s join agents a on a.id = s.agent_id
     where a.slug = ${seeds.STEWARD_SLUG} and s.principal_id = ${PERSON.id}
     order by s.created_at`;
}
async function untilDone(query, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const rows = await query();
    if (rows.length && rows.every((s) => s.status !== "running")) return rows;
    if (Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 700));

try {
  // --- 0. the seed and the pure parts ---------------------------------------
  console.log("— the steward's seed —");
  const secretarySlugs = secretary.SECRETARY_SKILLS.map((s) => s.slug);
  check("the seed hands the steward the Secretary's two meeting skills, as rows it declares", seeds.CONTEXT_STEWARD_HANDOFFS.length === 2 && seeds.CONTEXT_STEWARD_HANDOFFS.every((h) => h.fromAgent === "secretary" && secretarySlugs.includes(h.skill)));
  check("and those two skills tell the Secretary the hub hands the meeting on", secretary.SECRETARY_SKILLS.filter((s) => seeds.STEWARD_HANDOFF_SKILLS.includes(s.slug)).every((s) => /hands (the meeting|it) to the\s+Context Steward/.test(s.promptTemplate)));
  check("the steward's brief has the hand-off section", /## A hand-off/.test(seeds.CONTEXT_STEWARD_AGENT.instructions) && /Do not sweep/.test(seeds.CONTEXT_STEWARD_AGENT.instructions));
  const prompt = db.renderHandoffPrompt(seeds.STEWARD_HANDOFF_PROMPT, { sessionId: "abc", skillName: "Meeting to PM", agentName: "Secretary", output: "o", prompt: "p" });
  check("the hand-off prompt names the session, the skill and the agent, and says not to sweep", /session abc/.test(prompt) && /"Meeting to PM"/.test(prompt) && /Secretary/.test(prompt) && /Do not sweep/.test(prompt) && !/\{\{/.test(prompt));
  check("a chain stops at two hand-offs deep", handoffs.HANDOFF_MAX_DEPTH === 2);

  console.log("\n— runHandoffs, with a stand-in starter —");
  const steward = await db.getAgent(seeds.STEWARD_SLUG);
  if (!steward) throw new Error(`The Context Steward is not seeded here: npm run seed:context-steward -w @ai-hub/db`);
  stewardWasEnabled = steward.enabled;
  if (!steward.enabled) await sql`update agents set enabled = true where id = ${steward.id}`;
  await db.upsertPrincipal({ id: PERSON.id, roles: PERSON.roles, displayName: "Verify hand-off", email: null });
  const agent = await db.createAgent({ slug: `verify-handoff-secretary-${stamp}`, name: "Verify Secretary", instructions: "You are a stand-in Secretary.", mcpServers: [] });
  made.push(agent.id);
  const meeting = await db.createSkill({ agentId: agent.id, slug: HANDOFF_SKILL, name: "Verify meeting to PM", promptTemplate: "A meeting took place on {{meetingDate}}. Turn it into a change set.", parameters: [{ name: "meetingDate", description: "when", required: true }] });
  const plain = await db.createSkill({ agentId: agent.id, slug: PLAIN_SKILL, name: "Verify plain", promptTemplate: "What is on today?" });
  const row = await db.createHandoff({ fromAgentId: agent.id, skillId: meeting.id, toAgentId: steward.id, prompt: seeds.STEWARD_HANDOFF_PROMPT, note: seeds.STEWARD_HANDOFF_NOTE });

  const run = (over = {}) => ({ sessionId: "11111111-2222-3333-4444-555555555555", agentId: agent.id, agentName: "Verify Secretary", skillId: meeting.id, skillName: "Verify meeting to PM", prompt: "p", output: "the answer", principal: PERSON, depth: 0, ...over });
  const seen = [];
  const started = await handoffs.runHandoffs(run(), async (agentRef, p, principal, parent) => { seen.push({ agentRef, p, principal, parent }); return { kind: "running", runId: "deadbeef-0000" }; });
  check("it starts the next agent by slug, as the same principal, one deeper, with the filled prompt", seen[0]?.agentRef === seeds.STEWARD_SLUG && seen[0]?.principal === PERSON && seen[0]?.parent.depth === 1 && seen[0]?.parent.sessionId === run().sessionId && /session 11111111-2222-3333-4444-555555555555/.test(seen[0]?.p ?? ""));
  check("and returns the line the answer ends with: the agent, the run in full, and what it does", /_Handed to Context Steward \(run deadbeef-0000\): it reads this meeting/.test(started) && /\/approvals\._$/.test(started.trim()), started.trim().slice(0, 90));
  const refused = await handoffs.runHandoffs(run(), async () => ({ kind: "error", message: "You are not permitted to run agents." }));
  check("a refusal to start is said in the answer, with the reason", /\*\*Not handed to Context Steward:\*\* You are not permitted to run agents\./.test(refused));
  const threw = await handoffs.runHandoffs(run(), async () => { throw new Error("boom"); });
  check("a starter that throws is said too, never thrown back into the run", /\*\*Not handed to Context Steward:\*\* boom/.test(threw));
  const deep = await handoffs.runHandoffs(run({ depth: 2 }), async () => { throw new Error("must not start"); });
  check("a run already two deep hands nothing on, and says why", /\*\*Not handed to Context Steward:\*\* this run is already 2 hand-offs deep/.test(deep), deep.trim());
  check("a run of another skill of the agent fires none", (await handoffs.runHandoffs(run({ skillId: plain.id }), async () => { throw new Error("must not start"); })) === "");

  // --- 1. the real run path ---------------------------------------------------
  console.log("\n— a run from a skill with a hand-off row —");
  const before = calls.length;
  const out = await runSkillForPrincipal({ skillRef: meeting.id, args: { meetingDate: "2026-10-30" }, principal: PERSON, deadlineMs: 60_000 });
  check("the Secretary's run finishes as done", out.kind === "done", out.kind === "error" ? out.message : out.kind);
  const line = /_Handed to Context Steward \(run ([0-9a-f-]{36})\): it reads this meeting and proposes[^_]*\/approvals\._$/.exec(out.output ?? "");
  check("its answer ends by saying the steward has it, naming the run", Boolean(line), (out.output ?? "").slice(-120));
  const rows = await untilDone(stewardSessions);
  const sRun = rows[0];
  check("one steward run was started", rows.length === 1, `${rows.length}`);
  check("as the same person, one deep, under the Secretary's run", sRun?.principalId === PERSON.id && sRun?.depth === 1 && sRun?.parent === out.runId);
  check("not as a skill run of its own", sRun?.skillId === null);
  check("its id is the one the answer named", Boolean(line) && sRun?.id === line[1]);
  check("pointed at the Secretary's session, by id, with the skill's name", /^Hand-off:/.test(sRun?.prompt ?? "") && sRun?.prompt.includes(`session ${out.runId}`) && sRun?.prompt.includes('"Verify meeting to PM"') && sRun?.prompt.includes("Verify Secretary"));
  check("and it finished", sRun?.status === "succeeded", sRun?.status);
  const stewardCall = calls.slice(before).find((c) => /^Hand-off:/.test(c.prompt));
  check("the model was called for the steward with the steward's own brief", Boolean(stewardCall) && stewardCall.system.includes((steward.instructions ?? "").trim()));
  check("when the steward ran, the Secretary's session was already recorded with its transcript", stewardCall?.handedSession?.status === "succeeded" && Number(stewardCall?.handedSession?.turns) >= 2, JSON.stringify(stewardCall?.handedSession && { status: stewardCall.handedSession.status, turns: stewardCall.handedSession.turns }));
  const [stored] = await sql`select output, status from agent_sessions where id = ${out.runId}`;
  check("the stored answer carries the hand-off line, as the returned one does", stored?.status === "succeeded" && /_Handed to Context Steward \(run/.test(stored?.output ?? "") && stored.output === out.output);

  // --- 2. a skill with no row --------------------------------------------------
  console.log("\n— a run from a skill with no hand-off —");
  const plainOut = await runSkillForPrincipal({ skillRef: plain.id, args: {}, principal: PERSON, deadlineMs: 60_000 });
  check("finishes without a hand-off line", plainOut.kind === "done" && !/Context Steward/.test(plainOut.output ?? ""), plainOut.kind === "error" ? plainOut.message : "");
  await settle();
  check("and starts no steward run", (await stewardSessions()).length === 1);

  // --- 3. the steward switched off / the row switched off ---------------------
  console.log("\n— switched off —");
  await sql`update agents set enabled = false where id = ${steward.id}`;
  const offOut = await runSkillForPrincipal({ skillRef: meeting.id, args: { meetingDate: "2026-10-31" }, principal: PERSON, deadlineMs: 60_000 });
  check("the Secretary's run still finishes", offOut.kind === "done", offOut.kind === "error" ? offOut.message : "");
  check("and its answer says the steward was not handed the meeting, and why", /\*\*Not handed to Context Steward:\*\* it is switched off\./.test(offOut.output ?? ""), (offOut.output ?? "").slice(-80));
  await settle();
  check("no steward run was started", (await stewardSessions()).length === 1);
  await sql`update agents set enabled = true where id = ${steward.id}`;
  await db.setHandoffEnabled(row.id, false);
  const rowOff = await runSkillForPrincipal({ skillRef: meeting.id, args: { meetingDate: "2026-10-31" }, principal: PERSON, deadlineMs: 60_000 });
  await settle();
  check("a hand-off row a person switched off fires nothing, silently (it is not a refusal)", rowOff.kind === "done" && !/Context Steward/.test(rowOff.output ?? "") && (await stewardSessions()).length === 1);

  // --- 4. any-run hand-offs carry the answer, and a loop stops ----------------
  console.log("\n— a chain of two that hand to each other —");
  const b = await db.createAgent({ slug: `verify-handoff-b-${stamp}`, name: "Chain B", instructions: "CHAIN-B", mcpServers: [] });
  const c = await db.createAgent({ slug: `verify-handoff-c-${stamp}`, name: "Chain C", instructions: "CHAIN-C", mcpServers: [] });
  made.push(b.id, c.id);
  await db.createHandoff({ fromAgentId: b.id, toAgentId: c.id, prompt: "From {{agentName}}, who was asked: {{prompt}}\n\nIt said:\n{{output}}", note: "it checks B's count" });
  await db.createHandoff({ fromAgentId: c.id, toAgentId: b.id, prompt: "Back from C: {{output}}" });
  const bOut = await runAgentForPrincipal({ agentRef: b.slug, prompt: "Count the beans.", principal: PERSON, deadlineMs: 60_000 });
  const chain = await untilDone(() => sql`select s.id, s.status, s.prompt, s.depth, s.output, a.slug from agent_sessions s join agents a on a.id = s.agent_id where s.principal_id = ${PERSON.id} and a.id in (${b.id}, ${c.id}) order by s.created_at`);
  check("B's run hands to C with B's answer and B's prompt filled in", chain[1]?.slug === c.slug && chain[1].depth === 1 && /From Chain B, who was asked: Count the beans\./.test(chain[1].prompt) && /B's answer: the beans are counted\./.test(chain[1].prompt), chain[1]?.prompt.slice(0, 80));
  check("C's run hands back to B, two deep", chain[2]?.slug === b.slug && chain[2].depth === 2 && /Back from C: C's answer\./.test(chain[2].prompt));
  check("and B, two deep, hands nowhere: three runs, not forever, the refusal said in its answer", chain.length === 3 && chain.every((s) => s.status === "succeeded") && /\*\*Not handed to Chain C:\*\* this run is already 2 hand-offs deep/.test(chain[2].output ?? ""), `${chain.length} runs`);
  check("B's first answer names C's run and what C does", /_Handed to Chain C \(run [0-9a-f-]{36}\): it checks B's count\._/.test(bOut.output ?? ""));
} finally {
  if (stewardWasEnabled !== undefined) await sql`update agents set enabled = ${stewardWasEnabled} where slug = ${seeds.STEWARD_SLUG}`;
  await sql`delete from agent_sessions where principal_id = ${PERSON.id}`;
  for (const id of made) await db.deleteAgent(id).catch(() => {});
  await sql`delete from principals where id = ${PERSON.id}`;
  await sql.end({ timeout: 5 });
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) {
  console.log("Failed:");
  for (const f of failed) console.log(`  - ${f.label}`);
  process.exit(1);
}
console.log("Not proven here: what the steward proposes from a real meeting — the model's judgement, read in /approvals.");
