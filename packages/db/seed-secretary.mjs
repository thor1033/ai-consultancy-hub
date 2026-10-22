// Provision the Secretary — agent, skill and induction memories — from the
// definition in src/seeds/secretary.ts.
//
//   node packages/db/seed-secretary.mjs --check              # no DB, no network
//   node --env-file=apps/web/.env.local packages/db/seed-secretary.mjs
//
// Idempotent: the agent is matched by slug, the skill by slug and the memories
// by key, so re-running corrects the row rather than adding a second one. That
// is what makes this deployable — the same command provisions a laptop and
// production, and running it twice is not a mistake.
//
// The checks are NOT optional. They run before anything touches the database
// and refuse to provision if they fail, because the failure they catch is
// silent: a `{{placeholder}}` with no parameter behind it renders as the
// literal text "{{transcript}}" to the model, which treats it as content and
// answers confidently about a meeting it was never given.
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

const checkOnly = process.argv.includes("--check");

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const { SECRETARY_AGENT, SECRETARY_SKILLS, SECRETARY_MEMORIES, PM_TOOL_READ_SERVER } =
  await import("./src/seeds/secretary.ts");

// The real filler the hub will use on this template, imported rather than
// re-implemented: a second copy of the placeholder regex is exactly the thing
// that drifts and takes the guarantee with it.
const { fillTemplate, undeclaredPlaceholders, unusedParameters, templatePlaceholders } =
  await import("../../apps/web/src/lib/skillPrompt.ts");

console.log("— the definition —");

const skill = SECRETARY_SKILLS[0];

check("exactly one skill is defined", SECRETARY_SKILLS.length === 1);
check(
  "the skill's slug is MCP-tool-safe",
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.slug),
  `hub_skill_${skill.slug.replace(/-/g, "_")}`,
);

const undeclared = undeclaredPlaceholders(skill.promptTemplate, skill.parameters);
check(
  "every {{placeholder}} has a parameter behind it",
  undeclared.length === 0,
  undeclared.length ? `undeclared: ${undeclared.join(", ")}` : `${templatePlaceholders(skill.promptTemplate).length} placeholders`,
);

const unused = unusedParameters(skill.promptTemplate, skill.parameters);
check(
  "every parameter is referenced by the template",
  unused.length === 0,
  unused.length ? `unused: ${unused.join(", ")}` : "",
);

// A filled prompt must contain the caller's words and no leftover syntax.
const filled = fillTemplate(skill.promptTemplate, skill.parameters, {
  transcript: "00:01:02 Thor: vi flytter milepælen til slut oktober",
  meetingDate: "2026-09-20",
  attendees: "Thor Bøje Simonsen (CTO), Ditlev Brygmann (CEO)",
});
check("a filled template produces a prompt", !filled.error, filled.error ?? "");
check(
  "the transcript reaches the prompt",
  !filled.error && filled.prompt.includes("vi flytter milepælen"),
);
check(
  "an omitted optional parameter leaves no literal {{focus}}",
  !filled.error && !filled.prompt.includes("{{"),
);
check(
  "the meeting date is substituted in both places it appears",
  !filled.error && filled.prompt.split("2026-09-20").length - 1 >= 2,
);

// The required half. A model that omits the transcript must be refused, not
// handed a template with a hole in it.
for (const missing of ["transcript", "meetingDate"]) {
  const args = { transcript: "t", meetingDate: "2026-09-20" };
  delete args[missing];
  const res = fillTemplate(skill.promptTemplate, skill.parameters, args);
  check(`omitting "${missing}" is refused`, Boolean(res.error), res.error ?? "no error raised");
}

console.log("\n— discretion —");

const servers = (SECRETARY_AGENT.mcpServers ?? []).map((s) => s.name);
check(
  "the agent holds the read-scoped PM-tool server",
  servers.includes(PM_TOOL_READ_SERVER),
  servers.join(", ") || "none",
);
check(
  "the agent does NOT hold the read+write `pm-tool` server",
  !servers.includes("pm-tool"),
  "write tools must be absent from its tool list, not forbidden in prose",
);
const mailboxEntry = (SECRETARY_AGENT.mcpServers ?? []).find((s) => s.name === "microsoft365");
check(
  "the agent reads its own shared mailbox, named on its entry",
  typeof mailboxEntry?.mailbox === "string" && /^secretary@/.test(mailboxEntry.mailbox),
  mailboxEntry?.mailbox ?? "no mailbox",
);
check(
  "the brief says it proposes rather than applies",
  /propose/i.test(SECRETARY_AGENT.instructions ?? ""),
);
check(
  "every proposed row starts unapproved",
  skill.promptTemplate.includes('"decision": "pending"') &&
    skill.promptTemplate.includes("you do not approve your own proposals"),
);
check(
  "tool-use rounds are raised above the default of 10",
  (SECRETARY_AGENT.maxIterations ?? 0) > 10 && (SECRETARY_AGENT.maxIterations ?? 0) <= 100,
  String(SECRETARY_AGENT.maxIterations),
);

console.log("\n— the induction pack —");

const keys = SECRETARY_MEMORIES.map((m) => m.key);
check("memory keys are unique", new Set(keys).size === keys.length, keys.join(", "));
check(
  "no memory stores anything the tools can fetch live",
  !SECRETARY_MEMORIES.some((m) => /\bca4749f1-|\bct_[a-z0-9]{7}\b/.test(m.content)),
  "ids belong in the skill's reference, which is edited in one place",
);

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

// Does the environment being provisioned actually declare the servers this
// agent names? runSession filters an unknown server name out of the run
// SILENTLY — deliberately, because that is also how the /admin kill switch
// disables one. The cost is that a secretary whose `pm-tool-read` was never
// declared does not fail: it runs with memory alone and writes a fluent,
// completely ungrounded change set. So warn here, where someone is looking.
//
// A warning and not a failure on purpose: production's DB is provisioned from
// a laptop whose HUB_REMOTE_MCP_SERVERS is not the one Fly holds, so the
// absence of a server here proves nothing about the deployment.
const { remoteServerNames, BUILTIN_SERVER_NAMES } = await import("@ai-hub/mcp");
const declared = new Set([...BUILTIN_SERVER_NAMES, ...remoteServerNames(), "sample", "memory"]);

// microsoft365 fails the OTHER way. An undeclared remote server is skipped
// silently; a bundled server whose credentials are missing refuses to START,
// and connectMcpServers then fails the whole run. So a secretary provisioned
// before the deployment holds the M365_* secrets cannot run at all, not even
// for PM-tool work. Same caveat as above: this environment is not Fly's.
const m365Missing = ["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET"].filter((k) => !process.env[k]);
if (mailboxEntry && m365Missing.length) {
  console.warn(
    `warning: the agent names microsoft365 but this environment lacks ${m365Missing.join(", ")} — ` +
      "every run of this agent fails until the deployment it runs on has them.",
  );
}
const missingServers = (SECRETARY_AGENT.mcpServers ?? [])
  .map((s) => s.name)
  .filter((n) => !declared.has(n));
if (missingServers.length) {
  console.log(`\nWARNING  this environment does not declare: ${missingServers.join(", ")}`);
  console.log("         A run here would drop it silently and ground the change set");
  console.log("         on nothing. Declare it in HUB_REMOTE_MCP_SERVERS wherever the");
  console.log("         agent actually runs, then re-check with hub_list_agents.");
}

const { getAgent, createAgent, updateAgent, listMemories, rememberMemory } =
  await import("./src/agents.ts");
const { getSkill, createSkill, updateSkill } = await import("./src/skills.ts");
const { getSql } = await import("./src/client.ts");

console.log("\n— provisioning —");

const existing = await getAgent(SECRETARY_AGENT.slug);
const agent = existing
  ? await updateAgent(existing.id, SECRETARY_AGENT)
  : await createAgent(SECRETARY_AGENT);
console.log(`${existing ? "updated" : "created"}  agent   ${agent.slug}  (${agent.id})`);

for (const s of SECRETARY_SKILLS) {
  const found = await getSkill(s.slug);
  if (found && found.agentId !== agent.id) {
    console.error(
      `\nskill "${s.slug}" already belongs to a different agent (${found.agentSlug}).`,
    );
    console.error("Slugs are globally unique because they become MCP tool names.");
    process.exit(1);
  }
  const saved = found
    ? await updateSkill(found.id, { ...s, agentId: agent.id })
    : await createSkill({ ...s, agentId: agent.id });
  console.log(`${found ? "updated" : "created"}  skill   ${saved.slug}  (${saved.parameters.length} parameters)`);
}

const before = new Set((await listMemories(agent.id)).map((m) => m.key));
for (const m of SECRETARY_MEMORIES) {
  await rememberMemory(agent.id, m.key, m.content);
  console.log(`${before.has(m.key) ? "updated" : "created"}  memory  ${m.key}`);
}

// Both pools: the store's shared one and nothing else here opens another.
await getSql().end({ timeout: 5 });
console.log("\ndone");
process.exit(0);
