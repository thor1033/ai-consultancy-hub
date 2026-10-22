// Verification of the agents store — the CRUD behind /agents and the memory
// primitives the `memory` MCP server mirrors.
//
//   node --env-file=apps/web/.env.local packages/db/verify-agents.mjs
//
// No API key. Everything happens under a throwaway agent this script creates
// and deletes.
//
// The cases worth having: that an omitted field is left alone while a null one
// is actually cleared (these are different intentions and a coalesce-based
// update conflates them), and that deleting an agent takes its memories with it.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The package's TypeScript uses extensionless imports, which bundlers resolve
// and Node does not. Harness-only; nothing in the package changes for a test.
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
  createAgent, getAgent, listAgents, updateAgent, deleteAgent,
  rememberMemory, listMemories, searchMemories, forgetMemory, setMemoryActive, setMemoryRegion,
} = await import("./src/agents.ts");
const { contextSnapshot } = await import("./src/context.ts");
const { agentRoster, listAgentRuns, hubActivity, listRecentRuns, knowledgeScope, retrievalScope } = await import("./src/agents.ts");
const { serverUsage, toolCallCounts, listServerRuns } = await import("./src/mcpServers.ts");
const { getSql } = await import("./src/client.ts");
const { createSkill } = await import("./src/skills.ts");
const { startRun, finishRun, failRun, listBriefs } = await import("./src/sessions.ts");

const slug = `verify-agents-${Date.now()}`;
let agent;

try {
  // ── create ────────────────────────────────────────────────────────────────
  agent = await createAgent({
    slug,
    name: "Verify Agent",
    description: "Temporary.",
    instructions: "Be brief.",
    model: "claude-opus-4-8",
    mcpServers: [{ name: "sample" }],
    // Untrimmed and repeated on purpose: names are matched exactly against
    // documents.collection, so the store must clean them.
    knowledgeCollections: ["verify-collection", " verify-playbook ", "verify-collection"],
    maxIterations: 25,
  });
  check("createAgent returns the stored row", Boolean(agent?.id), agent?.id?.slice(0, 8));
  check("it round-trips every field",
    agent.slug === slug &&
    agent.instructions === "Be brief." &&
    agent.model === "claude-opus-4-8" &&
    JSON.stringify(agent.knowledgeCollections) === JSON.stringify(["verify-collection", "verify-playbook"]) &&
    agent.knowledgeAll === false &&
    Array.isArray(agent.mcpServers) && agent.mcpServers[0]?.name === "sample" &&
    agent.maxIterations === 25,
    JSON.stringify(agent.mcpServers),
  );
  check("a new agent has no memories", agent.memoryCount === 0);

  // ── read ──────────────────────────────────────────────────────────────────
  const bySlug = await getAgent(slug);
  const byId = await getAgent(agent.id);
  check("getAgent finds it by slug and by id", bySlug?.id === agent.id && byId?.id === agent.id);
  check("getAgent returns null for an unknown handle", (await getAgent("no-such-agent")) === null);

  const listed = await listAgents();
  check("listAgents includes it", listed.some((a) => a.id === agent.id), `${listed.length} agent(s)`);

  // ── update ────────────────────────────────────────────────────────────────
  const renamed = await updateAgent(agent.id, { name: "Renamed" });
  check(
    "an omitted field keeps its stored value",
    renamed.name === "Renamed" &&
      renamed.instructions === "Be brief." &&
      renamed.model === "claude-opus-4-8" &&
      JSON.stringify(renamed.knowledgeCollections) === JSON.stringify(["verify-collection", "verify-playbook"]) &&
      renamed.maxIterations === 25,
    `model=${renamed.model} collections=${renamed.knowledgeCollections} maxIterations=${renamed.maxIterations}`,
  );

  // An agent reading "everything" keeps its list but the scope says all; back
  // to a list, the scope names the list; emptied, it reads nothing.
  const everything = await updateAgent(agent.id, { knowledgeAll: true });
  check(
    "knowledgeAll is stored and wins over the list",
    everything.knowledgeAll === true && knowledgeScope(everything).kind === "all" && everything.knowledgeCollections.length === 2,
  );
  const listed2 = await updateAgent(agent.id, { knowledgeAll: false });
  check(
    "switched back, the scope is the list",
    knowledgeScope(listed2).kind === "collections" && knowledgeScope(listed2).names.length === 2,
    JSON.stringify(knowledgeScope(listed2)),
  );
  check(
    "retrievalScope: all ⇒ unscoped, a list ⇒ that list, none ⇒ null",
    JSON.stringify(retrievalScope({ kind: "all" })) === "{}" &&
      JSON.stringify(retrievalScope({ kind: "collections", names: ["a"] })) === JSON.stringify({ collection: ["a"] }) &&
      retrievalScope({ kind: "none" }) === null,
  );

  // The case a coalesce-based update gets wrong: null means clear it.
  const cleared = await updateAgent(agent.id, {
    model: null,
    knowledgeCollections: [],
    maxIterations: null,
  });
  check(
    "an explicit null clears a nullable field",
    cleared.model === null && cleared.maxIterations === null,
    `model=${cleared.model} maxIterations=${cleared.maxIterations}`,
  );
  check(
    "an emptied collection list means the agent reads nothing",
    cleared.knowledgeCollections.length === 0 && knowledgeScope(cleared).kind === "none",
    JSON.stringify(cleared.knowledgeCollections),
  );
  // Null is not a gap in the data: it is how an agent says "use the runtime
  // default", which is what agentRuns passes through as undefined.
  check(
    "a cleared iteration cap reads back as null, not 0",
    cleared.maxIterations === null && Object.is(cleared.maxIterations, null),
  );
  check("…without disturbing the fields around it", cleared.name === "Renamed" && cleared.instructions === "Be brief.");

  const disabled = await updateAgent(agent.id, { enabled: false });
  check("enabled can be turned off", disabled.enabled === false);

  check("updateAgent on a missing agent returns null",
    (await updateAgent("00000000-0000-0000-0000-000000000000", { name: "x" })) === null);

  // ── memory ────────────────────────────────────────────────────────────────
  await rememberMemory(agent.id, "cadence", "Reviews are on Tuesday.");
  await rememberMemory(agent.id, "style", "Muted navy, one chart per slide.");
  const mems = await listMemories(agent.id);
  check("memories are stored and listed", mems.length === 2, mems.map((m) => m.key).join(", "));

  await rememberMemory(agent.id, "cadence", "Correction: reviews are on Wednesday.");
  const afterUpsert = await listMemories(agent.id);
  check(
    "writing the same key replaces rather than appends",
    afterUpsert.length === 2 &&
      afterUpsert.find((m) => m.key === "cadence")?.content.includes("Wednesday"),
  );

  check("new memories are active", afterUpsert.every((m) => m.active === true));
  check("setMemoryActive moves a memory to inactive", (await setMemoryActive(agent.id, "style", false)) === true);
  const ordered = await listMemories(agent.id);
  check(
    "listMemories puts active work first",
    ordered[0].key === "cadence" && ordered[1].key === "style" && ordered[1].active === false,
    ordered.map((m) => `${m.key}:${m.active}`).join(", "),
  );
  check("setMemoryActive on an absent key is false",
    (await setMemoryActive(agent.id, "never-existed", true)) === false);
  await rememberMemory(agent.id, "style", "Muted navy, one chart per slide.");
  check(
    "rewriting an inactive memory makes it active again",
    (await listMemories(agent.id)).find((m) => m.key === "style")?.active === true,
  );

  const found = await searchMemories(agent.id, "navy");
  check("searchMemories matches on content", found.length === 1 && found[0].key === "style");
  const none = await searchMemories(agent.id, "zzzz");
  check("a search matching nothing returns nothing", none.length === 0);

  check("forgetMemory removes one", (await forgetMemory(agent.id, "style")) === true);
  check("forgetting an absent key is false, not an error",
    (await forgetMemory(agent.id, "never-existed")) === false);
  check("one memory remains", (await listMemories(agent.id)).length === 1);

  const counted = await getAgent(agent.id);
  check("the agent's memoryCount reflects the store", counted.memoryCount === 1, String(counted.memoryCount));

  // ── context map ───────────────────────────────────────────────────────────
  const [{ updatedAt: before }] = await getSql()`
    select updated_at as "updatedAt" from agent_memories where agent_id = ${agent.id} and key = 'cadence'
  `;
  check("setMemoryRegion files a memory", (await setMemoryRegion(agent.id, "cadence", "routines")) === true);
  let snap = await contextSnapshot();
  const filed = snap.memories.find((m) => m.agentId === agent.id && m.key === "cadence");
  check("the context snapshot carries the region", filed?.region === "routines", String(filed?.region));
  check("filing is not an edit: updated_at is unchanged", filed && Date.parse(filed.updatedAt) === new Date(before).getTime());
  check("setMemoryRegion with null untags it", (await setMemoryRegion(agent.id, "cadence", null)) === true);
  snap = await contextSnapshot();
  check("an untagged memory has a null region",
    snap.memories.find((m) => m.agentId === agent.id && m.key === "cadence")?.region === null);
  check("setMemoryRegion on an absent key is false", (await setMemoryRegion(agent.id, "never-existed", "people")) === false);
  const mine = snap.agents.find((a) => a.id === agent.id);
  check("the snapshot lists the agent with its brief", mine?.brief === "Be brief.", mine?.brief);
  check("the snapshot's activity is newest first and capped",
    snap.activity.length <= 10 && snap.activity.every((e, i, all) => i === 0 || all[i - 1].at >= e.at));
  // ── roster and runs ───────────────────────────────────────────────────────
  await getSql()`
    insert into agent_sessions (prompt, status, agent_id, started_at, cost_usd)
    values ('verify run ok', 'succeeded', ${agent.id}, now() - interval '1 hour', 0.25),
           ('verify run failed', 'failed', ${agent.id}, now() - interval '2 hours', 0.05),
           ('verify run old', 'succeeded', ${agent.id}, now() - interval '20 days', 9)
  `;
  const row = (await agentRoster()).find((r) => r.id === agent.id);
  check("the roster lists the agent", Boolean(row));
  check("the roster counts runs and failures in the last 7 days only",
    row?.runs7d === 2 && row?.failed7d === 1, `${row?.runs7d} runs, ${row?.failed7d} failed`);
  check("the roster sums 7-day spend as a number",
    typeof row?.spend7d === "number" && Math.abs(row.spend7d - 0.3) < 1e-9, String(row?.spend7d));
  check("runsByDay has 7 days and today's runs",
    row?.runsByDay?.length === 7 && row.runsByDay[6] >= 1, JSON.stringify(row?.runsByDay));
  check("the roster's last run is the newest", row?.lastRunStatus === "succeeded");
  const runs = await listAgentRuns(agent.id, 2);
  check("listAgentRuns is newest first and limited",
    runs.length === 2 && runs[0].prompt === "verify run ok" && runs[1].status === "failed");
  check("run cost comes back as a number", typeof runs[0].costUsd === "number");
  // ── briefs: runs of a brief skill, as the Briefs page lists them ─────────
  const briefSkill = await createSkill({ agentId: agent.id, slug: `verify-brief-${Date.now()}`, name: "Verify brief", kind: "brief", promptTemplate: "x" });
  const taskSkill = await createSkill({ agentId: agent.id, slug: `verify-task-${Date.now()}`, name: "Verify task", promptTemplate: "x" });
  check("a skill is a task unless said otherwise", taskSkill.kind === "task" && briefSkill.kind === "brief");
  const briefRun = await startRun({ prompt: "brief", agentId: agent.id, skillId: briefSkill.id });
  const taskRun = await startRun({ prompt: "task", agentId: agent.id, skillId: taskSkill.id });
  const failedBrief = await startRun({ prompt: "brief", agentId: agent.id, skillId: briefSkill.id });
  await finishRun(briefRun, { output: "## Thursday\nNothing on." });
  await finishRun(taskRun, { output: "an answer" });
  await failRun(failedBrief, "the calendar was unreachable");
  const briefs = await listBriefs(50);
  const ids = briefs.map((b) => b.id);
  check("listBriefs returns runs of brief skills with their output", ids.includes(briefRun) && briefs.find((b) => b.id === briefRun)?.output === "## Thursday\nNothing on.");
  check("and a failed brief with its reason", briefs.find((b) => b.id === failedBrief)?.status === "failed" && /unreachable/.test(briefs.find((b) => b.id === failedBrief)?.error ?? ""));
  check("but never a run of an ordinary task", !ids.includes(taskRun));
  check("each names its agent and skill", briefs.find((b) => b.id === briefRun)?.agentSlug === agent.slug && briefs.find((b) => b.id === briefRun)?.skillSlug === briefSkill.slug);
  await getSql()`delete from agent_sessions where id in (${briefRun}, ${taskRun}, ${failedBrief})`;

  const days = await hubActivity(14);
  const today = days[days.length - 1];
  check("hubActivity fills every day, oldest first",
    days.length === 14 && days[0].day < today.day, `${days[0]?.day} … ${today?.day}`);
  check("hubActivity counts today's runs and failures",
    today.runs >= 2 && today.failed >= 1 && typeof today.spend === "number", JSON.stringify(today));
  const recent = await listRecentRuns(50);
  const ours = recent.filter((r) => r.agentSlug === slug);
  check("listRecentRuns names the agent behind each run",
    ours.length === 3 && ours[0].agentName === "Renamed" && ours[0].prompt === "verify run ok",
    JSON.stringify(ours.map((r) => [r.prompt, r.agentName])));
  // ── server and tool usage ─────────────────────────────────────────────────
  const srv = `verify-srv-${Date.now()}`;
  const tool = `verify_tool_${Date.now()}`;
  await getSql()`
    insert into agent_sessions (prompt, status, agent_id, started_at, mcp_servers, tools_used)
    values ('verify srv new', 'succeeded', ${agent.id}, now() - interval '1 hour',
            ${getSql().json([srv])}, ${getSql().json([tool, tool])}),
           ('verify srv old', 'succeeded', ${agent.id}, now() - interval '40 days',
            ${getSql().json([srv])}, ${getSql().json([tool])})
  `;
  const usage = (await serverUsage(7)).find((u) => u.name === srv);
  check("serverUsage counts only runs in the window but remembers the last use",
    usage?.runs === 1 && Boolean(usage?.lastUsedAt), JSON.stringify(usage));
  const calls = (await toolCallCounts(30)).find((t) => t.tool === tool);
  check("toolCallCounts counts every call in the window", calls?.calls === 2, JSON.stringify(calls));
  const srvRuns = await listServerRuns(srv, 5);
  check("listServerRuns finds the runs that connected to a server, newest first",
    srvRuns.length === 2 && srvRuns[0].prompt === "verify srv new" && Array.isArray(srvRuns[0].toolsUsed));
  check("listServerRuns ignores other servers", (await listServerRuns(`${srv}-none`, 5)).length === 0);
  await getSql()`delete from agent_sessions where agent_id = ${agent.id}`;
  check("knowledge counts are numbers",
    Number.isInteger(snap.knowledge.documents) && Number.isInteger(snap.knowledge.collections));

  // ── delete cascades ───────────────────────────────────────────────────────
  const agentId = agent.id;
  check("deleteAgent reports success", (await deleteAgent(agentId)) === true);
  agent = null;
  check("the agent is gone", (await getAgent(slug)) === null);
  const sql = getSql();
  const [{ count }] = await sql`
    select count(*)::int as count from agent_memories where agent_id = ${agentId}
  `;
  check("its memories go with it", count === 0, `${count} left`);
  check("deleting twice is false, not an error", (await deleteAgent(agentId)) === false);
} finally {
  if (agent?.id) await deleteAgent(agent.id);
  await getSql().end();
}

const failed = checks.filter((c) => !c.ok);
console.log(
  failed.length === 0
    ? `Agents store OK (${checks.length} checks)`
    : `Agents store FAILED (${failed.length}/${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
