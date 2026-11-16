/*
 * Pure pieces of the team view (lib/mcp/teamTools.ts), kept free of imports
 * so verify-team-tools.mjs checks them without a database.
 */

/** The parts of a schedule that say when it runs. */
export interface ScheduleTiming {
  kind: "every" | "daily";
  intervalMinutes: number | null;
  atMinute: number | null;
  weekdays: number[];
  timezone: string;
}

/** "every 30 min", "daily 07:00 Mon–Fri (Europe/Copenhagen)": the schedule as a person reads it. */
export function describeSchedule(s: ScheduleTiming): string {
  if (s.kind === "every") {
    const m = s.intervalMinutes ?? 0;
    return m % 60 === 0 && m >= 60 ? `every ${m / 60} h` : `every ${m} min`;
  }
  const at = s.atMinute ?? 0;
  const time = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = s.weekdays ?? [];
  const when =
    days.length === 0 || days.length === 7
      ? "daily"
      : days.join() === "1,2,3,4,5"
        ? "weekdays"
        : days.map((d) => names[d]).join(", ");
  return `${when} ${time} (${s.timezone})`;
}

/** Open PM tasks per owner, from the board's task list. Pure, for the verify script. */
export function boardByOwner(
  tasks: ReadonlyArray<{
    title: string;
    status: string;
    owner: string | null;
    end: string | null;
    overdue?: boolean;
    track?: string | null;
  }>,
): { owner: string; open: number; overdue: number; inReview: number; tasks: { title: string; status: string; end: string | null; overdue: boolean }[] }[] {
  const groups = new Map<string, { title: string; status: string; end: string | null; overdue: boolean }[]>();
  for (const t of tasks) {
    if (t.status === "done") continue;
    const key = t.owner?.trim() || "Unassigned";
    const list = groups.get(key) ?? [];
    list.push({ title: t.title, status: t.status, end: t.end, overdue: Boolean(t.overdue) });
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([owner, list]) => ({
      owner,
      open: list.length,
      overdue: list.filter((t) => t.overdue).length,
      inReview: list.filter((t) => t.status === "review").length,
      // Late first, then by date: what a person should look at first.
      tasks: list
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.end ?? "9999").localeCompare(b.end ?? "9999"))
        .slice(0, 12),
    }))
    .sort((a, b) => (a.owner === "Unassigned" ? 1 : b.owner === "Unassigned" ? -1 : b.open - a.open));
}

