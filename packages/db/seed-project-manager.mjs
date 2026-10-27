// Provision the Project Manager — agent, skills and induction memories — from
// the definition in src/seeds/project-manager.ts.
//
//   node packages/db/seed-project-manager.mjs --check                           # no DB, no network
//   node --env-file=apps/web/.env.local packages/db/seed-project-manager.mjs
//   node --env-file=apps/web/.env.local packages/db/seed-project-manager.mjs --skills-only
//
// Idempotent, like the other seeds: the agent by slug, each skill by slug,
// each memory by key. This agent existed as a hand-typed row before this file;
// the full seed rewrites that row from the definition (instructions, servers,
// knowledge scope, placement) and leaves the memories it did not seed alone.
// A deployment that has since tuned the row by hand runs --skills-only.
//
// The checks run first and refuse to provision on failure. The ones that
// matter: the agent holds the read+write PM-tool entry and nothing else; the
// brief says its writes are held; no skill marks a task done on inference.
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

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const skillsOnly = args.includes("--skills-only");

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const { PROJECT_MANAGER_AGENT: AGENT, PROJECT_MANAGER_SKILLS: SKILLS, PROJECT_MANAGER_MEMORIES: MEMORIES, PM_TOOL_SERVER } =
  await import("./src/seeds/project-manager.ts");
const { fillTemplate, undeclaredPlaceholders, unusedParameters, templatePlaceholders } =
  await import("../../apps/web/src/lib/skillPrompt.ts");

console.log(`— the definition: ${AGENT.name} —`);

check("the slug is the one the hand-typed agent already has", AGENT.slug === "project-manager");
check("four skills: standup, plan-this, weekly-status, work-log", SKILLS.length === 4, SKILLS.map((s) => s.slug).join(", "));
check(
  "slugs are unique, prefixed pm- and MCP-tool-safe",
  new Set(SKILLS.map((s) => s.slug)).size === SKILLS.length && SKILLS.every((s) => s.slug.startsWith("pm-") && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.slug)),
  SKILLS.map((s) => `hub_skill_${s.slug.replace(/-/g, "_")}`).join(", "),
);

for (const s of SKILLS) {
  const undeclared = undeclaredPlaceholders(s.promptTemplate, s.parameters);
  check(`${s.slug}: every {{placeholder}} has a parameter behind it`, undeclared.length === 0, undeclared.length ? `undeclared: ${undeclared.join(", ")}` : `${templatePlaceholders(s.promptTemplate).length} placeholders`);
  const unused = unusedParameters(s.promptTemplate, s.parameters);
  check(`${s.slug}: every parameter is referenced by the template`, unused.length === 0, unused.length ? `unused: ${unused.join(", ")}` : "");
  check(`${s.slug}: starts from the status digest, never the whole task list`, /pm_project_status/.test(s.promptTemplate) && !/pm_get_project\b[^\n]*(?!section)/.test(s.promptTemplate.replace(/pm_get_project\` only for the section/g, "")));
  // A template that holds the write surface carries the two prohibitions
  // with it; one that does not must not mention SQL at all.
  const writes = /pm_update_task\` \(status/.test(s.promptTemplate);
  check(
    `${s.slug}: ${writes ? "forbids SQL and a milestone move by proxy" : "does not mention SQL"}`,
    writes ? /never\s+propose reaching around a gap with SQL/.test(s.promptTemplate) && /not "moved" by shifting its tasks/.test(s.promptTemplate) : !/\bSQL\b/.test(s.promptTemplate),
  );
}

const [standup, plan, weekly, workLog] = SKILLS;
check("the standup fills with nothing given", !fillTemplate(standup.promptTemplate, standup.parameters, {}).error);
check("the standup changes nothing", /You change nothing in a standup/.test(standup.promptTemplate) && !/call \`pm_(create_task|update_task|add_note)/.test(standup.promptTemplate));
check("the weekly status fills with nothing given, so a schedule can run it", !fillTemplate(weekly.promptTemplate, weekly.parameters, {}).error);
check("the weekly status refuses an audience outside its options", Boolean(fillTemplate(weekly.promptTemplate, weekly.parameters, { audience: "press" }).error));
check("the weekly status changes nothing", /You change nothing in a status report/.test(weekly.promptTemplate));
const planFilled = fillTemplate(plan.promptTemplate, plan.parameters, { work: "Index the Teams notes into the knowledge base" });
check("plan-this carries the work and no leftover syntax", !planFilled.error && planFilled.prompt.includes("Index the Teams notes") && !planFilled.prompt.includes("{{"));
check("plan-this refuses to run without the work", Boolean(fillTemplate(plan.promptTemplate, plan.parameters, {}).error));
check("plan-this refuses an apply value it does not know", Boolean(fillTemplate(plan.promptTemplate, plan.parameters, { work: "x", apply: "force" }).error));
check("plan-this creates nothing unless told apply=create, and says each call is held", /If apply is `propose`[\s\S]*create nothing/.test(plan.promptTemplate) && /held for\s+a person's approval/.test(plan.promptTemplate));
const logFilled = fillTemplate(workLog.promptTemplate, workLog.parameters, { log: "Commits in this session (1):\n- abc1234 Add the thing" });
check("the work log carries the log and no leftover syntax", !logFilled.error && logFilled.prompt.includes("abc1234 Add the thing") && !logFilled.prompt.includes("{{"));
check("the work log refuses to run without a log", Boolean(fillTemplate(workLog.promptTemplate, workLog.parameters, {}).error));
check(
  "the work log marks done only on merged/shipped/verified, never on a mention or a branch",
  /Never mark done on a commit that only says "start", "wip" or "draft"/.test(workLog.promptTemplate) && /A branch that is not the default branch means the work is not yet\nmerged/.test(workLog.promptTemplate),
);
check("the work log ends by pointing at /approvals", /proposals wait on \/approvals/.test(workLog.promptTemplate));

console.log("\n— discretion —");

const servers = (AGENT.mcpServers ?? []).map((s) => s.name);
check("the agent holds the read+write PM-tool entry and nothing else", servers.length === 1 && servers[0] === PM_TOOL_SERVER, servers.join(", "));
check("the brief says every write is held for a person", /held for a person's approval/.test(AGENT.instructions ?? ""));
check("the brief forbids marking done on inference and inventing dates or owners", /Never mark a task done/.test(AGENT.instructions ?? "") && /Never invent a date or an owner/.test(AGENT.instructions ?? ""));
check("it lives in both places", AGENT.placement === "both");
check("it reads the filed meeting notes and nothing wider", AGENT.knowledgeAll === false && (AGENT.knowledgeCollections ?? []).join() === "meetings");
check("tool-use rounds are raised above the default of 10", (AGENT.maxIterations ?? 0) > 10 && (AGENT.maxIterations ?? 0) <= 100, String(AGENT.maxIterations));

console.log("\n— the induction pack —");

const keys = MEMORIES.map((m) => m.key);
check("memory keys are unique", new Set(keys).size === keys.length, keys.join(", "));
check("no memory stores anything the tools can fetch live", !MEMORIES.some((m) => /\bca4749f1-|\bct_[a-z0-9]{7}\b|\bt_[a-z0-9]{7}\b/.test(m.content)));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error("refusing to provision — fix the definition first");
  process.exit(1);
}
if (checkOnly) {
  console.log("--check: database untouched");
  process.exit(0);
}

// ── provision ────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}

const { remoteServerNames, BUILTIN_SERVER_NAMES } = await import("@ai-hub/mcp");
const declared = new Set([...BUILTIN_SERVER_NAMES, ...remoteServerNames(), "memory"]);
const missingServers = servers.filter((n) => !declared.has(n));
if (missingServers.length) {
  console.log(`\nWARNING  this environment does not declare: ${missingServers.join(", ")}`);
  console.log("         A run here would say so and run without it. Declare it in HUB_REMOTE_MCP_SERVERS");
  console.log("         wherever the agent actually runs.");
}

const { getAgent, createAgent, updateAgent, listMemories, rememberMemory } = await import("./src/agents.ts");
const { getSkill, createSkill, updateSkill } = await import("./src/skills.ts");
const { getSql } = await import("./src/client.ts");

console.log("\n— provisioning —");

const existing = await getAgent(AGENT.slug);
if (skillsOnly && !existing) {
  console.error(`--skills-only: no agent "${AGENT.slug}" exists yet — run without the flag first.`);
  process.exit(1);
}
const agent = skillsOnly ? existing : existing ? await updateAgent(existing.id, AGENT) : await createAgent(AGENT);
console.log(`${skillsOnly ? "kept   " : existing ? "updated" : "created"}  agent   ${agent.slug}  (${agent.id})`);

for (const s of SKILLS) {
  const found = await getSkill(s.slug);
  if (found && found.agentId !== agent.id) {
    console.error(`\nskill "${s.slug}" already belongs to a different agent (${found.agentSlug}).`);
    console.error("Slugs are globally unique because they become MCP tool names.");
    process.exit(1);
  }
  const saved = found ? await updateSkill(found.id, { ...s, agentId: agent.id }) : await createSkill({ ...s, agentId: agent.id });
  console.log(`${found ? "updated" : "created"}  skill   ${saved.slug}  (${saved.parameters.length} parameters)`);
}

const before = new Set((await listMemories(agent.id)).map((m) => m.key));
for (const m of skillsOnly ? [] : MEMORIES) {
  await rememberMemory(agent.id, m.key, m.content);
  console.log(`${before.has(m.key) ? "updated" : "created"}  memory  ${m.key}`);
}
const kept = [...before].filter((k) => !MEMORIES.some((m) => m.key === k));
if (kept.length) console.log(`kept     ${kept.length} memor${kept.length === 1 ? "y" : "ies"} the agent already had: ${kept.join(", ")}`);

await getSql().end({ timeout: 5 });
console.log("\ndone");
process.exit(0);
