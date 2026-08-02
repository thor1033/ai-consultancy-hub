import { getSql } from "./client";

// Scheduled automations for Skills. Times are interpreted in the server's local
// timezone (the box the hub runs on), computed with local Date arithmetic so the
// cadence matches the machine clock the runner polls against.

export type ScheduleKind = "once" | "daily" | "weekly" | "monthly";

export interface SkillSchedule {
  id: string;
  skillId: string;
  input: string;
  retrieve: boolean;
  kind: ScheduleKind;
  timeOfDay: string | null; // 'HH:MM'
  weekday: number | null;
  dayOfMonth: number | null;
  runAt: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastRunId: string | null;
  createdAt: string;
}

// SkillSchedule plus the owning skill's name/slug, for list views.
export interface ScheduleWithSkill extends SkillSchedule {
  skillName: string;
  skillSlug: string;
}

export interface CreateScheduleInput {
  skillId: string;
  input: string;
  retrieve?: boolean;
  kind: ScheduleKind;
  timeOfDay?: string | null;
  weekday?: number | null;
  dayOfMonth?: number | null;
  runAt?: string | null;
}

export interface DueSchedule {
  id: string;
  slug: string;
  input: string;
  retrieve: boolean;
}

interface ScheduleShape {
  kind: ScheduleKind;
  timeOfDay?: string | null;
  weekday?: number | null;
  dayOfMonth?: number | null;
  runAt?: string | null;
}

// The next fire time at/after `from` for a schedule, in local time. Returns null
// for a one-off whose instant has passed (it should then be disabled).
export function computeNextRun(s: ScheduleShape, from: Date = new Date()): Date | null {
  if (s.kind === "once") {
    if (!s.runAt) return null;
    const at = new Date(s.runAt);
    return at > from ? at : null;
  }

  const [h, m] = (s.timeOfDay ?? "09:00").split(":").map((n) => parseInt(n, 10));
  const next = new Date(from);
  next.setHours(h, m, 0, 0);

  if (s.kind === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  if (s.kind === "weekly") {
    const target = (((s.weekday ?? 1) % 7) + 7) % 7;
    let delta = (target - next.getDay() + 7) % 7;
    if (delta === 0 && next <= from) delta = 7;
    next.setDate(next.getDate() + delta);
    return next;
  }
  if (s.kind === "monthly") {
    const dom = Math.min(Math.max(s.dayOfMonth ?? 1, 1), 28); // a day every month has
    next.setDate(dom);
    if (next <= from) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(dom);
    }
    return next;
  }
  return null;
}

// Unqualified column list (for INSERT ... RETURNING, no join/alias).
const ret = () => getSql()`
  id, skill_id as "skillId", input, retrieve, kind,
  time_of_day as "timeOfDay", weekday, day_of_month as "dayOfMonth",
  run_at as "runAt", enabled, next_run_at as "nextRunAt",
  last_run_at as "lastRunAt", last_status as "lastStatus",
  last_run_id as "lastRunId", created_at as "createdAt"
`;

// Alias-qualified list (for SELECTs that join skills — `id` is otherwise ambiguous).
const sel = () => getSql()`
  sch.id, sch.skill_id as "skillId", sch.input, sch.retrieve, sch.kind,
  sch.time_of_day as "timeOfDay", sch.weekday, sch.day_of_month as "dayOfMonth",
  sch.run_at as "runAt", sch.enabled, sch.next_run_at as "nextRunAt",
  sch.last_run_at as "lastRunAt", sch.last_status as "lastStatus",
  sch.last_run_id as "lastRunId", sch.created_at as "createdAt"
`;

export async function createSchedule(input: CreateScheduleInput): Promise<SkillSchedule> {
  const sql = getSql();
  const next = computeNextRun(input);
  const [row] = await sql<SkillSchedule[]>`
    insert into skill_schedules
      (skill_id, input, retrieve, kind, time_of_day, weekday, day_of_month, run_at, next_run_at)
    values
      (${input.skillId}, ${input.input}, ${input.retrieve ?? false}, ${input.kind},
       ${input.timeOfDay ?? null}, ${input.weekday ?? null}, ${input.dayOfMonth ?? null},
       ${input.runAt ?? null}, ${next})
    returning ${ret()}
  `;
  return row;
}

export async function listSchedulesForSkill(slug: string): Promise<SkillSchedule[]> {
  const sql = getSql();
  return sql<SkillSchedule[]>`
    select ${sel()}
    from skill_schedules sch
    join skills s on s.id = sch.skill_id
    where s.slug = ${slug}
    order by sch.enabled desc, sch.next_run_at asc nulls last, sch.created_at desc
  `;
}

// Upcoming automations across all skills, for the overview.
export async function listUpcomingSchedules(limit = 8): Promise<ScheduleWithSkill[]> {
  const sql = getSql();
  return sql<ScheduleWithSkill[]>`
    select ${sel()}, s.name as "skillName", s.slug as "skillSlug"
    from skill_schedules sch
    join skills s on s.id = sch.skill_id
    where sch.enabled and sch.next_run_at is not null and s.archived_at is null
    order by sch.next_run_at asc
    limit ${limit}
  `;
}

// Enabling recomputes next_run_at from now; disabling just flips the flag.
export async function setScheduleEnabled(id: string, enabled: boolean): Promise<boolean> {
  const sql = getSql();
  if (!enabled) {
    const rows = await sql`update skill_schedules set enabled = false where id = ${id}`;
    return rows.count > 0;
  }
  const [sched] = await sql<ScheduleShape[]>`
    select kind, time_of_day as "timeOfDay", weekday, day_of_month as "dayOfMonth", run_at as "runAt"
    from skill_schedules where id = ${id}
  `;
  if (!sched) return false;
  const next = computeNextRun(sched);
  const rows = await sql`
    update skill_schedules set enabled = true, next_run_at = ${next} where id = ${id}
  `;
  return rows.count > 0;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from skill_schedules where id = ${id}`;
  return rows.count > 0;
}

// Atomically claim every due schedule: lock the rows, advance next_run_at (or
// disable one-offs) so a concurrent tick can't double-fire, and return what to run.
export async function claimDueSchedules(now: Date = new Date()): Promise<DueSchedule[]> {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const due = await tx<
      (ScheduleShape & { id: string; slug: string; input: string; retrieve: boolean })[]
    >`
      select sch.id, sch.input, sch.retrieve, sch.kind,
             sch.time_of_day as "timeOfDay", sch.weekday, sch.day_of_month as "dayOfMonth",
             sch.run_at as "runAt", s.slug
      from skill_schedules sch
      join skills s on s.id = sch.skill_id
      where sch.enabled and sch.next_run_at is not null and sch.next_run_at <= ${now}
        and s.archived_at is null and s.enabled
      order by sch.next_run_at
      for update of sch skip locked
    `;

    for (const d of due) {
      const next = d.kind === "once" ? null : computeNextRun(d, now);
      if (next) {
        await tx`update skill_schedules set next_run_at = ${next}, last_run_at = ${now} where id = ${d.id}`;
      } else {
        await tx`update skill_schedules set enabled = false, next_run_at = null, last_run_at = ${now} where id = ${d.id}`;
      }
    }

    return due.map((d) => ({ id: d.id, slug: d.slug, input: d.input, retrieve: d.retrieve }));
  });
}

export async function recordScheduleResult(
  id: string,
  status: string,
  runId: string | null,
): Promise<void> {
  const sql = getSql();
  await sql`
    update skill_schedules set last_status = ${status}, last_run_id = ${runId} where id = ${id}
  `;
}
