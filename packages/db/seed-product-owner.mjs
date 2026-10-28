// Provision a Product Owner — agent, skills and induction memories — from the
// product definition in src/seeds/product-owner.ts.
//
//   node packages/db/seed-product-owner.mjs --product hub --check         # no DB, no network
//   node --env-file=apps/web/.env.local packages/db/seed-product-owner.mjs --product hub
//   node --env-file=apps/web/.env.local packages/db/seed-product-owner.mjs --product hub --skills-only
//
// Idempotent, like seed-secretary.mjs: the agent is matched by slug, each skill
// by slug and each memory by key, so re-running corrects rather than duplicates.
//
// The checks run before anything touches the database and refuse to provision
// if they fail. The ones that matter most are about discretion: this agent is
// given only servers that cannot write, and a definition that slipped the
// read+write `pm-tool` in would make "the product owner changes nothing" a
// sentence instead of a property.
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
const productKey = args[args.indexOf("--product") + 1];

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const { PRODUCTS, productOwnerAgent, productOwnerSkills, productOwnerMemories, GITHUB_SERVER, PM_TOOL_READ_SERVER } =
  await import("./src/seeds/product-owner.ts");

if (!args.includes("--product") || !PRODUCTS[productKey]) {
  console.error(`Say which product: --product <${Object.keys(PRODUCTS).join("|")}>`);
  process.exit(1);
}
const product = PRODUCTS[productKey];
const AGENT = productOwnerAgent(product);
const SKILLS = productOwnerSkills(product);
const MEMORIES = productOwnerMemories(product);

// The real filler the hub uses, imported rather than re-implemented.
const { fillTemplate, undeclaredPlaceholders, unusedParameters, templatePlaceholders } =
  await import("../../apps/web/src/lib/skillPrompt.ts");

console.log(`— the definition: ${AGENT.name} —`);

check("the product names a repository as owner/name", /^[\w.-]+\/[\w.-]+$/.test(product.repo), product.repo);
check("its collection is a slug the github source can file into", /^[a-z0-9]+(-[a-z0-9]+)*$/.test(product.collection), product.collection);
check("the agent's slug follows the product key", AGENT.slug === `product-owner-${product.key}`, AGENT.slug);
check("four skills: overview, fit, release notes, triage", SKILLS.length === 4, SKILLS.map((s) => s.slug).join(", "));
check(
  "slugs are unique, prefixed by the product and MCP-tool-safe",
  new Set(SKILLS.map((s) => s.slug)).size === SKILLS.length && SKILLS.every((s) => s.slug.startsWith(`${product.key}-`) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.slug)),
  SKILLS.map((s) => `hub_skill_${s.slug.replace(/-/g, "_")}`).join(", "),
);

for (const s of SKILLS) {
  const undeclared = undeclaredPlaceholders(s.promptTemplate, s.parameters);
  check(
    `${s.slug}: every {{placeholder}} has a parameter behind it`,
    undeclared.length === 0,
    undeclared.length ? `undeclared: ${undeclared.join(", ")}` : `${templatePlaceholders(s.promptTemplate).length} placeholders`,
  );
  const unused = unusedParameters(s.promptTemplate, s.parameters);
  check(`${s.slug}: every parameter is referenced by the template`, unused.length === 0, unused.length ? `unused: ${unused.join(", ")}` : "");
  check(`${s.slug}: the template tells it which tools are the truth about what`, /pm_project_status/.test(s.promptTemplate) && /get_file_contents|list_pull_requests|list_issues/.test(s.promptTemplate));
  check(`${s.slug}: no tool that writes is named`, !/pm_create_task|pm_update_task|pm_add_note|create_or_update_file|push_files|create_pull_request/.test(s.promptTemplate));
}

const [overview, fit, notes, triage] = SKILLS;
const overviewFilled = fillTemplate(overview.promptTemplate, overview.parameters, { audience: "founders" });
check("the overview fills with only the audience given", !overviewFilled.error && overviewFilled.prompt.includes("for: founders") && !overviewFilled.prompt.includes("{{"), overviewFilled.error ?? "");
check("the overview refuses an audience outside its options", Boolean(fillTemplate(overview.promptTemplate, overview.parameters, { audience: "press" }).error));
check("the overview refuses to run without an audience", Boolean(fillTemplate(overview.promptTemplate, overview.parameters, {}).error));
const fitFilled = fillTemplate(fit.promptTemplate, fit.parameters, { request: "Let the Secretary book meetings from the hub" });
check("the fit judgement carries the request and no leftover syntax", !fitFilled.error && fitFilled.prompt.includes("book meetings") && !fitFilled.prompt.includes("{{"));
check("and refuses to run without a request", Boolean(fillTemplate(fit.promptTemplate, fit.parameters, {}).error));
check("the fit judgement names the four verdicts", ["Already exists", "Fits", "Fits with changes", "Does not belong"].every((v) => fit.promptTemplate.includes(`**${v}**`)));
const notesFilled = fillTemplate(notes.promptTemplate, notes.parameters, { since: "2026-10-01" });
check("release notes substitute the date everywhere it appears", !notesFilled.error && notesFilled.prompt.split("2026-10-01").length - 1 >= 2 && !notesFilled.prompt.includes("{{"));
check("release notes count only what merged to the default branch", new RegExp(`merged to ${product.defaultBranch}`).test(notes.promptTemplate) && /Do not list an\nopen pull request as shipped/.test(notes.promptTemplate));
check("triage fills with nothing given", !fillTemplate(triage.promptTemplate, triage.parameters, {}).error);
check("triage ends by saying who makes each change", /You move nothing/.test(triage.promptTemplate));

console.log("\n— discretion —");

const servers = (AGENT.mcpServers ?? []).map((s) => s.name);
check("the agent holds GitHub and the read-scoped PM-tool server", servers.includes(GITHUB_SERVER) && servers.includes(PM_TOOL_READ_SERVER), servers.join(", "));
check("and nothing else — in particular not the read+write `pm-tool`", servers.length === 2 && !servers.includes("pm-tool"), "write tools must be absent from its tool list, not forbidden in prose");
check("the brief says it changes nothing", /change nothing|changes nothing/i.test(AGENT.instructions ?? ""));
check("it reads its own product's record and the meeting notes, nothing wider", AGENT.knowledgeAll === false && AGENT.knowledgeCollections?.length === 2 && AGENT.knowledgeCollections.includes(product.collection) && AGENT.knowledgeCollections.includes("meetings"), (AGENT.knowledgeCollections ?? []).join(", "));
check("it lives in both places, so it is a sub-agent while the code is being written", AGENT.placement === "both");
check("tool-use rounds are raised above the default of 10", (AGENT.maxIterations ?? 0) > 10 && (AGENT.maxIterations ?? 0) <= 100, String(AGENT.maxIterations));
check("every principle is in the brief, so a judgement can name it", product.principles.every((p) => (AGENT.instructions ?? "").includes(p)), `${product.principles.length} principles`);

console.log("\n— the induction pack —");

const keys = MEMORIES.map((m) => m.key);
check("memory keys are unique", new Set(keys).size === keys.length, keys.join(", "));
check(
  "no memory stores anything the tools can fetch live",
  !MEMORIES.some((m) => /\bca4749f1-|\bct_[a-z0-9]{7}\b|#\d{2,}/.test(m.content)),
  "ids belong in the skill's reference, which is edited in one place",
);
check("the principles memory matches the brief", MEMORIES.find((m) => m.key === "product-principles")?.content.includes("The hub stays generic") === product.principles.some((p) => p.includes("The hub stays generic")));

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

// Same warnings as the Secretary's seed, for the same reason: runSession drops
// an undeclared server name silently, and a product owner without GitHub
// answers from the index alone and presents it as the present. This
// environment is not necessarily the one the agent runs on, so warn, don't fail.
const { remoteServerNames, BUILTIN_SERVER_NAMES } = await import("@ai-hub/mcp");
const declared = new Set([...BUILTIN_SERVER_NAMES, ...remoteServerNames(), "memory"]);
const missingServers = servers.filter((n) => !declared.has(n));
if (missingServers.length) {
  console.log(`\nWARNING  this environment does not declare: ${missingServers.join(", ")}`);
  console.log("         A run here would drop it silently. Declare it in HUB_REMOTE_MCP_SERVERS");
  console.log("         wherever the agent actually runs (docs/github.md), then re-check with hub_list_agents.");
}
// The knowledge half fails the quiet way too: an agent scoped to a collection
// nobody has synced retrieves nothing and does not say so.
const { listSources } = await import("@ai-hub/rag");
const source = listSources().find((s) => s.type === `github:${product.key}`);
if (!source) {
  console.log(`\nWARNING  no "github:${product.key}" knowledge source is declared here (HUB_GITHUB_SOURCES).`);
  console.log(`         Until one is, and is synced from /knowledge, the "${product.collection}" collection is empty.`);
} else if (!source.configured) {
  console.log(`\nWARNING  the "github:${product.key}" source is declared but GITHUB_TOKEN is not set here.`);
}

const { applySeed } = await import("./src/seeds/apply.ts");
const { getSql } = await import("./src/client.ts");

console.log("\n— provisioning —");

// The same rules every release applies (src/seeds/apply.ts): what the code
// set last time is recorded, and a field a person or the agent changed since
// is kept rather than overwritten. Running this by hand and deploying can
// never disagree. --skills-only refreshes the skills and nothing else.
await applySeed({ agent: AGENT, skills: SKILLS, memories: MEMORIES }, { skillsOnly, log: (line) => console.log(line) });

await getSql().end({ timeout: 5 });
console.log("\ndone");
process.exit(0);
