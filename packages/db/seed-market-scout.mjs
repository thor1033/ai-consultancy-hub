// Provision the Market Scout and the Market Reviewer — agents, skills and
// induction memories — from the definition in src/seeds/market-scout.ts.
//
//   node --experimental-transform-types packages/db/seed-market-scout.mjs --check   # no DB
//   node --experimental-transform-types --env-file=apps/web/.env.local packages/db/seed-market-scout.mjs
//
// In production this runs on every release (packages/db/release.mjs applies
// src/seeds/all.ts, which lists both). By hand it applies the same rules
// (src/seeds/apply.ts): what the code set last time is recorded, and a field
// a person changed on the agent's page since is kept rather than overwritten.
//
// The checks run first and refuse to provision on failure. The ones that
// matter: the Scout holds the web and the Reviewer, and nothing else; the
// Reviewer holds web fetch only and keeps no memory; every skill carries the
// sourcing standard as a check, so an invented company is caught.
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
const { MARKET_SCOUT_AGENT: SCOUT, MARKET_SCOUT_SKILLS: SKILLS, MARKET_SCOUT_MEMORIES: MEMORIES, MARKET_REVIEWER_AGENT: REVIEWER, SCOUT_SLUG, REVIEWER_SLUG, WEB_SERVER, SOURCING_STANDARD, REGISTER_PREFIX, POSITIONING_KEY, MARKET_COLLECTION } =
  await import("./src/seeds/market-scout.ts");
const { checkProblem } = await import("./src/checks.ts");
console.log(`— the definition: ${SCOUT.name} and ${REVIEWER.name} —`);
check("the Scout holds the web and may ask the Reviewer, and nothing else", SCOUT.mcpServers.length === 2 && SCOUT.mcpServers[0].name === WEB_SERVER && SCOUT.mcpServers[1].name === "agents" && SCOUT.mcpServers[1].agents.join() === REVIEWER_SLUG && WEB_SERVER === "web");
check("its web is bounded: a dozen searches and fetches a run", SCOUT.mcpServers[0].searches === 12 && SCOUT.mcpServers[0].fetches === 12);
check("no entry lets it write without approval", [...SCOUT.mcpServers, ...REVIEWER.mcpServers].every((e) => e.writes !== "allow"));
check("the Reviewer holds web fetch only, keeps no memory, and asks nobody", REVIEWER.mcpServers.length === 1 && REVIEWER.mcpServers[0].name === WEB_SERVER && REVIEWER.mcpServers[0].search === false && REVIEWER.keepsMemory === false);
check("the Reviewer runs on the cheaper model; the Scout on the deployment's default", REVIEWER.model === "claude-sonnet-4-6" && SCOUT.model === null);
check("the Scout remembers and reads the market collection only", SCOUT.keepsMemory === true && SCOUT.knowledgeAll === false && SCOUT.knowledgeCollections.join() === MARKET_COLLECTION);
check("the Scout's brief says every company and claim carries a URL, and what it could not find is said", /Every company named carries a URL/.test(SCOUT.instructions) && /Never fill a gap/.test(SCOUT.instructions));
check("it never invents, never reads our own site as evidence, never advises beyond the comparison", /never invent a company/.test(SCOUT.instructions) && /do not read our own site as evidence/.test(SCOUT.instructions) && /do not advise on pricing or strategy/.test(SCOUT.instructions));
check("it asks the Reviewer before delivering, and never drops a failed point", /Ask the Market Reviewer \(\{\{agent:market-reviewer\}\}\)/.test(SCOUT.instructions) && /Never drop a failed point silently/.test(SCOUT.instructions));
check("the brief names the register and the positioning keys, and says memory writes wait for a person", SCOUT.instructions.includes(REGISTER_PREFIX) && SCOUT.instructions.includes(POSITIONING_KEY) && /waits for a person's approval/.test(SCOUT.instructions));
check("the three verdict words are in the brief", /DISTINCT/.test(SCOUT.instructions) && /SHARED/.test(SCOUT.instructions) && /TABLE STAKES/.test(SCOUT.instructions));
check("the Reviewer's brief carries the standard, checks pages, and never adds research", REVIEWER.instructions.includes(SOURCING_STANDARD) && /Fetch each cited page/.test(REVIEWER.instructions) && /never add research of your own/.test(REVIEWER.instructions) && /^VERIFIED|VERIFIED if every point/.test(REVIEWER.instructions));
check("four skills: map, profile, check a claim, watch", SKILLS.map((s) => s.slug).join() === "market-map,competitor-profile,differentiation-check,market-watch");
check("every skill carries the sourcing standard as a judge check, and a length", SKILLS.every((s) => s.checks.some((c) => c.kind === "judge" && c.value.startsWith(SOURCING_STANDARD.split("\n")[0])) && s.checks.some((c) => c.kind === "maxWords")));
check("every check is one the hub can judge", SKILLS.every((s) => s.checks.every((c) => checkProblem(c) === null)));
check("every prompt's blanks are declared parameters", SKILLS.every((s) => [...s.promptTemplate.matchAll(/\{\{(\w+)\}\}/g)].every((m) => s.parameters.some((p) => p.name === m[1]))));
check("every skill asks the Reviewer before delivering", SKILLS.every((s) => /Market Reviewer check it/.test(s.promptTemplate)));
check("the map asks for four rings and what could not be found; the watch stops on an empty register", /Direct/.test(SKILLS[0].promptTemplate) && /Incumbents/.test(SKILLS[0].promptTemplate) && /What we could not find/.test(SKILLS[0].promptTemplate) && /If the register is empty, say so and\s+stop/.test(SKILLS[3].promptTemplate));
check("both sit in Strategy, reporting to Thor, on the hub", [SCOUT, REVIEWER].every((a) => a.functionName === "Strategy" && a.owner === "Thor Simonsen" && a.placement === "hub"));
check("no schedule is seeded (a person owns the weekly watch)", !("schedules" in SCOUT));
check("the induction memories are how to search and the register's format", MEMORIES.map((m) => m.key).join() === "how-i-search,register-format");
check("the slugs are the ones the briefs name", SCOUT.slug === SCOUT_SLUG && REVIEWER.slug === REVIEWER_SLUG);
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
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}
const { applySeed } = await import("./src/seeds/apply.ts");
const db = await import("./src/index.ts");
for (const seed of [
  { agent: REVIEWER, skills: [], memories: [] },
  { agent: SCOUT, skills: SKILLS, memories: MEMORIES },
]) {
  const out = await applySeed(seed, { log: (line) => console.log(line) });
  console.log(`${seed.agent.name}: agent ${out.agent}, ${out.skills.length} skills, ${out.memories.length} memories`);
}
await db.getSql().end({ timeout: 5 });
