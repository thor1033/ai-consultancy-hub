// Provision the Context Steward — agent and induction memory — from the
// definition in src/seeds/context-steward.ts.
//
//   node --experimental-transform-types packages/db/seed-context-steward.mjs --check   # no DB
//   node --experimental-transform-types --env-file=apps/web/.env.local packages/db/seed-context-steward.mjs
//
// Idempotent: the agent by slug, each memory by key. An existing row keeps
// what a deployment tuned on the agent's page (model, effort) and takes from
// the definition what the definition owns: the brief, the server, the stamina,
// its place on the org chart. A memory the steward has since written (its
// sweep ledger) is never overwritten by the seed.
//
// The checks run first and refuse to provision on failure. The one that
// matters: the steward holds the knowledge server with NO "writes": "allow",
// so every proposal it makes is held for a person.
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

const { CONTEXT_STEWARD_AGENT: AGENT, CONTEXT_STEWARD_MEMORIES: MEMORIES, KNOWLEDGE_SERVER, STEWARD_SLUG, SWEEP_KEY, PROPOSED_KEY } =
  await import("./src/seeds/context-steward.ts");

console.log(`— the definition: ${AGENT.name} —`);
check("the slug is the one the knowledge server excludes from its own reading", AGENT.slug === STEWARD_SLUG && STEWARD_SLUG === "context-steward");
check("it holds the knowledge server and nothing else", AGENT.mcpServers?.length === 1 && AGENT.mcpServers[0].name === KNOWLEDGE_SERVER);
check(
  "and no entry lets it write without approval",
  (AGENT.mcpServers ?? []).every((e) => e.writes !== "allow"),
);
check("the brief says every write is a proposal a founder approves", /proposal that waits in\nthe approvals queue/.test(AGENT.instructions) && /do\nnot write any of it yourself/.test(AGENT.instructions));
check("the brief names the five kinds and nothing broader", /Only these five/.test(AGENT.instructions) && /recurring question/.test(AGENT.instructions));
check("it refuses restricted → open and chat → unreadable, in the brief as well as the tool", /restricted collection goes into an open one/.test(AGENT.instructions) && /only where that person may read/.test(AGENT.instructions));
check("it is told to check knowledge_find before every proposal", /knowledge_find, before every proposal/.test(AGENT.instructions));
check("its ledger keys are in the brief", AGENT.instructions.includes(SWEEP_KEY) && AGENT.instructions.includes(PROPOSED_KEY));
check("it sits in the Office of the founders, reporting to Ditlev", AGENT.functionName === "Office of the founders" && AGENT.owner === "Ditlev Brygmann");
check("it runs on the hub, not as a Claude Code sub-agent", AGENT.placement === "hub");
check("no schedule is seeded (a person owns the nightly sweep)", !("schedules" in AGENT));
check("the induction memory is only the empty ledger", MEMORIES.length === 1 && MEMORIES[0].key === PROPOSED_KEY);

const failedChecks = checks.filter((c) => !c.ok);
if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) failed — not provisioning.`);
  process.exit(1);
}
if (checkOnly) {
  console.log(`\nDefinition OK (${checks.length} checks). --check: nothing written.`);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is not set.");
  process.exit(1);
}

const { getAgent, createAgent, updateAgent, listMemories, rememberMemory } = await import("./src/agents.ts");
const { getSql } = await import("./src/client.ts");

const existing = await getAgent(AGENT.slug);
const { slug, name, description, instructions, mcpServers, maxIterations, functionName, owner } = AGENT;
const agent = existing
  ? await updateAgent(existing.id, { slug, name, description, instructions, mcpServers, maxIterations, functionName, owner })
  : await createAgent(AGENT);
console.log(`\n${existing ? "updated" : "created"}  agent   ${agent.slug}  (${agent.id})`);

// The ledger is seeded once: a steward that has swept has a better one.
const have = new Set((await listMemories(agent.id)).map((m) => m.key));
for (const m of MEMORIES) {
  if (have.has(m.key)) {
    console.log(`kept     memory  ${m.key}`);
    continue;
  }
  await rememberMemory(agent.id, m.key, m.content);
  console.log(`created  memory  ${m.key}`);
}

const missing = ["HUB_STEWARD_READERS", "HUB_STEWARD_TOKEN", "HUB_BASE_URL"].filter((k) => !process.env[k]);
if (missing.length) {
  console.log(`\nWARNING  this environment lacks ${missing.join(", ")}.`);
  console.log("         The steward can be ticked and will start, but its chat tools answer");
  console.log("         'no readers' and its proposals cannot file until the deployment that");
  console.log("         runs it holds them. See docs/context-steward.md.");
}

console.log("\nNext: on the agent's page, add a nightly schedule owned by a founder, e.g.");
console.log('      "Sweep what is new since your last sweep and propose what should be kept."');
await getSql().end({ timeout: 5 });
