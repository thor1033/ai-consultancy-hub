// Provision the BMAD planning roles (Analyst, PM, Architect) from the
// definitions in src/seeds/bmad.ts.
//
//   node --experimental-transform-types packages/db/seed-bmad.mjs --check   # no DB
//   node --experimental-transform-types --env-file=apps/web/.env.local packages/db/seed-bmad.mjs
//
// In production this runs on every release (packages/db/release.mjs applies
// src/seeds/all.ts, which lists them). By hand it applies the same rules
// (src/seeds/apply.ts): a field a person changed on an agent's page since the
// last release is kept rather than overwritten.
//
// The checks run first and refuse to provision on failure. The ones that
// matter: the three draft and never write (no server that can write, and none
// marked "writes": "allow"), and their tool names are the ones Teqneo Code's
// skills call.
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
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

const { BMAD_AGENTS } = await import("./src/seeds/bmad.ts");
const { GITHUB_SERVER, PM_TOOL_READ_SERVER } = await import("./src/seeds/product-owner.ts");
const { SEEDS } = await import("./src/seeds/all.ts");

// The hub names an agent's tool hub_agent_<slug with - as _>; Teqneo Code's
// skills call exactly these.
const toolName = (slug) => `hub_agent_${slug.replace(/-/g, "_")}`;
const expected = ["hub_agent_bmad_analyst", "hub_agent_bmad_pm", "hub_agent_bmad_architect"];

console.log("— the definitions —");
check("three roles: Analyst, PM, Architect", BMAD_AGENTS.length === 3);
check(
  "their tools are the names Teqneo Code's skills call",
  BMAD_AGENTS.map((a) => toolName(a.slug)).join() === expected.join(),
  BMAD_AGENTS.map((a) => toolName(a.slug)).join(", "),
);
check(
  "they hold only read-only servers (the read-scoped PM tool, GitHub)",
  BMAD_AGENTS.every((a) => (a.mcpServers ?? []).every((e) => [PM_TOOL_READ_SERVER, GITHUB_SERVER].includes(e.name))),
);
check("and no entry lets one write without approval", BMAD_AGENTS.every((a) => (a.mcpServers ?? []).every((e) => e.writes !== "allow")));
check("they run on the hub, called from Teqneo Code", BMAD_AGENTS.every((a) => a.placement === "hub"));
check(
  "each brief says it drafts and never invents, and names its phase and file",
  BMAD_AGENTS.every((a) => /You draft;/.test(a.instructions) && /\*\*Never invent\*\*/.test(a.instructions) && /phase \d of BMAD/.test(a.instructions)),
);
check(
  "each brief asks for the hub search and cited sources",
  BMAD_AGENTS.every((a) => a.instructions.includes("hub_search_knowledge") && a.instructions.includes("Sources")),
);
check("all three are in the release list", expected.every((t) => SEEDS.some((s) => toolName(s.agent.slug) === t)));

// The skills that call them live in the Teqneo Code fork; when it sits beside
// this repository, check they name the same tools.
const forkSkills = new URL("../../../teqneo-code/teqneo/overrides/apps/web/src/teqneo/bmad/skills/", import.meta.url);
if (existsSync(fileURLToPath(forkSkills))) {
  for (const [file, tool] of [["bmad-analyst.md", expected[0]], ["bmad-pm.md", expected[1]], ["bmad-architect.md", expected[2]]]) {
    const text = readFileSync(fileURLToPath(new URL(file, forkSkills)), "utf8");
    check(`Teqneo Code's ${file} calls ${tool}`, text.includes(tool));
  }
} else {
  console.log("note  the Teqneo Code fork is not beside this repository; its skills were not compared");
}

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed — not provisioning.`);
  process.exit(1);
}
if (checkOnly) {
  console.log(`\nDefinitions OK (${checks.length} checks). --check: nothing written.`);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is not set.");
  process.exit(1);
}

const { applySeed } = await import("./src/seeds/apply.ts");
const { getSql } = await import("./src/client.ts");

console.log("\n— provisioning —");
for (const agent of BMAD_AGENTS) {
  await applySeed({ agent, skills: [], memories: [] }, { log: (line) => console.log(line) });
}
await getSql().end({ timeout: 5 });
