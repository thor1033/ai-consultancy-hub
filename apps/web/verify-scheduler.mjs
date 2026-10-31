// Verification of the ticker — the path where nobody asked.
//
//   node --experimental-transform-types apps/web/verify-scheduler.mjs
//
// Needs DATABASE_URL (and a migrated database). No API key and no spend: a
// throwaway HTTP server stands in for the Messages API, and the Anthropic SDK
// is pointed at it. Remote MCP servers are switched off for the same reason —
// this must not reach the live PM-tool.
//
// packages/db/verify-schedules.mjs already covers which schedules are due and
// who may claim one, against a real database. What it cannot see is the glue in
// lib/scheduler.ts: that a scheduled run executes AS the principal who owns the
// schedule, that a run actually lands in agent_sessions, and that an owner who
// may not run agents is refused and recorded rather than quietly skipped. This
// drives the real tick() to check those.
//
// And the chain agents form on the clock: a schedule that fires the Secretary's
// meeting skill ends with the Context Steward run the hub hands it to, both as
// the schedule's owner (needs the Context Steward seeded; that part is skipped,
// and said, when it is not).
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// The workspace TypeScript uses extensionless imports and the `@/` alias, which
// Next resolves and raw Node does not. Harness-only; nothing ships differently.
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
      if (!specifier.startsWith(".") || !context.parentURL) throw err;
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
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const ANSWER = "Two meetings today; the invoice from Accounts needs an answer.";

// The agent loop streams, so the stand-in does too: a plain JSON answer is
// what made this script fail 9 of 13 once runAgent began to stream. Every call
// is kept, so the chain below can tell which agent the model was asked as.
const calls = [];
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const last = body.messages?.at(-1)?.content;
  calls.push({ prompt: typeof last === "string" ? last : (last ?? []).map((b) => b.text ?? "").join("") });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({
    type: "message_start",
    message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } },
  });
  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } });
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
// Not the live PM-tool, and no Langfuse round-trips.
process.env.HUB_REMOTE_MCP_SERVERS = "";
delete process.env.LANGFUSE_PUBLIC_KEY;

const { tick } = await import("./src/lib/scheduler.ts");
const { createAgent, deleteAgent } = await import("../../packages/db/src/agents.ts");
const { upsertPrincipal, setPrincipalEnabled } = await import("../../packages/db/src/credentials.ts");
const { createSchedule, getSchedule } = await import("../../packages/db/src/schedules.ts");
const { createSkill, getAgent } = await import("../../packages/db/src/index.ts");
const { STEWARD_SLUG } = await import("../../packages/db/src/seeds/context-steward.ts");

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const stamp = Date.now();
const owner = `verify-tick-owner-${stamp}`;
const readOnly = `verify-tick-viewer-${stamp}`;
let agent = null;

// A scheduled run is raced against a short deadline and finishes its own row,
// so the row is read once it has left "running", not at the moment tick returns.
async function finished(id, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const [row] = await sql`
      select prompt, output, status, agent_id as "agentId", principal_id as "principalId"
      from agent_sessions where id = ${id}`;
    if (!row || row.status !== "running" || Date.now() > until) return row;
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  agent = await createAgent({
    slug: `verify-tick-${stamp}`,
    name: "Verify Secretary",
    instructions: "You are a test double.",
  });
  await upsertPrincipal({ id: owner, displayName: "Owner", roles: ["analyst"] });
  await upsertPrincipal({ id: readOnly, displayName: "Viewer", roles: ["viewer"] });

  const schedule = await createSchedule({
    agentId: agent.id,
    name: "Morning briefing",
    prompt: "What is on today?",
    kind: "every",
    intervalMinutes: 15,
    ownerPrincipalId: owner,
  });

  // ── a scheduled run, with nobody asking ──────────────────────────────────
  const outcome = await tick();
  check("a due schedule is claimed and run", outcome.claimed === 1, `considered ${outcome.considered}, due ${outcome.due}`);
  check("the run reports no error", !outcome.ran[0]?.error, outcome.ran[0]?.error ?? "none");

  const runId = outcome.ran[0]?.runId;
  check("the tick hands back a run id", Boolean(runId), runId ?? "null");

  const run = await finished(runId);
  check("the run is recorded in agent_sessions", Boolean(run), run?.status);
  check("it carries the schedule's prompt", run?.prompt === "What is on today?", run?.prompt);
  check("and the agent's answer", run?.output === ANSWER, run?.output?.slice(0, 50));
  check("it is attributed to the agent", run?.agentId === agent.id);

  // The property the whole design turns on: an unattended run has no caller, so
  // it borrows the reach of the person who scheduled it rather than having a
  // reach of its own.
  check("the run executes as the principal who owns the schedule", run?.principalId === owner, run?.principalId);

  const afterRun = await getSchedule(schedule.id);
  check("the schedule points at its last run", afterRun.lastRunId === runId && afterRun.lastError === null);

  // ── an owner who may not run agents ──────────────────────────────────────
  await sql`update agent_schedules set owner_principal_id = ${readOnly}, last_run_at = null, last_run_id = null where id = ${schedule.id}`;
  const refused = await tick();
  check("a schedule whose owner may not run agents is refused", refused.claimed === 1 && Boolean(refused.ran[0]?.error), refused.ran[0]?.error);
  const afterRefusal = await getSchedule(schedule.id);
  check(
    "the refusal is recorded on the schedule rather than silently skipped",
    /not permitted/i.test(afterRefusal.lastError ?? ""),
    afterRefusal.lastError,
  );

  const runCount = await sql`select count(*)::int as n from agent_sessions where agent_id = ${agent.id}`;
  check("and no run was made on their behalf", runCount[0].n === 1, `${runCount[0].n} run(s) total`);

  // ── a revoked owner ──────────────────────────────────────────────────────
  await sql`update agent_schedules set owner_principal_id = ${owner}, last_run_at = null, last_error = null where id = ${schedule.id}`;
  await setPrincipalEnabled(owner, false);
  const revoked = await tick();
  // Asked of this schedule, not of the whole table: a database with other
  // people's schedules in it considers those, and that is correct.
  const afterRevoke = await getSchedule(schedule.id);
  check(
    "revoking the owner stops the schedule entirely",
    !revoked.ran.some((r) => r.scheduleId === schedule.id) && afterRevoke.lastRunAt === null,
    `ran ${revoked.ran.length} other schedule(s)`,
  );
  await setPrincipalEnabled(owner, true);
  await sql`update agent_schedules set enabled = false where id = ${schedule.id}`;

  // ── the clock starts a chain: Secretary, then the Context Steward ─────────
  console.log("\n— a meeting skill on the clock, handed to the steward —");
  const steward = await getAgent(STEWARD_SLUG);
  if (!steward || !steward.enabled) {
    console.log(`skip  the Context Steward is ${steward ? "switched off" : "not seeded"} here — npm run seed:context-steward -w @ai-hub/db`);
  } else {
    const meetingSkill = `verify-tick-meeting-${stamp}`;
    process.env.HUB_STEWARD_HANDOFF_SKILLS = meetingSkill;
    const skill = await createSkill({ agentId: agent.id, slug: meetingSkill, name: "Verify meeting follow-up", promptTemplate: "Follow up the meetings that finished in the last {{lookbackHours}} hours." , parameters: [{ name: "lookbackHours", description: "hours", required: false }] });
    const followup = await createSchedule({
      agentId: agent.id,
      name: "Meeting follow-up",
      agentSkillId: skill.id,
      skillArgs: { lookbackHours: "3" },
      kind: "every",
      intervalMinutes: 60,
      ownerPrincipalId: owner,
    });
    const before = calls.length;
    const chained = await tick();
    const secRunId = chained.ran.find((r) => r.scheduleId === followup.id)?.runId ?? chained.ran[0]?.runId;
    check("the skill schedule is claimed and run", chained.claimed === 1 && Boolean(secRunId), chained.ran[0]?.error ?? "");
    const secRun = await finished(secRunId);
    check("the Secretary's run fills the skill's template from the schedule's arguments", secRun?.prompt === "Follow up the meetings that finished in the last 3 hours.", secRun?.prompt);
    check("and runs as the schedule's owner", secRun?.principalId === owner);
    check("its answer says it was handed to the Context Steward", /_Handed to the Context Steward \(run [0-9a-f]{8}\)/.test(secRun?.output ?? ""), (secRun?.output ?? "").slice(-90));
    let stewardRun;
    for (const until = Date.now() + 30_000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
      [stewardRun] = await sql`
        select id, status, prompt, principal_id as "principalId" from agent_sessions
         where agent_id = ${steward.id} and principal_id = ${owner} order by created_at desc limit 1`;
      if (stewardRun && stewardRun.status !== "running") break;
    }
    check("the Context Steward ran next, as the same owner — nobody asked either agent", stewardRun?.principalId === owner && stewardRun?.status === "succeeded", stewardRun?.status);
    check("pointed at the Secretary's session", stewardRun?.prompt?.includes(`session ${secRunId}`));
    check("the model was asked twice: once as each agent", calls.length - before === 2 && /^Hand-off:/.test(calls.at(-1)?.prompt ?? ""), `${calls.length - before} call(s)`);
    const again = await tick();
    check("an hourly schedule that just ran is not run again a minute later", again.claimed === 0, `claimed ${again.claimed}`);
    await sql`delete from agent_sessions where principal_id = ${owner} and agent_id = ${steward.id}`;
  }
} finally {
  if (agent) await deleteAgent(agent.id).catch(() => {});
  await sql`delete from principals where id in (${owner}, ${readOnly})`.catch(() => {});
  await sql.end();
  http.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(
  failedChecks.length === 0
    ? `\nScheduler OK (${checks.length} checks)`
    : `\nScheduler FAILED (${failedChecks.length}/${checks.length})`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
