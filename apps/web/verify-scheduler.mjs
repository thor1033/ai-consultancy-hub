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

const http = createServer(async (req, res) => {
  for await (const _ of req) void _;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "text", text: ANSWER }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  );
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

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const stamp = Date.now();
const owner = `verify-tick-owner-${stamp}`;
const readOnly = `verify-tick-viewer-${stamp}`;
let agent = null;

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

  const [run] = await sql`
    select prompt, output, status, agent_id as "agentId", principal_id as "principalId"
    from agent_sessions where id = ${runId}
  `;
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
  check("revoking the owner stops the schedule entirely", revoked.considered === 0 && revoked.claimed === 0);
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
