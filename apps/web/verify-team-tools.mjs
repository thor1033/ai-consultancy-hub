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
import { TASK_DESCRIPTION_MAX, boardByOwner, describeSchedule, openTasks, projectChoices } from "./src/lib/teamView.ts";

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
check("six tools", toolBodies.length === 6);
check("every tool checks agent:run first", toolBodies.every((b) => /if \(!\(await may\("agent:run"\)\)\) return notAllowed\(\);/.test(b)));
check("team-wide approval counts only for an admin", /if \(!admin\) continue;/.test(src) && /\.\.\.\(admin\s*\?\s*\{ waitingOn/.test(src));
check("non-admins list only proposals visible to them", /visibleTo: principal\.id/.test(src));
check("the board is read through the read-only PM connection", /PM_READ_SERVER = "pm-tool-read"/.test(src) && !/"pm-tool"[^-]/.test(src));
check("and only through the one guarded read", (src.match(/mcp\.execute\(/g) ?? []).length === 1 && /async function readPm\(tool: "pm_list_tasks" \| "pm_list_projects"/.test(src));
check("a PM connection labelled above internal is not read from outside", /\(await connectionsKeptInside\(\)\)\.has\(PM_READ_SERVER\)/.test(src));
check("no tool here writes to the PM tool", !/pm_(update|create|add)_/.test(src));
check("schedules use the page's rules, not a copy", /createScheduleFor\(principal\.id/.test(src) && /scheduleChangeableBy\(principal\.id/.test(src));
check("an agent's own credential cannot own a schedule", /principal\.agentId\) return text\(/.test(src));
const hub = readFileSync(new URL("./src/lib/mcp/hubServer.ts", import.meta.url), "utf8");
check("the hub registers them only for callers who may run agents", /if \(canRunAgents\) registerTeamTools\(server, principal\);/.test(hub));
const actions = readFileSync(new URL("./src/app/agents/actions.ts", import.meta.url), "utf8");
check("the agent page uses the same rules", /createScheduleFor\(principal\.id, input\)/.test(actions) && /scheduleChangeableBy\(/.test(actions));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
