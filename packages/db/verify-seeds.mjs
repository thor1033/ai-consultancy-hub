// Verification of applying seeds on release — src/seeds/apply.ts, the rules
// every deploy runs (release.mjs) and every hand-run seed-*.mjs shares.
//
//   node --experimental-transform-types --env-file=apps/web/.env.local packages/db/verify-seeds.mjs
//
// No API key. Every agent, skill, memory and seed_applied row is made under a
// throwaway slug and deleted at the end; the real seeded agents are not touched.
//
// The case that matters: a release must not undo what a person did on an
// agent's page, or what the agent learned, between two deploys — while still
// shipping every change to the code that nobody overrode.
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

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}

const { applySeed } = await import("./src/seeds/apply.ts");
const db = await import("./src/agents.ts");
const skills = await import("./src/skills.ts");
const { getSql } = await import("./src/client.ts");
const { SEEDS } = await import("./src/seeds/all.ts");
const sql = getSql();

const stamp = Date.now();
const slug = `verify-seed-${stamp}`;
const handSlug = `verify-seed-hand-${stamp}`;
const otherSlug = `verify-seed-other-${stamp}`;
const sk = (n) => `verify-seed-${n}-${stamp}`;
const lines = [];
const log = (l) => lines.push(l);
const mem = async (agentSlug) => Object.fromEntries((await db.listMemories((await db.getAgent(agentSlug)).id)).map((m) => [m.key, m]));

const v1 = {
  agent: {
    slug,
    name: "Verify Seed",
    description: "v1",
    instructions: "You are v1.",
    effort: "medium",
    mcpServers: [{ name: "pm-tool" }],
    maxIterations: 20,
    placement: "hub",
    functionName: "Delivery",
    owner: "Thor",
  },
  skills: [{ slug: sk("a"), name: "A", description: "a", promptTemplate: "Do {{x}}.", parameters: [{ name: "x", description: "x", required: true }] }],
  memories: [
    { key: "m1", content: "seeded one" },
    { key: "m2", content: "seeded two" },
  ],
};

try {
  console.log("— creating —");
  const first = await applySeed(v1, { log });
  const created = await db.getAgent(slug);
  check("an agent that does not exist is created from the definition", first.agent === "created" && created?.instructions === "You are v1." && created.functionName === "Delivery");
  check("with its skills and its induction memories", Boolean(await skills.getSkill(sk("a"))) && Object.keys(await mem(slug)).sort().join() === "m1,m2");
  const recorded = await sql`select kind, count(*)::int as n from seed_applied where key like ${`%${stamp}%`} group by kind order by kind`;
  check("and what the code set is recorded: one agent, one skill, two memories", recorded.map((r) => `${r.kind}:${r.n}`).join(",") === "agent:1,memory:2,skill:1", JSON.stringify(recorded));

  const again = await applySeed(v1, { log });
  check("applying the same code again changes nothing", again.agent === "unchanged" && again.skills.every((s) => s.outcome === "unchanged") && again.memories.every((m) => m.outcome === "unchanged"));

  console.log("\n— between two releases, people and the agent change things —");
  const row = await db.getAgent(slug);
  await db.updateAgent(row.id, {
    placement: "both",
    knowledgeCollections: ["meetings"],
    mcpServers: [{ name: "pm-tool", writes: "allow" }],
    enabled: false,
  });
  await db.rememberMemory(row.id, "m1", "what the agent learned instead");
  await skills.updateSkill((await skills.getSkill(sk("a"))).id, { enabled: false });

  const v2 = {
    ...v1,
    agent: { ...v1.agent, instructions: "You are v2.", placement: "local", maxIterations: 25 },
    skills: [{ ...v1.skills[0], promptTemplate: "Now do {{x}} carefully." }, { slug: sk("b"), name: "B", promptTemplate: "B.", parameters: [] }],
    memories: [
      { key: "m1", content: "seeded one, revised" },
      { key: "m2", content: "seeded two, revised" },
      { key: "m3", content: "seeded three" },
    ],
  };
  const second = await applySeed(v2, { log });
  const after = await db.getAgent(slug);
  check("a code change nobody overrode ships: the new instructions and stamina", after.instructions === "You are v2." && after.maxIterations === 25);
  check("a field a person changed is kept, even though the code changed it too", after.placement === "both" && second.kept.includes("placement"), `placement ${after.placement}, kept ${second.kept.join(",")}`);
  check("a person's knowledge scope is kept", after.knowledgeCollections.join() === "meetings");
  check("the approval gate a person switched off stays off", after.mcpServers.length === 1 && after.mcpServers[0].writes === "allow");
  check("an agent a person switched off stays off", after.enabled === false);
  const sa = await skills.getSkill(sk("a"));
  check("a skill's new template ships, and the page's switch on it is kept", sa.promptTemplate === "Now do {{x}} carefully." && sa.enabled === false);
  check("a new skill in the code is added", Boolean(await skills.getSkill(sk("b"))));
  const m = await mem(slug);
  check("a memory the agent rewrote is kept as the agent wrote it", m.m1.content === "what the agent learned instead");
  check("a memory nobody touched takes the new seeded text", m.m2.content === "seeded two, revised");
  check("a new memory in the induction pack is added", m.m3?.content === "seeded three");

  await db.forgetMemory(after.id, "m2");
  const third = await applySeed(v2, { log });
  check("a seeded memory the agent forgot after a release is not put back", !(await mem(slug)).m2 && third.memories.find((x) => x.key === "m2")?.outcome === "kept forgotten");

  const onlySkills = await applySeed({ ...v2, agent: { ...v2.agent, instructions: "You are v3." } }, { skillsOnly: true, log });
  check("--skills-only leaves the agent row alone", (await db.getAgent(slug)).instructions === "You are v2." && onlySkills.agent === "unchanged");

  console.log("\n— the first release, over an agent made by hand —");
  await db.createAgent({
    slug: handSlug,
    name: "Hand made",
    instructions: "An old brief.",
    model: "claude-sonnet-4-6",
    placement: "both",
    knowledgeCollections: ["hub-product"],
    mcpServers: [{ name: "pm-tool", writes: "allow" }],
  });
  await db.rememberMemory((await db.getAgent(handSlug)).id, "people", "what it already knew");
  await applySeed(
    {
      agent: { slug: handSlug, name: "Hand made", instructions: "The brief in code.", mcpServers: [{ name: "pm-tool" }, { name: "teams" }], maxIterations: 30 },
      skills: [],
      memories: [{ key: "people", content: "the seeded version" }, { key: "fresh", content: "new" }],
    },
    { log },
  );
  const hand = await db.getAgent(handSlug);
  check("with nothing recorded, the brief, servers and stamina come from the code", hand.instructions === "The brief in code." && hand.maxIterations === 30 && hand.mcpServers.map((e) => e.name).join() === "pm-tool,teams");
  check("while model, placement and knowledge scope stay as the page set them", hand.model === "claude-sonnet-4-6" && hand.placement === "both" && hand.knowledgeCollections.join() === "hub-product");
  check("and a server entry keeps what the page added to it (the gate switch)", hand.mcpServers.find((e) => e.name === "pm-tool")?.writes === "allow");
  const hm = await mem(handSlug);
  check("a memory that differs and was never recorded is kept; a missing one is added", hm.people.content === "what it already knew" && hm.fresh?.content === "new");

  console.log("\n— deleted, and refused —");
  await db.deleteAgent((await db.getAgent(slug)).id);
  const gone = await applySeed(v2, { log });
  check("a seeded agent deleted after a release is not recreated", gone.agent === "kept deleted" && !(await db.getAgent(slug)));

  const other = await db.createAgent({ slug: otherSlug, name: "Other" });
  await skills.createSkill({ agentId: other.id, slug: sk("taken"), name: "Taken", promptTemplate: "x" });
  const clash = await applySeed({ agent: { slug: handSlug, name: "Hand made" }, skills: [{ slug: sk("taken"), name: "Mine", promptTemplate: "y" }], memories: [] }, { log });
  check(
    "a skill slug another agent owns is refused, reported, and not taken over — and the seed still completes",
    clash.skills[0]?.outcome.startsWith("refused") && (await skills.getSkill(sk("taken"))).agentSlug === otherSlug,
    clash.skills[0]?.outcome,
  );
  check("every outcome was logged in words", lines.some((l) => /kept the page's placement/.test(l)) && lines.some((l) => /REFUSED\s+skill/.test(l)) && lines.some((l) => /kept deleted/.test(l)));

  console.log("\n— the real seeds —");
  const slugs = SEEDS.map((s) => s.agent.slug);
  check(
    "the release list holds every agent that lives in code, once",
    ["secretary", "project-manager", "product-owner-hub", "product-owner-atlas"].every((s) => slugs.includes(s)) && new Set(slugs).size === slugs.length,
    slugs.join(", "),
  );
  check("and no seeded server entry switches the approval gate off", SEEDS.every((s) => (s.agent.mcpServers ?? []).every((e) => e.writes !== "allow")));
} catch (err) {
  console.error("\nverify-seeds crashed:", err);
  checks.push({ label: "script completed", ok: false });
} finally {
  for (const s of [slug, handSlug, otherSlug]) {
    const a = await db.getAgent(s).catch(() => null);
    if (a) await db.deleteAgent(a.id).catch(() => {});
  }
  await sql`delete from seed_applied where key like ${`%${stamp}%`}`.catch(() => {});
  await sql.end({ timeout: 2 }).catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
