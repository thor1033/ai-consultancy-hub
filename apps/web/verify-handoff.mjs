// The hand-off from the Secretary to the Context Steward (docs/context-steward.md,
// "The hand-off"), driven through the shipping run path against a real database:
//
//   node --experimental-transform-types --env-file=.env.local verify-handoff.mjs
//
// Needs DATABASE_URL, a migrated database and the Context Steward seeded
// (`npm run seed:context-steward -w @ai-hub/db`). No API key and no spend: a
// throwaway HTTP server stands in for the Messages API and streams a text
// answer to every call. Remote MCP servers are switched off — this must not
// reach the live PM-tool.
//
// What is proven: that a run from a hand-off skill ends with a steward run AS
// THE SAME PERSON, pointed at that session, started only once the session is
// recorded with its transcript (the steward reads it); that the answer says so,
// in the run's stored output as well as the returned one; that a skill not on
// the list hands nothing off; that a switched-off steward is reported, not
// silently skipped; and that the real Secretary's two meeting skills are the
// ones on the list.
//
// What it cannot prove: what the steward proposes. The fake model answers
// with text, so the steward's reading of the session and its proposals are
// the model's doing, read in /approvals.
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
// Every call is kept with the system prompt and the last user message, so the
// script can tell the Secretary's run from the steward's. On the steward's
// call it also reads, there and then, the state of the session the hand-off
// names: that is the moment the steward would read it.
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
  writeStream(res, [{ type: "text", text: "Noted. Nothing to propose from this." }], "end_turn");
});

function writeStream(res, blocks, stopReason) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({
    type: "message_start",
    message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } },
  });
  blocks.forEach((block, index) => {
    send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    send({ type: "content_block_stop", index });
  });
  send({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  res.end();
}
await new Promise((r) => http.listen(0, "127.0.0.1", r));

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
process.env.HUB_REMOTE_MCP_SERVERS = "";
delete process.env.LANGFUSE_PUBLIC_KEY;
// The throwaway skill is the one that hands off, so the real Secretary and its
// skills are not needed here, and a run of them is never started by accident.
process.env.HUB_STEWARD_HANDOFF_SKILLS = HANDOFF_SKILL;

const db = await import("../../packages/db/src/index.ts");
const seeds = await import("../../packages/db/src/seeds/context-steward.ts");
const secretary = await import("../../packages/db/src/seeds/secretary.ts");
const handoff = await import("./src/lib/stewardHandoff.ts");
const { runSkillForPrincipal } = await import("./src/lib/agentRuns.ts");
sql = db.getSql();

const PERSON = { id: `verify-handoff-person-${stamp}`, roles: ["analyst"], source: "credential" };
let agentId;
let stewardWasEnabled;

async function stewardSessions() {
  return sql`
    select s.id, s.status, s.prompt, s.principal_id as "principalId", s.agent_skill_id as "skillId", s.output
      from agent_sessions s join agents a on a.id = s.agent_id
     where a.slug = ${seeds.STEWARD_SLUG} and s.principal_id = ${PERSON.id}
     order by s.created_at`;
}
async function untilFinished(predicate, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rows = await stewardSessions();
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  return stewardSessions();
}

try {
  // --- 0. the rule, as pure functions --------------------------------------
  console.log("— the rule —");
  const secretarySlugs = secretary.SECRETARY_SKILLS.map((s) => s.slug);
  check(
    "the seed's list is the Secretary's two meeting skills",
    seeds.STEWARD_HANDOFF_SKILLS.length === 2 && seeds.STEWARD_HANDOFF_SKILLS.every((s) => secretarySlugs.includes(s)),
    seeds.STEWARD_HANDOFF_SKILLS.join(", "),
  );
  check("and those two skills tell the Secretary the hub hands the meeting on", secretary.SECRETARY_SKILLS.filter((s) => seeds.STEWARD_HANDOFF_SKILLS.includes(s.slug)).every((s) => /hands (the meeting|it) to the\s+Context Steward/.test(s.promptTemplate)));
  check("the steward's brief has the hand-off section", /## A hand-off/.test(seeds.CONTEXT_STEWARD_AGENT.instructions) && /Do not sweep/.test(seeds.CONTEXT_STEWARD_AGENT.instructions));
  const saved = process.env.HUB_STEWARD_HANDOFF_SKILLS;
  delete process.env.HUB_STEWARD_HANDOFF_SKILLS;
  check("with nothing set, the list is the seed's", JSON.stringify(handoff.handoffSkills()) === JSON.stringify(seeds.STEWARD_HANDOFF_SKILLS));
  process.env.HUB_STEWARD_HANDOFF_SKILLS = "";
  check("an empty HUB_STEWARD_HANDOFF_SKILLS turns the hand-off off", handoff.handoffSkills().length === 0 && !handoff.wantsHandoff("meeting-to-pm", "secretary"));
  process.env.HUB_STEWARD_HANDOFF_SKILLS = " a , b ,, ";
  check("a deployment's list is read with its spaces and blanks dropped", JSON.stringify(handoff.handoffSkills()) === JSON.stringify(["a", "b"]));
  process.env.HUB_STEWARD_HANDOFF_SKILLS = saved;
  check("the steward's own runs are never handed to itself", !handoff.wantsHandoff(HANDOFF_SKILL, seeds.STEWARD_SLUG) && handoff.wantsHandoff(HANDOFF_SKILL, "secretary"));
  const prompt = seeds.stewardHandoffPrompt({ sessionId: "abc", skillName: "Meeting to PM", agentName: "Secretary" });
  check("the hand-off prompt names the session, the skill and the agent, and says not to sweep", /session abc/.test(prompt) && /"Meeting to PM"/.test(prompt) && /Secretary/.test(prompt) && /Do not sweep/.test(prompt));

  console.log("\n— handOffToSteward, with a stand-in starter —");
  const seen = [];
  const started = await handoff.handOffToSteward(
    { skill: { slug: "x", name: "X" }, sessionId: "11111111-2222", agentSlug: "secretary", agentName: "Secretary", principal: PERSON },
    async (agentRef, p, principal) => { seen.push({ agentRef, p, principal }); return { kind: "running", runId: "deadbeef-0000" }; },
  );
  check("it starts the steward by slug, as the same principal, with the hand-off prompt", seen[0]?.agentRef === seeds.STEWARD_SLUG && seen[0]?.principal === PERSON && /session 11111111-2222/.test(seen[0]?.p ?? ""));
  check("and returns the line the answer ends with, naming the run in full, so it can be looked up", /_Handed to the Context Steward \(run deadbeef-0000\)/.test(started) && /\/approvals/.test(started), started.trim().slice(0, 80));
  const refused = await handoff.handOffToSteward(
    { skill: { slug: "x", name: "X" }, sessionId: "s", agentSlug: "secretary", agentName: "Secretary", principal: PERSON },
    async () => ({ kind: "error", message: "You are not permitted to run agents." }),
  );
  check("a refusal to start is said in the answer, with the reason", /\*\*Not handed to the Context Steward:\*\* You are not permitted to run agents\./.test(refused));
  const threw = await handoff.handOffToSteward(
    { skill: { slug: "x", name: "X" }, sessionId: "s", agentSlug: "secretary", agentName: "Secretary", principal: PERSON },
    async () => { throw new Error("boom"); },
  );
  check("a starter that throws is said too, never thrown back into the run", /\*\*Not handed to the Context Steward:\*\* boom/.test(threw));

  // --- 1. the real run path ---------------------------------------------------
  console.log("\n— a run from a hand-off skill —");
  const steward = await db.getAgent(seeds.STEWARD_SLUG);
  if (!steward) throw new Error(`The Context Steward is not seeded here: npm run seed:context-steward -w @ai-hub/db`);
  stewardWasEnabled = steward.enabled;
  if (!steward.enabled) await sql`update agents set enabled = true where id = ${steward.id}`;

  await db.upsertPrincipal({ id: PERSON.id, roles: PERSON.roles, displayName: "Verify hand-off", email: null });
  const agent = await db.createAgent({ slug: `verify-handoff-secretary-${stamp}`, name: "Verify Secretary", instructions: "You are a stand-in Secretary.", mcpServers: [] });
  agentId = agent.id;
  const meeting = await db.createSkill({ agentId, slug: HANDOFF_SKILL, name: "Verify meeting to PM", promptTemplate: "A meeting took place on {{meetingDate}}. Turn it into a change set.", parameters: [{ name: "meetingDate", description: "when", required: true }] });
  const plain = await db.createSkill({ agentId, slug: PLAIN_SKILL, name: "Verify plain", promptTemplate: "What is on today?" });

  const before = calls.length;
  const out = await runSkillForPrincipal({ skillRef: meeting.id, args: { meetingDate: "2026-10-30" }, principal: PERSON, deadlineMs: 60_000 });
  check("the Secretary's run finishes as done", out.kind === "done", out.kind === "error" ? out.message : out.kind);
  const line = /_Handed to the Context Steward \(run ([0-9a-f-]{36})\): it reads this meeting and proposes[^_]*\/approvals\._$/.exec(out.output ?? "");
  check("its answer ends by saying the steward has it, naming the run", Boolean(line), (out.output ?? "").slice(-120));

  const rows = await untilFinished((r) => r.length >= 1 && r.every((s) => s.status !== "running"));
  const sRun = rows[0];
  check("one steward run was started", rows.length === 1, `${rows.length}`);
  check("as the same person", sRun?.principalId === PERSON.id);
  check("not as a skill run of its own", sRun?.skillId === null);
  check("its id is the one the answer named", Boolean(line) && sRun?.id === line[1]);
  check("pointed at the Secretary's session, by id, with the skill's name", /^Hand-off:/.test(sRun?.prompt ?? "") && sRun?.prompt.includes(`session ${out.runId}`) && sRun?.prompt.includes('"Verify meeting to PM"') && sRun?.prompt.includes("Verify Secretary"));
  check("and it finished", sRun?.status === "succeeded", sRun?.status);

  const stewardCall = calls.slice(before).find((c) => /^Hand-off:/.test(c.prompt));
  // The system prompt the loop sends is the brief plus what the hub adds around
  // it (the date, the memory's standing note), so the brief is looked for in it.
  check("the model was called for the steward with the steward's own brief", Boolean(stewardCall) && stewardCall.system.includes((steward.instructions ?? "").trim()), `system ${stewardCall?.system.length} chars, brief ${steward.instructions?.length}`);
  check(
    "when the steward ran, the Secretary's session was already recorded with its transcript",
    stewardCall?.handedSession?.status === "succeeded" && Number(stewardCall?.handedSession?.turns) >= 2,
    JSON.stringify(stewardCall?.handedSession && { status: stewardCall.handedSession.status, turns: stewardCall.handedSession.turns }),
  );
  const [stored] = await sql`select output, status from agent_sessions where id = ${out.runId}`;
  check("the stored answer carries the hand-off line, as the returned one does", stored?.status === "succeeded" && /_Handed to the Context Steward \(run/.test(stored?.output ?? "") && stored.output === out.output);

  // --- 2. a skill not on the list --------------------------------------------
  console.log("\n— a run from any other skill —");
  const plainOut = await runSkillForPrincipal({ skillRef: plain.id, args: {}, principal: PERSON, deadlineMs: 60_000 });
  check("finishes without a hand-off line", plainOut.kind === "done" && !/Context Steward/.test(plainOut.output ?? ""), plainOut.kind === "error" ? plainOut.message : "");
  await new Promise((r) => setTimeout(r, 500));
  check("and starts no steward run", (await stewardSessions()).length === 1);

  // --- 3. the steward switched off -------------------------------------------
  console.log("\n— the steward switched off —");
  await sql`update agents set enabled = false where id = ${steward.id}`;
  const offOut = await runSkillForPrincipal({ skillRef: meeting.id, args: { meetingDate: "2026-10-31" }, principal: PERSON, deadlineMs: 60_000 });
  check("the Secretary's run still finishes", offOut.kind === "done", offOut.kind === "error" ? offOut.message : "");
  check("and its answer says the steward was not handed the meeting, and why", /\*\*Not handed to the Context Steward:\*\* it is switched off\./.test(offOut.output ?? ""), (offOut.output ?? "").slice(-80));
  await new Promise((r) => setTimeout(r, 500));
  check("no steward run was started", (await stewardSessions()).length === 1);
  await sql`update agents set enabled = true where id = ${steward.id}`;
} finally {
  // Leave nothing behind, and the steward as it was.
  if (stewardWasEnabled !== undefined) await sql`update agents set enabled = ${stewardWasEnabled} where slug = ${seeds.STEWARD_SLUG}`;
  await sql`delete from agent_sessions where principal_id = ${PERSON.id}`;
  if (agentId) await db.deleteAgent(agentId);
  await sql`delete from principals where id = ${PERSON.id}`;
  await sql.end({ timeout: 5 });
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) {
  console.log("Failed:");
  for (const c of failed) console.log(`  - ${c.label}`);
  process.exit(1);
}
console.log("Not proven here: what the steward proposes from a real meeting — the model's judgement, read in /approvals.");
