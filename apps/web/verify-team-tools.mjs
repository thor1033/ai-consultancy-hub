// Verification of the team view behind Teqneo Code's Hub page
// (src/lib/mcp/teamTools.ts, src/lib/teamView.ts).
//
//   node --experimental-transform-types apps/web/verify-team-tools.mjs
//
// No database, no network: it checks the pure pieces (how the board is
// summarised per person, how a schedule is described) and, by reading the
// source, the rules that keep the tools from widening anything: every tool
// needs agent:run, team-wide approval counts are an admin's, schedules go
// through the one copy of the page's rules, and the board is read through the
// read-only PM-tool connection. Not proven here: the tools against a real
// database and board, which need DATABASE_URL and the PM tool.
import { readFileSync } from "node:fs";
import { TASK_DESCRIPTION_MAX, boardByOwner, describeSchedule, meetingsFrom, openTasks, projectChoices, withTrackNames } from "./src/lib/teamView.ts";

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("— the board, per person —");
const board = boardByOwner([
  { title: "A", status: "inprogress", owner: "Thor", end: "2026-11-20", overdue: false },
  { title: "B", status: "todo", owner: "Thor", end: "2026-11-01", overdue: true },
  { title: "C", status: "review", owner: "Ditlev", end: null },
  { title: "D", status: "done", owner: "Ditlev", end: "2026-10-01", overdue: false },
  { title: "E", status: "backlog", owner: null, end: null },
  { title: "F", status: "backlog", owner: "  ", end: null },
]);
check("done tasks are left out", !board.some((p) => p.tasks.some((t) => t.title === "D")));
check("the busiest person comes first, Unassigned last", board[0].owner === "Thor" && board.at(-1).owner === "Unassigned");
check("no owner, or a blank one, is Unassigned", board.find((p) => p.owner === "Unassigned")?.open === 2);
const thor = board.find((p) => p.owner === "Thor");
check("counts open and late", thor.open === 2 && thor.overdue === 1);
check("late tasks are listed first", thor.tasks[0].title === "B");
check("in review is counted", board.find((p) => p.owner === "Ditlev")?.inReview === 1);
const many = boardByOwner(Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, status: "todo", owner: "X", end: null })));
check("a person's list is capped at twelve, the count is not", many[0].tasks.length === 12 && many[0].open === 30);

console.log("\n— tasks to pick up, and the projects to choose from —");
const open = openTasks([
  { id: "t1", title: "A", status: "inprogress", track: "Web", priority: true, owner: " Thor ", end: "2026-11-20", overdue: false, description: "do it" },
  { id: "t2", title: "", status: "backlog", owner: null, end: null, description: "x".repeat(TASK_DESCRIPTION_MAX + 500) },
  { id: "t3", title: "Done", status: "done" },
  { title: "No id", status: "backlog" },
]);
check("done tasks and tasks without an id are left out", open.length === 2 && open.every((t) => t.id === "t1" || t.id === "t2"));
check("a task keeps its id, track, owner and date", open[0].id === "t1" && open[0].track === "Web" && open[0].owner === "Thor" && open[0].end === "2026-11-20" && open[0].priority === true);
check("an untitled task says so; missing fields are null, not undefined", open[1].title === "(untitled)" && open[1].owner === null && open[1].track === null && open[1].overdue === false);
check("a long description is cut, and says so", open[1].description.length < TASK_DESCRIPTION_MAX + 100 && /shortened/.test(open[1].description));
const choices = projectChoices([{ id: "p1", name: "Client", taskCount: 10, doneCount: 4 }, { id: "p2", name: " " }, { name: "no id" }, null]);
check("projects keep their order, with open counts", choices.length === 2 && choices[0].open === 6 && choices[1].name === "p2" && choices[1].open === 0);
check("anything but a list is no projects", projectChoices("No projects.").length === 0 && projectChoices(null).length === 0);

const named = withTrackNames([{ id: "a", track: "ct_1" }, { id: "b", track: "ct_gone" }, { id: "c" }], [{ id: "ct_1", label: " Sales " }, { id: "ct_2" }, null]);
check("a task shows its track by name; an unknown track keeps its id", named.map((t) => t.track ?? "-").join() === "Sales,ct_gone,-");
check("no track list at all leaves the tasks as they were", withTrackNames([{ id: "a", track: "ct_1" }], undefined)[0].track === "ct_1");
check("a task carries its agent, lower-cased; none is null", openTasks([{ id: "a", agent: " Code " }, { id: "b" }]).map((t) => t.agent).join() === "code,");

console.log("\n— meetings: the Secretary's held writes, per run —");
const held = (over) => ({ id: "p", runId: "r1", runAt: "2026-11-14T10:00:00Z", createdAt: "2026-11-14T10:05:00Z", tool: "pm_update_task", status: "pending", reason: null, error: null, result: null, args: {}, ...over });
const meetings = meetingsFrom([
  held({ id: "p1", tool: "pm_create_task", status: "executed", args: { projectId: "proj", title: "Build export", agent: "Code", owner: "Thor" }, result: JSON.stringify({ id: "t9" }) }),
  held({ id: "p2", args: { projectId: "proj", taskId: "t1", status: "done" }, reason: "Said done at 00:31" }),
  held({ id: "p3", tool: "teams_notes_save", args: { title: "Weekly, 14 Nov" } }),
  held({ id: "p4", runId: "r2", runAt: "2026-11-15T09:00:00Z", tool: "pm_add_note", status: "rejected", args: { title: "Board review" } }),
  held({ id: "p5", runId: "r3", runAt: "2026-11-10T09:00:00Z", args: null, reason: "Kept inside" }),
  held({ id: "p6", runId: null, runAt: null, createdAt: "2026-11-01T09:00:00Z", tool: "pm_create_task", status: "failed", error: "No track", result: "not json" }),
]);
check("one meeting per run, newest first; a write without a run stands alone", meetings.map((m) => m.run).join() === "r2,r1,r3,p6");
const weekly = meetings.find((m) => m.run === "r1");
check("a meeting is titled by its saved note", weekly.title === "Weekly, 14 Nov" && meetings[0].title === "Board review");
check("it counts what still waits, and lists that first", weekly.waiting === 2 && weekly.changes[0].status === "pending" && weekly.changes.at(-1).proposal === "p1");
const made = weekly.changes.find((c) => c.proposal === "p1");
check("a created task is found by the id the PM tool answered", made.kind === "create" && made.taskId === "t9" && made.agent === "code" && made.owner === "Thor");
check("an update names its task; its reason is kept", weekly.changes.find((c) => c.proposal === "p2").taskId === "t1" && weekly.changes.find((c) => c.proposal === "p2").reason === "Said done at 00:31");
const kept = meetings.find((m) => m.run === "r3").changes[0];
check("arguments kept inside the hub give no title, task or agent", kept.title === null && kept.taskId === null && kept.agent === null && kept.reason === "Kept inside");
check("a failed create with an unreadable answer has no task id, and keeps its error", meetings.at(-1).changes[0].taskId === null && meetings.at(-1).changes[0].error === "No track");

console.log("\n— schedules, as a person reads them —");
const base = { intervalMinutes: null, atMinute: null, weekdays: [], timezone: "Europe/Copenhagen" };
check("every 30 min", describeSchedule({ ...base, kind: "every", intervalMinutes: 30 }) === "every 30 min");
check("every 2 h", describeSchedule({ ...base, kind: "every", intervalMinutes: 120 }) === "every 2 h");
check("daily 07:05", describeSchedule({ ...base, kind: "daily", atMinute: 425 }) === "daily 07:05 (Europe/Copenhagen)");
check("weekdays", describeSchedule({ ...base, kind: "daily", atMinute: 540, weekdays: [1, 2, 3, 4, 5] }).startsWith("weekdays 09:00"));
check("named days", describeSchedule({ ...base, kind: "daily", atMinute: 0, weekdays: [1, 3] }).startsWith("Mon, Wed 00:00"));

console.log("\n— what the tools may not do —");
const src = readFileSync(new URL("./src/lib/mcp/teamTools.ts", import.meta.url), "utf8");
const toolBodies = src.split("server.registerTool(").slice(1);
check("seven tools", toolBodies.length === 7);
check("every tool checks agent:run first", toolBodies.every((b) => /if \(!\(await may\("agent:run"\)\)\) return notAllowed\(\);/.test(b)));
check("team-wide approval counts only for an admin", /if \(!admin\) continue;/.test(src) && /\.\.\.\(admin\s*\?\s*\{ waitingOn/.test(src));
check("non-admins list only proposals visible to them", /visibleTo: principal\.id/.test(src));
check("the board is read through the read-only PM connection", /PM_READ_SERVER = "pm-tool-read"/.test(src) && !/"pm-tool"[^-]/.test(src));
check("and only through the one guarded read", (src.match(/mcp\.execute\(/g) ?? []).length === 1 && /async function readPm\(tool: "pm_list_tasks" \| "pm_list_projects"/.test(src));
check("a PM connection labelled above internal is not read from outside", /\(await connectionsKeptInside\(\)\)\.has\(PM_READ_SERVER\)/.test(src));
check("no tool here writes to the PM tool", !/execute\("pm_(update|create|add)_/.test(src) && /readPm\(tool: "pm_list_tasks" \| "pm_list_projects"/.test(src));
check("meetings show only what the caller may decide, unless an admin", /agentId: secretary\.id, \.\.\.\(admin \? \{\} : \{ visibleTo: principal\.id \}\)/.test(src));
check("a confidential run\'s arguments and result stay in the hub", /args: mayLeave\(p\.runSensitivity\) \? p\.args : null/.test(src) && /result: mayLeave\(p\.runSensitivity\) \? p\.result : null/.test(src));
check("the meeting view never returns a run\'s prompt", !/runPrompt/.test(src));
check("schedules use the page's rules, not a copy", /createScheduleFor\(principal\.id/.test(src) && /scheduleChangeableBy\(principal\.id/.test(src));
check("an agent's own credential cannot own a schedule", /principal\.agentId\) return text\(/.test(src));
const hub = readFileSync(new URL("./src/lib/mcp/hubServer.ts", import.meta.url), "utf8");
check("the hub registers them only for callers who may run agents", /if \(canRunAgents\) registerTeamTools\(server, principal\);/.test(hub));
const actions = readFileSync(new URL("./src/app/agents/actions.ts", import.meta.url), "utf8");
check("the agent page uses the same rules", /createScheduleFor\(principal\.id, input\)/.test(actions) && /scheduleChangeableBy\(/.test(actions));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
