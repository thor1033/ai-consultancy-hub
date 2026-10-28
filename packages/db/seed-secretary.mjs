// Provision the Secretary — agent, skill and induction memories — from the
// definition in src/seeds/secretary.ts.
//
//   node packages/db/seed-secretary.mjs --check              # no DB, no network
//   node --env-file=apps/web/.env.local packages/db/seed-secretary.mjs
//   node --env-file=apps/web/.env.local packages/db/seed-secretary.mjs --skills-only   # skills only; agent row and memories untouched
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

const { SECRETARY_AGENT, SECRETARY_SKILLS, SECRETARY_MEMORIES, PM_TOOL_SERVER, TEAMS_SERVER, TEAMS_NOTES_SERVER, FOLLOWUP_LEDGER_KEY } =
  await import("./src/seeds/secretary.ts");

// The real filler the hub will use on this template, imported rather than
// re-implemented: a second copy of the placeholder regex is exactly the thing
// that drifts and takes the guarantee with it.
const { fillTemplate, undeclaredPlaceholders, unusedParameters, templatePlaceholders } =
  await import("../../apps/web/src/lib/skillPrompt.ts");

console.log("— the definition —");

const skill = SECRETARY_SKILLS.find((s) => s.slug === "meeting-to-pm");
const prep = SECRETARY_SKILLS.find((s) => s.slug === "meeting-prep");
const followup = SECRETARY_SKILLS.find((s) => s.slug === "meeting-followup");

check("the three skills are defined: the change set, the brief and the follow-up", Boolean(skill) && Boolean(prep) && Boolean(followup) && SECRETARY_SKILLS.length === 3);
check(
  "slugs are unique and MCP-tool-safe",
  new Set(SECRETARY_SKILLS.map((s) => s.slug)).size === SECRETARY_SKILLS.length &&
    SECRETARY_SKILLS.every((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.slug)),
  SECRETARY_SKILLS.map((s) => `hub_skill_${s.slug.replace(/-/g, "_")}`).join(", "),
);

for (const s of SECRETARY_SKILLS) {
  const undeclared = undeclaredPlaceholders(s.promptTemplate, s.parameters);
  check(
    `${s.slug}: every {{placeholder}} has a parameter behind it`,
    undeclared.length === 0,
    undeclared.length ? `undeclared: ${undeclared.join(", ")}` : `${templatePlaceholders(s.promptTemplate).length} placeholders`,
  );
  const unused = unusedParameters(s.promptTemplate, s.parameters);
  check(
    `${s.slug}: every parameter is referenced by the template`,
    unused.length === 0,
    unused.length ? `unused: ${unused.join(", ")}` : "",
  );
}

// The brief is the skill a morning schedule runs with only `day` supplied.
const prepFilled = fillTemplate(prep.promptTemplate, prep.parameters, { day: "today" });
check("the brief fills with only the day given", !prepFilled.error && prepFilled.prompt.includes("for: today") && !prepFilled.prompt.includes("{{"), prepFilled.error ?? "");
check("the brief refuses to run without a day", Boolean(fillTemplate(prep.promptTemplate, prep.parameters, {}).error));

// The follow-up is the skill an hourly schedule runs with nothing supplied.
const followupFilled = fillTemplate(followup.promptTemplate, followup.parameters, {});
check("the follow-up fills with nothing given, so a schedule can run it", !followupFilled.error && !followupFilled.prompt.includes("{{"), followupFilled.error ?? "");
check("the follow-up reads the whole transcript, page by page", /keep calling it with\nthe offset/.test(followup.promptTemplate));
check("the follow-up keeps a ledger so an hourly run never proposes a change twice", followup.promptTemplate.split(FOLLOWUP_LEDGER_KEY).length - 1 >= 2 && /Keep the newest fifty/.test(followup.promptTemplate));
check("the follow-up waits 45 minutes after a meeting ends", /at least 45 minutes ago/.test(followup.promptTemplate));
check("an empty hour costs nothing: no memory write, no other tool", /Write no memory and call\nno other tool/.test(followup.promptTemplate));
check("the follow-up says every write is held, and proposes through the tools", /each call is held for approval/.test(followup.promptTemplate) && /pm_update_task/.test(followup.promptTemplate) && /teams_notes_save/.test(followup.promptTemplate));
check("the follow-up never marks done, never invents a date or an owner", /Never mark a task done/.test(followup.promptTemplate) && /Never invent a date or an owner/.test(followup.promptTemplate));
check("the change set still calls no write tool: that path is reviewed in Claude Code", /call no write tool in this\nskill/.test(skill.promptTemplate));
check(
  "the brief reads, and says it cannot act",
  /m365_calendar_list/.test(prep.promptTemplate) && /Do not act/.test(prep.promptTemplate) && !/m365_(send|create|accept)/.test(prep.promptTemplate),
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
  "the agent holds the read+write PM-tool server, the transcripts and the notes",
  servers.includes(PM_TOOL_SERVER) && servers.includes(TEAMS_SERVER) && servers.includes(TEAMS_NOTES_SERVER) && !servers.includes("pm-tool-read"),
  servers.join(", ") || "none",
);
// The gate is what makes "proposes, never applies" true now that the
// credential can write: an entry that said "writes": "allow" would let the
// Secretary change the board in the middle of its own tool loop.
check(
  "no entry switches the approval gate off: every write is held",
  (SECRETARY_AGENT.mcpServers ?? []).every((s) => s.writes !== "allow"),
  "lib/approvals.ts holds anything not marked readOnlyHint unless an entry says writes: allow",
);
const mailboxEntry = (SECRETARY_AGENT.mcpServers ?? []).find((s) => s.name === "microsoft365");
check(
  "the agent reads its own shared mailbox, named on its entry",
  typeof mailboxEntry?.mailbox === "string" && /^secretary@/.test(mailboxEntry.mailbox),
  mailboxEntry?.mailbox ?? "no mailbox",
);
check(
  "the brief says it proposes rather than applies, and that its writes are held",
  /propose/i.test(SECRETARY_AGENT.instructions ?? "") && /held on \/approvals/.test(SECRETARY_AGENT.instructions ?? ""),
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
const declared = new Set([...BUILTIN_SERVER_NAMES, ...remoteServerNames(), "memory"]);

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
  console.log("         A run here would say so and run without it. Declare it in");
  console.log("         HUB_REMOTE_MCP_SERVERS wherever the agent actually runs.");
}

const { getAgent, createAgent, updateAgent, listMemories, rememberMemory } =
  await import("./src/agents.ts");
const { getSkill, createSkill, updateSkill } = await import("./src/skills.ts");
const { getSql } = await import("./src/client.ts");

console.log("\n— provisioning —");

// --skills-only adds or refreshes the skills and leaves the agent row and the
// memories alone. The full seed rewrites the agent from this file, which is
// right for a first install and wrong for a deployment where someone has since
// changed its placement, knowledge scope or mailbox in /agents.
const skillsOnly = process.argv.includes("--skills-only");

const existing = await getAgent(SECRETARY_AGENT.slug);
if (skillsOnly && !existing) {
  console.error(`--skills-only: no agent "${SECRETARY_AGENT.slug}" exists yet — run without the flag first.`);
  process.exit(1);
}
// An existing row keeps what a deployment tuned on the agent's page — model,
// effort, knowledge scope, placement — and takes from the definition only what
// the definition owns: the brief, the servers, the stamina, its place on the
// org chart. updateAgent leaves an omitted field alone, so that is a matter of
// what is passed.
const { slug, name, description, instructions, mcpServers, maxIterations, functionName, owner } = SECRETARY_AGENT;
const agent = skillsOnly
  ? existing
  : existing
    ? await updateAgent(existing.id, { slug, name, description, instructions, mcpServers, maxIterations, functionName, owner })
    : await createAgent(SECRETARY_AGENT);
console.log(`${skillsOnly ? "kept   " : existing ? "updated" : "created"}  agent   ${agent.slug}  (${agent.id})`);

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
for (const m of skillsOnly ? [] : SECRETARY_MEMORIES) {
  await rememberMemory(agent.id, m.key, m.content);
  console.log(`${before.has(m.key) ? "updated" : "created"}  memory  ${m.key}`);
}

// Both pools: the store's shared one and nothing else here opens another.
await getSql().end({ timeout: 5 });
console.log("\ndone");
process.exit(0);
