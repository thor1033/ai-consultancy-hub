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

/** One open task as a client outside the hub lists it (Teqneo Code's Work page). */
export interface OpenTask {
  id: string;
  title: string;
  status: string;
  track: string | null;
  priority: boolean;
  owner: string | null;
  end: string | null;
  overdue: boolean;
  description: string | null;
  /** The agent the task is meant for: a hub agent's slug, or "code"; null when it is a person's. */
  agent: string | null;
}

/** A description longer than this is cut: the list is for choosing a task, the PM tool has the rest. */
export const TASK_DESCRIPTION_MAX = 4000;

/** The tasks not yet done, with what a person needs to pick one up. Pure, for the verify script. */
export function openTasks(tasks: ReadonlyArray<Record<string, unknown>>): OpenTask[] {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return tasks
    .filter((t) => str(t.id) && t.status !== "done")
    .map((t) => {
      const description = str(t.description);
      return {
        id: String(t.id),
        title: str(t.title) ?? "(untitled)",
        status: str(t.status) ?? "backlog",
        track: str(t.track),
        priority: Boolean(t.priority),
        owner: str(t.owner)?.trim() ?? null,
        end: str(t.end),
        overdue: Boolean(t.overdue),
        agent: str(t.agent)?.trim().toLowerCase() ?? null,
        description:
          description && description.length > TASK_DESCRIPTION_MAX
            ? `${description.slice(0, TASK_DESCRIPTION_MAX)}\n[shortened; the PM tool has the full task]`
            : description,
      };
    });
}

/** One held write as the meeting view reads it: what a proposal row gives, and nothing about the run's prompt. */
export interface MeetingProposal {
  id: string;
  runId: string | null;
  runAt: string | null;
  createdAt: string;
  tool: string;
  status: string;
  reason: string | null;
  error: string | null;
  result: string | null;
  /** Null when the run read confidential material: its arguments stay in the hub. */
  args: Record<string, unknown> | null;
}

export interface MeetingChange {
  proposal: string;
  kind: "create" | "update" | "note" | "other";
  status: string;
  /** What it is about, in the task's or note's own words; null when the arguments stay in the hub. */
  title: string | null;
  taskId: string | null;
  projectId: string | null;
  agent: string | null;
  owner: string | null;
  reason: string | null;
  error: string | null;
}

export interface Meeting {
  run: string;
  at: string;
  title: string | null;
  waiting: number;
  changes: MeetingChange[];
}

const KIND_OF_TOOL: Record<string, MeetingChange["kind"]> = {
  pm_create_task: "create",
  pm_update_task: "update",
  pm_add_note: "note",
  teams_notes_save: "note",
};

/** The id of the task a create made, from the PM tool's answer; null when it is not there to read. */
function createdTaskId(result: string | null): string | null {
  if (!result) return null;
  try {
    const row = JSON.parse(result) as { id?: unknown };
    return typeof row?.id === "string" ? row.id : null;
  } catch {
    return null;
  }
}

/**
 * The Secretary's held writes as meetings: one per run, newest first, each
 * with the changes it proposed (waiting first) and how many still wait. A
 * meeting's title is its saved note's, when the run wrote one. Pure, for the
 * verify script.
 */
export function meetingsFrom(rows: ReadonlyArray<MeetingProposal>): Meeting[] {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const runs = new Map<string, MeetingProposal[]>();
  for (const row of rows) {
    const key = row.runId ?? row.id;
    runs.set(key, [...(runs.get(key) ?? []), row]);
  }
  return [...runs.entries()]
    .map(([run, list]) => {
      const note = list.find((p) => p.tool === "teams_notes_save") ?? list.find((p) => p.tool === "pm_add_note");
      const changes = list
        .map((p): MeetingChange => {
          const kind = KIND_OF_TOOL[p.tool] ?? "other";
          return {
            proposal: p.id,
            kind,
            status: p.status,
            title: str(p.args?.title) ?? str(p.args?.subject),
            taskId: str(p.args?.taskId) ?? (kind === "create" ? createdTaskId(p.result) : null),
            projectId: str(p.args?.projectId),
            agent: str(p.args?.agent)?.toLowerCase() ?? null,
            owner: str(p.args?.owner),
            reason: p.reason,
            error: p.error,
          };
        })
        .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
      return {
        run,
        at: list[0]!.runAt ?? list.map((p) => p.createdAt).sort()[0]!,
        title: str(note?.args?.title) ?? str(note?.args?.subject),
        waiting: changes.filter((c) => c.status === "pending").length,
        changes,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The PM tool's projects as a picker needs them: id, name, open count; most recently touched first, as given. */
export function projectChoices(projects: unknown): { id: string; name: string; open: number }[] {
  if (!Array.isArray(projects)) return [];
  return projects
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object" && typeof (p as { id?: unknown }).id === "string")
    .map((p) => ({
      id: String(p.id),
      name: typeof p.name === "string" && p.name.trim() ? p.name : String(p.id),
      open: Math.max(0, Number(p.taskCount ?? 0) - Number(p.doneCount ?? 0)) || 0,
    }));
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

/**
 * The PM tool's tasks with each track's name in place of its id ("ct_m02eqk1"
 * means nothing to a person). A track the list does not know keeps its id:
 * an odd label is better than a task that vanishes. Pure, for the verify script.
 */
export function withTrackNames(
  tasks: ReadonlyArray<Record<string, unknown>>,
  tracks: unknown,
): Record<string, unknown>[] {
  const names = new Map<string, string>();
  for (const t of Array.isArray(tracks) ? tracks : []) {
    const row = t as { id?: unknown; label?: unknown } | null;
    if (typeof row?.id === "string" && typeof row.label === "string" && row.label.trim()) {
      names.set(row.id, row.label.trim());
    }
  }
  return tasks.map((t) => (typeof t.track === "string" && names.has(t.track) ? { ...t, track: names.get(t.track) } : { ...t }));
}
