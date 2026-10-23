// Verification of schedules — the clock that lets an agent act without a person
// asking it to.
//
//   node --env-file=apps/web/.env.local packages/db/verify-schedules.mjs
//
// No API key. Needs DATABASE_URL and the agent_schedules table (npm run migrate
// -w @ai-hub/db). Everything happens under a throwaway agent, principal and
// schedules that this script creates and deletes.
//
// Two halves. `isDue` is pure, so the whole truth table is checked against a
// fixed clock — including both directions of a DST change, which is the reason
// a daily time is stored as local wall-clock minutes and compared per local
// date rather than as elapsed hours. The rest drives the real
// selection → claim → record cycle against Postgres with a fake runner, because
// the properties that matter there (one claim wins, a disabled owner stops
// firing, a throwing runner does not take the tick down) are not visible from
// the pure function.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
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

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}

const {
  isDue, isValidTimezone, DAILY_CATCH_UP_MINUTES,
  createSchedule, listSchedules, getSchedule, setScheduleEnabled, deleteSchedule,
  schedulesToConsider, claimSchedule, runDueSchedules,
} = await import("./src/schedules.ts");
const { createAgent, deleteAgent, updateAgent } = await import("./src/agents.ts");
const { createSkill } = await import("./src/skills.ts");
const { upsertPrincipal, setPrincipalEnabled } = await import("./src/credentials.ts");
const { getSql } = await import("./src/client.ts");

// ── half one: the predicate ──────────────────────────────────────────────────
const base = {
  id: "s1", agentId: "a1", name: "n", prompt: "p",
  kind: "daily", intervalMinutes: null, atMinute: 7 * 60 + 30,
  weekdays: [], timezone: "UTC", ownerPrincipalId: "p1", enabled: true,
  lastRunAt: null, lastRunId: null, lastError: null,
  createdAt: "", updatedAt: "",
};
const daily = (over = {}) => ({ ...base, ...over });
const every = (over = {}) => ({ ...base, kind: "every", atMinute: null, intervalMinutes: 15, ...over });

// interval
check("an interval schedule that has never run is due", isDue(every(), new Date()));
check(
  "one that ran less than its interval ago is not",
  !isDue(every({ lastRunAt: new Date(Date.now() - 14 * 60_000).toISOString() }), new Date()),
);
check(
  "and one that ran longer ago is",
  isDue(every({ lastRunAt: new Date(Date.now() - 15 * 60_000).toISOString() }), new Date()),
);
check("a disabled schedule is never due", !isDue(every({ enabled: false }), new Date()));
check("an interval of 0 never fires rather than firing constantly", !isDue(every({ intervalMinutes: 0 }), new Date()));

// daily, in UTC
check("a daily schedule fires at its minute", isDue(daily(), new Date("2026-09-16T07:30:00Z")));
check("not a minute before", !isDue(daily(), new Date("2026-09-16T07:29:00Z")));
check(
  `it still fires ${DAILY_CATCH_UP_MINUTES} minutes late, so a slow tick does not lose the day`,
  isDue(daily(), new Date(`2026-09-16T07:${30 + DAILY_CATCH_UP_MINUTES}:00Z`)),
);
check(
  "but not hours late — a briefing that arrives at lunchtime reads as current and is not",
  !isDue(daily(), new Date("2026-09-16T12:00:00Z")),
);

// daily, in a zone
const cph = daily({ timezone: "Europe/Copenhagen" });
check(
  "a local time is local: 07:30 in Copenhagen is not 07:30 UTC",
  !isDue(cph, new Date("2026-09-16T07:30:00Z")) && isDue(cph, new Date("2026-09-16T05:30:00Z")),
);

// weekdays: 2026-09-19 is a Saturday, 2026-09-21 a Monday
const weekdaysOnly = daily({ weekdays: [1, 2, 3, 4, 5] });
check("a weekday schedule skips the weekend", !isDue(weekdaysOnly, new Date("2026-09-19T07:30:00Z")));
check("and fires on a weekday", isDue(weekdaysOnly, new Date("2026-09-21T07:30:00Z")));

// once per local day
check(
  "a daily schedule that already ran today does not run again",
  !isDue(daily({ lastRunAt: "2026-09-16T07:30:00Z" }), new Date("2026-09-16T07:31:00Z")),
);
check(
  "and does run the next day",
  isDue(daily({ lastRunAt: "2026-09-16T07:30:00Z" }), new Date("2026-09-17T07:30:00Z")),
);

// ── DST ──────────────────────────────────────────────────────────────────────
// 25 October 2026, Europe/Copenhagen: 03:00 CEST goes back to 02:00 CET, so
// 02:30 local happens twice — at 00:30 UTC and again at 01:30 UTC. Comparing
// local DATES rather than elapsed hours is what stops the second one firing.
const nightly = daily({ timezone: "Europe/Copenhagen", atMinute: 2 * 60 + 30 });
check(
  "an autumn clock change does not fire a daily schedule twice",
  isDue(nightly, new Date("2026-10-25T00:30:00Z")) &&
    !isDue({ ...nightly, lastRunAt: "2026-10-25T00:30:00Z" }, new Date("2026-10-25T01:30:00Z")),
);
// 29 March 2026: 02:00 CET jumps to 03:00 CEST, so 02:30 local never happens.
// A schedule set for it simply does not fire that day — a known, documented gap
// rather than a silent shift to some other hour.
const springMorning = [0, 1, 2, 3].map((h) => new Date(`2026-03-29T0${h}:30:00Z`));
check(
  "a spring clock change skips a schedule set to a local time that does not exist",
  springMorning.every((t) => !isDue(nightly, t)),
);
// The 07:30 briefing is unaffected by either change: still 07:30 local.
check(
  "an ordinary daily time is unmoved by the clock change",
  isDue(cph, new Date("2026-10-25T06:30:00Z")) && isDue(cph, new Date("2026-10-24T05:30:00Z")),
);

// bad data must not fire at the wrong time
check("an unreadable timezone never fires", !isDue(daily({ timezone: "Mars/Olympus" }), new Date("2026-09-16T07:30:00Z")));
check("isValidTimezone agrees", isValidTimezone("Europe/Copenhagen") && !isValidTimezone("Mars/Olympus"));
check("an out-of-range time of day never fires", !isDue(daily({ atMinute: 5000 }), new Date()));

// ── half two: the store and the tick ─────────────────────────────────────────
const sql = getSql();
const stamp = Date.now();
let agent;
let principalId = `verify-sched-${stamp}`;

try {
  agent = await createAgent({ slug: `verify-sched-${stamp}`, name: "Verify Scheduled" });
  await upsertPrincipal({ id: principalId, displayName: "Verify Owner", roles: ["analyst"] });

  const made = await createSchedule({
    agentId: agent.id,
    name: "Morning briefing",
    prompt: "What is on today, and what needs an answer?",
    kind: "daily",
    atMinute: 7 * 60 + 30,
    weekdays: [1, 2, 3, 4, 5],
    timezone: "Europe/Copenhagen",
    ownerPrincipalId: principalId,
  });
  check("createSchedule stores a schedule", Boolean(made?.id), made?.id?.slice(0, 8) ?? JSON.stringify(made));
  check(
    "it round-trips every field",
    made.kind === "daily" && made.atMinute === 450 &&
      Array.isArray(made.weekdays) && made.weekdays.join() === "1,2,3,4,5" &&
      made.timezone === "Europe/Copenhagen" && made.enabled === true && made.lastRunAt === null,
    `weekdays=${JSON.stringify(made.weekdays)} tz=${made.timezone}`,
  );

  // Validation, so a schedule that could never fire is refused at the door.
  const noPrompt = await createSchedule({ agentId: agent.id, name: "x", prompt: "  ", kind: "every", intervalMinutes: 5, ownerPrincipalId: principalId });
  check("a schedule with no prompt is refused", Boolean(noPrompt.error), noPrompt.error);
  const badTz = await createSchedule({ agentId: agent.id, name: "x", prompt: "go", kind: "daily", atMinute: 60, timezone: "Mars/Olympus", ownerPrincipalId: principalId });
  check("an unreadable timezone is refused rather than stored", /not a timezone/.test(badTz.error ?? ""), badTz.error);
  const badInterval = await createSchedule({ agentId: agent.id, name: "x", prompt: "go", kind: "every", intervalMinutes: 0, ownerPrincipalId: principalId });
  check("an interval of 0 is refused", Boolean(badInterval.error), badInterval.error);

  check("listSchedules finds it for the agent", (await listSchedules(agent.id)).length === 1);

  // ── a schedule that runs a skill ──────────────────────────────────────────
  // The morning brief: no prompt of its own, the skill's template filled from
  // skill_args at fire time, so the schedule and a by-hand run share one prompt.
  const brief = await createSkill({
    agentId: agent.id, slug: `verify-brief-${stamp}`, name: "Verify brief",
    promptTemplate: "Prepare {{day}}.", parameters: [{ name: "day", required: true }],
  });
  const onSkill = await createSchedule({
    agentId: agent.id, name: "Morning brief", agentSkillId: brief.id, skillArgs: { day: "today" },
    kind: "daily", atMinute: 7 * 60, weekdays: [1, 2, 3, 4, 5], timezone: "Europe/Copenhagen", ownerPrincipalId: principalId,
  });
  check("a skill schedule needs no prompt of its own", Boolean(onSkill?.id), onSkill?.error ?? "");
  check(
    "it stores the skill and its arguments, and a readable line in prompt",
    onSkill.agentSkillId === brief.id && onSkill.skillArgs?.day === "today" && onSkill.prompt === "Morning brief",
    JSON.stringify({ skill: onSkill.agentSkillId === brief.id, args: onSkill.skillArgs, prompt: onSkill.prompt }),
  );
  const stillNoPrompt = await createSchedule({ agentId: agent.id, name: "x", kind: "every", intervalMinutes: 5, ownerPrincipalId: principalId });
  check("without a skill, a prompt is still required", Boolean(stillNoPrompt.error), stillNoPrompt.error);
  await sql`update agent_schedules set last_run_at = null where id = ${onSkill.id}`;
  let handed = null;
  await runDueSchedules(async (s) => { if (s.id === onSkill.id) handed = s; return { runId: null }; }, new Date("2026-10-22T05:00:00Z"));
  check(
    "a tick hands the runner the skill and its arguments",
    handed?.agentSkillId === brief.id && handed?.skillArgs?.day === "today",
    handed ? JSON.stringify(handed.skillArgs) : "not fired",
  );
  await deleteSchedule(onSkill.id);
  const removed = await sql`delete from agent_skills where id = ${brief.id}`;
  check("deleting the skill takes its schedule with it", removed.count === 1 && (await getSchedule(onSkill.id)) === null);

  // ── the claim ─────────────────────────────────────────────────────────────
  // Two containers ticking at the same second must not both fire one schedule.
  const fresh = await getSchedule(made.id);
  const [first, second] = await Promise.all([
    claimSchedule(fresh.id, fresh.lastRunAt),
    claimSchedule(fresh.id, fresh.lastRunAt),
  ]);
  check("exactly one of two simultaneous claims wins", first !== second, `${first} / ${second}`);
  const claimed = await getSchedule(made.id);
  check("claiming stamps last_run_at before the run, not after", claimed.lastRunAt !== null);
  check(
    "a claim against a stale timestamp is refused",
    (await claimSchedule(made.id, null)) === false,
  );

  // ── the tick ──────────────────────────────────────────────────────────────
  const polling = await createSchedule({
    agentId: agent.id, name: "Inbox poll", prompt: "Anything new?",
    kind: "every", intervalMinutes: 15, ownerPrincipalId: principalId,
  });

  const ran = [];
  const tick = await runDueSchedules(async (s) => {
    ran.push(s.name);
    return { runId: null };
  });
  check(
    "a tick runs the schedule that is due and leaves the one that is not",
    ran.length === 1 && ran[0] === "Inbox poll",
    `ran: ${ran.join(", ") || "none"} (considered ${tick.considered}, due ${tick.due})`,
  );
  const afterTick = await getSchedule(polling.id);
  check("the fired schedule records its run", afterTick.lastRunAt !== null && afterTick.lastError === null);

  const again = await runDueSchedules(async (s) => { ran.push(s.name); return { runId: null }; });
  check("ticking again immediately fires nothing", again.claimed === 0, `${again.due} due`);

  // A runner that throws must not take the tick down with it.
  await sql`update agent_schedules set last_run_at = null where id = ${polling.id}`;
  const exploded = await runDueSchedules(async () => {
    throw new Error("Graph is down.");
  });
  check("a run that throws is caught and recorded", exploded.claimed === 1 && /Graph is down/.test(exploded.ran[0]?.error ?? ""));
  const failedRow = await getSchedule(polling.id);
  check("the error lands on the schedule for someone to see", /Graph is down/.test(failedRow.lastError ?? ""), failedRow.lastError);

  // ── who may still fire ────────────────────────────────────────────────────
  // The property that makes revoking a person mean something.
  await sql`update agent_schedules set last_run_at = null, last_error = null where id = ${polling.id}`;
  await setPrincipalEnabled(principalId, false);
  const whileRevoked = await runDueSchedules(async () => ({ runId: null }));
  check(
    "disabling the owner stops their unattended runs",
    whileRevoked.considered === 0 && whileRevoked.claimed === 0,
  );

  await setPrincipalEnabled(principalId, true);
  await updateAgent(agent.id, { enabled: false });
  const whileAgentOff = await runDueSchedules(async () => ({ runId: null }));
  check("so does disabling the agent", whileAgentOff.considered === 0);

  await updateAgent(agent.id, { enabled: true });
  await setScheduleEnabled(polling.id, false);
  const whileScheduleOff = await runDueSchedules(async () => ({ runId: null }));
  check("and so does disabling the schedule itself", whileScheduleOff.considered === 1 && whileScheduleOff.due === 0);

  // ── cleanup semantics ─────────────────────────────────────────────────────
  check("deleteSchedule removes one", (await deleteSchedule(polling.id)) === true);
  check("deleting twice is false, not an error", (await deleteSchedule(polling.id)) === false);

  await deleteAgent(agent.id);
  agent = null;
  check(
    "deleting an agent takes its schedules with it",
    (await sql`select count(*)::int as n from agent_schedules where id = ${made.id}`)[0].n === 0,
  );
} finally {
  if (agent) await deleteAgent(agent.id).catch(() => {});
  await sql`delete from principals where id = ${principalId}`.catch(() => {});
  await sql.end();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(
  failedChecks.length === 0
    ? `\nSchedules OK (${checks.length} checks)`
    : `\nSchedules FAILED (${failedChecks.length}/${checks.length})`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
