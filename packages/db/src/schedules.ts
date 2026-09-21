import { getSql } from "./client";

/*
 * Schedules — the clock the hub did not have.
 *
 * Until now every agent run started with a person: a chat turn, an API call, a
 * tool call from Claude Code. A secretary that only acts when you ask it to is
 * a chat window, so this is the table that lets an agent act on its own.
 *
 * Two shapes cover what people actually ask for, and neither needs a cron
 * parser:
 *
 *   every  run every N minutes — polling something that changes
 *   daily  run at a local wall-clock time, on chosen weekdays — the 07:30
 *          briefing, which must stay at 07:30 across a DST change
 *
 * A schedule belongs to a PRINCIPAL, and its runs execute as that principal.
 * That is not bookkeeping: retrieval is scoped to the caller's grants
 * (agentRuns.ts), and an unattended run has no caller to scope it to. Binding
 * the schedule to its owner means a scheduled briefing reads exactly what the
 * person who scheduled it may read — and disabling that person stops it.
 */

export type ScheduleKind = "every" | "daily";

export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  /** What to ask the agent, every time it fires. */
  prompt: string;
  kind: ScheduleKind;
  /** kind `every`: minutes between runs. */
  intervalMinutes: number | null;
  /** kind `daily`: minutes past local midnight, 0–1439. */
  atMinute: number | null;
  /** kind `daily`: 0=Sunday … 6=Saturday. Empty means every day. */
  weekdays: number[];
  /** IANA zone the daily time is read in. */
  timezone: string;
  ownerPrincipalId: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInput {
  agentId: string;
  name: string;
  prompt: string;
  kind: ScheduleKind;
  intervalMinutes?: number | null;
  atMinute?: number | null;
  weekdays?: number[];
  timezone?: string;
  ownerPrincipalId: string;
  enabled?: boolean;
}

/**
 * How late a `daily` schedule may still fire.
 *
 * The ticker runs about once a minute, so an exact minute match would drop the
 * whole day's run if a tick were late, the container restarted, or a deploy
 * landed at 07:30. Ten minutes absorbs that. It deliberately does not absorb
 * more: a briefing delivered at 14:00 because the hub was down all morning is
 * worse than no briefing, because it reads as current.
 */
export const DAILY_CATCH_UP_MINUTES = 10;

interface LocalParts {
  minuteOfDay: number;
  weekday: number;
  /** Local calendar date as YYYY-MM-DD — the "have I already run today" key. */
  date: string;
}

/**
 * The wall-clock reading of an instant in a zone.
 *
 * Built from numeric parts rather than locale names: `weekday: "short"` would
 * hand back a string that changes with the locale, while a UTC date built from
 * the local y/m/d gives the weekday arithmetically and the date key for free.
 */
function localParts(at: Date, timezone: string): LocalParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      // h23 rather than hour12:false — the latter reports midnight as hour 24
      // in some environments, which would put it a day out.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);

    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const [year, month, day, hour, minute] = [
      get("year"), get("month"), get("day"), get("hour"), get("minute"),
    ];
    if ([year, month, day, hour, minute].some((n) => !Number.isFinite(n))) return null;

    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      minuteOfDay: hour * 60 + minute,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      date: `${year}-${pad(month)}-${pad(day)}`,
    };
  } catch {
    // An unusable timezone. Rejected on write; if one is here anyway, refusing
    // to fire beats firing at the wrong hour.
    return null;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Should this schedule fire at `now`?
 *
 * Pure, so the whole truth table is testable without a clock or a database.
 */
export function isDue(schedule: Schedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  const last = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;

  if (schedule.kind === "every") {
    const minutes = schedule.intervalMinutes;
    if (!minutes || minutes < 1) return false;
    if (!last || Number.isNaN(last.getTime())) return true;
    return now.getTime() - last.getTime() >= minutes * 60_000;
  }

  const atMinute = schedule.atMinute;
  if (atMinute === null || atMinute < 0 || atMinute > 1439) return false;

  const nowLocal = localParts(now, schedule.timezone);
  if (!nowLocal) return false;

  if (schedule.weekdays.length > 0 && !schedule.weekdays.includes(nowLocal.weekday)) return false;

  const since = nowLocal.minuteOfDay - atMinute;
  if (since < 0 || since > DAILY_CATCH_UP_MINUTES) return false;

  // At most once per LOCAL day. Comparing local dates rather than elapsed hours
  // is what makes the autumn DST change safe: when 01:30 happens twice, the
  // second one is the same local date and does not fire again.
  if (last && !Number.isNaN(last.getTime())) {
    const lastLocal = localParts(last, schedule.timezone);
    if (lastLocal && lastLocal.date === nowLocal.date) return false;
  }
  return true;
}

// Two spellings of one list: unqualified for INSERT … RETURNING, where there is
// no alias to qualify against, and `s.`-qualified for the join in
// schedulesToConsider. Keep them in step.
const columnList = (p = "") => `
  ${p}id, ${p}agent_id as "agentId", ${p}name, ${p}prompt, ${p}kind,
  ${p}interval_minutes as "intervalMinutes", ${p}at_minute as "atMinute",
  ${p}weekdays, ${p}timezone,
  ${p}owner_principal_id as "ownerPrincipalId", ${p}enabled,
  ${p}last_run_at as "lastRunAt", ${p}last_run_id as "lastRunId",
  ${p}last_error as "lastError",
  ${p}created_at as "createdAt", ${p}updated_at as "updatedAt"
`;

const COLUMNS = columnList();
const S_COLUMNS = columnList("s.");

/** Rejects a schedule that could never fire, rather than storing a dead row. */
function validate(input: ScheduleInput): string | null {
  if (!input.name?.trim()) return "A schedule needs a name.";
  if (!input.prompt?.trim()) return "A schedule needs a prompt — it is what the agent is asked.";
  if (input.kind === "every") {
    const m = input.intervalMinutes;
    if (!Number.isInteger(m) || (m as number) < 1) {
      return "An interval schedule needs a whole number of minutes, at least 1.";
    }
  } else if (input.kind === "daily") {
    const m = input.atMinute;
    if (!Number.isInteger(m) || (m as number) < 0 || (m as number) > 1439) {
      return "A daily schedule needs a time of day between 00:00 and 23:59.";
    }
    if ((input.weekdays ?? []).some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return "Weekdays are 0 (Sunday) to 6 (Saturday).";
    }
    if (!isValidTimezone(input.timezone ?? "UTC")) {
      return `"${input.timezone}" is not a timezone I can read.`;
    }
  } else {
    return `Unknown schedule kind "${input.kind}".`;
  }
  return null;
}

export async function createSchedule(input: ScheduleInput): Promise<Schedule | { error: string }> {
  const problem = validate(input);
  if (problem) return { error: problem };
  const sql = getSql();
  const rows = await sql<Schedule[]>`
    insert into agent_schedules
      (agent_id, name, prompt, kind, interval_minutes, at_minute, weekdays,
       timezone, owner_principal_id, enabled)
    values (${input.agentId}, ${input.name.trim()}, ${input.prompt.trim()}, ${input.kind},
            ${input.kind === "every" ? input.intervalMinutes! : null},
            ${input.kind === "daily" ? input.atMinute! : null},
            ${sql.json((input.weekdays ?? []) as Parameters<typeof sql.json>[0])},
            ${input.timezone ?? "UTC"}, ${input.ownerPrincipalId}, ${input.enabled ?? true})
    returning ${sql.unsafe(COLUMNS)}
  `;
  return rows[0];
}

export async function listSchedules(agentId?: string): Promise<Schedule[]> {
  const sql = getSql();
  return sql<Schedule[]>`
    select ${sql.unsafe(COLUMNS)} from agent_schedules
    ${agentId ? sql`where agent_id = ${agentId}` : sql``}
    order by created_at desc
  `;
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const sql = getSql();
  const rows = await sql<Schedule[]>`
    select ${sql.unsafe(COLUMNS)} from agent_schedules where id = ${id} limit 1
  `;
  return rows[0] ?? null;
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update agent_schedules set enabled = ${enabled}, updated_at = now() where id = ${id}
  `;
  return rows.count > 0;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from agent_schedules where id = ${id}`;
  return rows.count > 0;
}

/**
 * The schedules a tick should consider: enabled, and belonging to a principal
 * who is still enabled.
 *
 * The join is the point. A schedule outlives the person who made it, and
 * "disable this person" has to mean their unattended runs stop too — otherwise
 * revoking someone leaves their agent still reading the mailbox every morning.
 */
export async function schedulesToConsider(): Promise<Schedule[]> {
  const sql = getSql();
  return sql<Schedule[]>`
    select ${sql.unsafe(S_COLUMNS)}
    from agent_schedules s
    join principals p on p.id = s.owner_principal_id
    join agents a on a.id = s.agent_id
    where s.enabled and p.enabled and a.enabled
    order by s.created_at
  `;
}

/**
 * Take ownership of a run, or lose the race.
 *
 * `last_run_at` is stamped BEFORE the agent runs, not after: a run takes
 * minutes, and a schedule still holding its old timestamp would look due to
 * every tick in between. The conditional makes the claim atomic, so two
 * containers ticking at the same second cannot both fire one schedule — which
 * matters the moment this runs on more than one Fly machine.
 */
export async function claimSchedule(id: string, observedLastRunAt: string | null): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update agent_schedules
       set last_run_at = now(), updated_at = now()
     where id = ${id}
       and enabled
       and last_run_at is not distinct from ${observedLastRunAt}
  `;
  return rows.count > 0;
}

/** Record what a claimed run turned into. */
export async function finishScheduleRun(
  id: string,
  outcome: { runId?: string | null; error?: string | null },
): Promise<void> {
  const sql = getSql();
  await sql`
    update agent_schedules
       set last_run_id = ${outcome.runId ?? null},
           last_error  = ${outcome.error ?? null},
           updated_at  = now()
     where id = ${id}
  `;
}

export interface TickOutcome {
  considered: number;
  due: number;
  claimed: number;
  ran: { scheduleId: string; runId: string | null; error?: string }[];
}

/**
 * One pass of the clock.
 *
 * The runner is injected rather than imported: running an agent lives in the
 * web app (it needs the MCP layer, RAG and the policy engine), and this module
 * is in @ai-hub/db. Keeping the dependency pointing that way is also what lets
 * the whole selection → claim → record cycle be verified against a real
 * database with a fake runner.
 */
export async function runDueSchedules(
  run: (schedule: Schedule) => Promise<{ runId?: string | null; error?: string }>,
  now: Date = new Date(),
): Promise<TickOutcome> {
  const considered = await schedulesToConsider();
  const due = considered.filter((s) => isDue(s, now));
  const outcome: TickOutcome = { considered: considered.length, due: due.length, claimed: 0, ran: [] };

  for (const schedule of due) {
    if (!(await claimSchedule(schedule.id, schedule.lastRunAt))) continue;
    outcome.claimed++;
    let result: { runId?: string | null; error?: string };
    try {
      result = await run(schedule);
    } catch (err) {
      // A runner that throws must not take the tick down with it — the
      // schedules after this one still deserve their turn.
      result = { error: err instanceof Error ? err.message : "The scheduled run failed." };
    }
    await finishScheduleRun(schedule.id, result);
    outcome.ran.push({
      scheduleId: schedule.id,
      runId: result.runId ?? null,
      ...(result.error ? { error: result.error } : {}),
    });
  }
  return outcome;
}
