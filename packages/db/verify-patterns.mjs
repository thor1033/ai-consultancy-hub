// Verification of patterns (src/patterns, docs/agent-patterns.md) and of
// hand-offs as rows (src/handoffs.ts).
//
//   node --experimental-transform-types --env-file=apps/web/.env.local packages/db/verify-patterns.mjs
//
// No API key. Every agent, skill, memory, hand-off and seed_applied row is
// made under a throwaway name and deleted at the end.
//
// Two halves. The previews are pure: every pattern, with example values, must
// produce agents whose placeholders are all filled, whose asks point at roles
// of the same pattern, and whose memory switch is what the design says. Then
// each pattern is created for real, and what it made is read back: the rows,
// the ask entries by slug, the hand-offs by id, the skills — and that a
// failure part-way leaves nothing behind.
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
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const patterns = await import("./src/patterns/index.ts");
const handoffs = await import("./src/handoffs.ts");
const db = await import("./src/index.ts");
const { applySeed } = await import("./src/seeds/apply.ts");
const sql = db.getSql();
const stamp = Date.now();
const instance = `verify-${stamp}`;

const EXAMPLES = {
  "long-memory-short-hands": { domain: "Answering clients' contract questions.", workerServers: "pm-tool, teams" },
  "coordinator-specialists": { job: "Scoping an engagement.", specialists: "Legal: contracts and GDPR\nDelivery: effort and timeline\n- Commercial: price" },
  pipeline: { input: "A client's email", stages: "Extract: list every request\nCheck: say what the board has\nReply: draft the reply" },
  "writer-reviewer": { work: "Proposals, in Danish", standard: "1. Opens with the client's problem.\n2. Names a price." },
  "front-desk": { askers: "Colleagues in Teams", specialists: "IT: laptops and access\nHR: leave and expenses" },
};

// ── 1. the previews, pure ───────────────────────────────────────────────────
console.log("— every pattern, previewed —");
check("five patterns, each with a slug, a nickname, a diagram and decisions", patterns.PATTERNS.length === 5 && patterns.PATTERNS.every((p) => p.slug && p.nickname && p.diagram.includes("▶") && p.decisions.length >= 2 && p.when.length >= 2));
check("their slugs are distinct", new Set(patterns.PATTERNS.map((p) => p.slug)).size === 5);
const previews = {};
for (const p of patterns.PATTERNS) {
  const pv = patterns.previewPattern(p, { instance: "Research & Insight", owner: "Thor Simonsen", functionName: "Delivery", ...EXAMPLES[p.slug] });
  previews[p.slug] = pv;
  check(`${p.nickname}: previews with no errors`, pv.errors.length === 0, pv.errors.join(" | "));
  check(`${p.nickname}: every agent's slug starts with the set's, and no placeholder is left`, pv.agents.every((a) => a.slug.startsWith("research-insight-")) && !/\{\{/.test(pv.agents.map((a) => a.instructions).join()), pv.agents.map((a) => a.slug).join(", "));
  const askLists = pv.agents.flatMap((a) => patterns.askedAgents(a.mcpServers));
  const slugs = new Set(pv.agents.map((a) => a.slug));
  check(`${p.nickname}: every ask names an agent of the same set`, askLists.every((s) => slugs.has(s)), askLists.join(", ") || "no asks");
  check(`${p.nickname}: every agent carries the pattern tag with its role`, pv.agents.every((a) => a.pattern?.slug === p.slug && a.pattern.instance === "research-insight" && a.slug.endsWith(`-${a.pattern.role}`)));
  check(`${p.nickname}: owner and function land on every agent`, pv.agents.every((a) => a.owner === "Thor Simonsen" && a.functionName === "Delivery"));
}
const lm = previews["long-memory-short-hands"];
check("elephant & goldfish: the archivist remembers and reads everything; the worker neither", lm.agents.find((a) => a.slug.endsWith("-archivist")).keepsMemory === true && lm.agents.find((a) => a.slug.endsWith("-archivist")).knowledgeAll === true && lm.agents.find((a) => a.slug.endsWith("-worker")).keepsMemory === false && lm.agents.find((a) => a.slug.endsWith("-worker")).knowledgeAll === false);
check("the archivist may ask the worker, and the worker may ask nobody", JSON.stringify(patterns.askedAgents(lm.agents[0].mcpServers)) === '["research-insight-worker"]' && patterns.askedAgents(lm.agents[1].mcpServers).length === 0);
check("the worker got the tool servers named, trimmed", lm.agents[1].mcpServers.map((e) => e.name).join() === "pm-tool,teams");
check("the archivist's brief names the worker by slug and the pair's domain", /research-insight-worker/.test(lm.agents[0].instructions) && /contract questions/.test(lm.agents[0].instructions));
check("the archivist has the 'Do this' skill and an induction memory on briefing", lm.skills.length === 1 && lm.skills[0].slug === "research-insight-archivist-do" && lm.memories.some((m) => m.key === "how-i-brief"));
const cl = previews["coordinator-specialists"];
check("cluster: one coordinator plus one agent per specialist line, bullets and spaces tolerated", cl.agents.length === 4 && cl.agents.map((a) => a.pattern.role).join() === "coordinator,legal,delivery,commercial");
check("the coordinator may ask all three; a specialist asks nobody", patterns.askedAgents(cl.agents[0].mcpServers).length === 3 && cl.agents.slice(1).every((a) => patterns.askedAgents(a.mcpServers).length === 0));
check("each specialist's brief carries its own area and names the coordinator", /contracts and GDPR/.test(cl.agents[1].instructions) && /Coordinator · Research & Insight/.test(cl.agents[1].instructions));
const pl = previews.pipeline;
check("pipeline: one agent per stage, none remembering, numbered in order", pl.agents.length === 3 && pl.agents.every((a) => !a.keepsMemory) && pl.agents.map((a) => a.name).join(" | ") === "1. Extract · Research & Insight | 2. Check · Research & Insight | 3. Reply · Research & Insight");
check("two hand-offs, stage 1 keyed to its start skill and stage 2 to any run, each carrying the answer", pl.handoffs.length === 2 && pl.handoffs[0].skillSlug === "research-insight-extract-start" && pl.handoffs[1].skillSlug === null && pl.handoffs.every((h) => /\{\{output\}\}/.test(h.prompt)) && pl.handoffs[0].toSlug === "research-insight-check");
check("only the first stage has a skill, and the last stage knows it is last", pl.skills.length === 1 && pl.skills[0].agentSlug === "research-insight-extract" && /You are the last stage/.test(pl.agents[2].instructions) && /hands your answer to stage 2/.test(pl.agents[0].instructions));
check("no stage asks another", pl.agents.every((a) => patterns.askedAgents(a.mcpServers).length === 0));
const wr = previews["writer-reviewer"];
check("critic loop: the writer remembers and asks the reviewer; the reviewer remembers nothing and asks nobody", wr.agents[0].keepsMemory && patterns.askedAgents(wr.agents[0].mcpServers).join() === "research-insight-reviewer" && !wr.agents[1].keepsMemory && patterns.askedAgents(wr.agents[1].mcpServers).length === 0);
check("both briefs carry the standard; the writer's caps the rounds at three", /Names a price/.test(wr.agents[0].instructions) && /Names a price/.test(wr.agents[1].instructions) && /At most three rounds/.test(wr.agents[0].instructions) && /never rewrite/.test(wr.agents[1].instructions));
const fd = previews["front-desk"];
check("front desk: routes to ONE specialist and keeps a 'nobody-covers' memory", patterns.askedAgents(fd.agents[0].mcpServers).length === 2 && /which ONE specialist/.test(fd.agents[0].instructions) && fd.memories.some((m) => m.key === "nobody-covers"));

console.log("\n— previews that must refuse —");
const noName = patterns.previewPattern(patterns.PATTERNS[0], { instance: "", domain: "x" });
check("a set with no name is refused", noName.errors.some((e) => /Name for this set is required/.test(e)), noName.errors.join(" | "));
const noList = patterns.previewPattern(patterns.getPattern("coordinator-specialists"), { instance: "X", job: "x", specialists: "   \n" });
check("a cluster with no specialists is refused, saying how to write one", noList.errors.some((e) => /Name: what it covers/.test(e)));
const dupe = patterns.previewPattern(patterns.getPattern("pipeline"), { instance: "X", input: "x", stages: "Check: a\nCheck: b\nReply: c" });
check("two stages with the same name become one (the duplicate line is dropped), never two agents of one slug", dupe.errors.length === 0 && dupe.agents.length === 2 && new Set(dupe.agents.map((a) => a.slug)).size === 2);
check("askedAgents reads only the agents entry, trims, and ignores junk", JSON.stringify(patterns.askedAgents([{ name: "pm-tool" }, { name: "agents", agents: [" a ", "b", 3, "", "a"] }])) === '["a","b"]' && patterns.askedAgents([{ name: "agents" }]).length === 0 && patterns.askedAgents(undefined).length === 0);
check("a hand-off prompt is filled from its five placeholders and leaves an unknown one visible", handoffs.renderHandoffPrompt("{{agentName}} ran {{ skillName }} as session {{sessionId}}: {{output}} / {{prompt}} / {{bogus}}", { agentName: "A", skillName: "S", sessionId: "id", output: "O", prompt: "P" }) === "A ran S as session id: O / P / {{bogus}}");

// ── 2. for real ─────────────────────────────────────────────────────────────
console.log("\n— every pattern, created —");
const made = [];
const cleanupSlugs = [];
try {
  for (const p of patterns.PATTERNS) {
    const values = { instance, owner: "Verify", functionName: "Verify", ...EXAMPLES[p.slug] };
    const out = await patterns.instantiatePattern(p, values);
    made.push(out);
    cleanupSlugs.push(...out.agents.map((a) => a.id));
    const pv = patterns.previewPattern(p, values);
    check(`${p.nickname}: creates every agent of its preview, with memory switch and tag`, out.agents.length === pv.agents.length && out.agents.every((a, i) => a.slug === pv.agents[i].slug && a.keepsMemory === pv.agents[i].keepsMemory && a.pattern?.role === pv.agents[i].pattern.role));
    const skills = (await Promise.all(out.agents.map((a) => db.listSkills(a.id)))).flat();
    check(`${p.nickname}: its skills and hand-offs are rows`, skills.length === pv.skills.length && out.handoffs.length === pv.handoffs.length, `${skills.length} skills, ${out.handoffs.length} hand-offs`);
    const again = await patterns.instantiatePattern(p, values).then(() => null, (e) => e.message);
    check(`${p.nickname}: creating the same set twice is refused by slug`, /already exists/.test(again ?? ""), again);
    // Nothing left behind by the refused second try: the same count of agents under this instance.
    const [{ n }] = await sql`select count(*)::int as n from agents where slug like ${`${instance}-%`}`;
    check(`${p.nickname}: and the refused try left nothing behind`, n === made.reduce((m, o) => m + o.agents.length, 0), `${n} agents`);
    for (const a of out.agents) await db.deleteAgent(a.id);
    made.length = 0;
  }

  console.log("\n— a pipeline's hand-offs, read back —");
  const pipe = await patterns.instantiatePattern(patterns.getPattern("pipeline"), { instance, input: "mail", stages: EXAMPLES.pipeline.stages });
  cleanupSlugs.push(...pipe.agents.map((a) => a.id));
  const [s1, s2, s3] = pipe.agents;
  const start = (await db.listSkills(s1.id))[0];
  const firing = await handoffs.handoffsFor(s1.id, start.id);
  check("stage 1's start skill fires exactly one hand-off, to stage 2, with a note on what it does", firing.length === 1 && firing[0].toAgentId === s2.id && /it does stage 2/.test(firing[0].note), firing[0]?.note);
  check("a run of stage 1 that is NOT the start skill fires none (the hand-off is keyed to the skill)", (await handoffs.handoffsFor(s1.id, null)).length === 0);
  check("any run of stage 2 fires the hand-off to stage 3", (await handoffs.handoffsFor(s2.id, null)).length === 1 && (await handoffs.handoffsFor(s2.id, null))[0].toAgentId === s3.id);
  check("stage 3, the last, hands to nobody", (await handoffs.handoffsFor(s3.id, null)).length === 0);
  check("the agent's page lists a hand-off from both sides", (await handoffs.listHandoffs(s2.id)).length === 2 && (await handoffs.listHandoffs(s1.id)).length === 1);
  const off = await handoffs.setHandoffEnabled(firing[0].id, false);
  check("a switched-off hand-off does not fire, and is still listed", off.enabled === false && (await handoffs.handoffsFor(s1.id, start.id)).length === 0 && (await handoffs.listHandoffs(s1.id)).length === 1);
  const self = await handoffs.createHandoff({ fromAgentId: s1.id, toAgentId: s1.id, prompt: "x" }).then(() => null, (e) => e.message);
  check("an agent cannot hand off to itself", /cannot hand off to itself/.test(self ?? ""));
  const blank = await handoffs.createHandoff({ fromAgentId: s1.id, toAgentId: s2.id, prompt: "  " }).then(() => null, (e) => e.message);
  check("a hand-off needs a prompt", /needs a prompt/.test(blank ?? ""));
  await db.deleteAgent(s2.id);
  check("deleting an agent takes its hand-offs with it", (await handoffs.listHandoffs(s1.id)).length === 0 && (await handoffs.listHandoffs(s3.id)).length === 0);

  console.log("\n— a seed that declares hand-offs into its agent —");
  const fromSlug = `${instance}-from`;
  const from = await db.createAgent({ slug: fromSlug, name: "From", instructions: "x" });
  cleanupSlugs.push(from.id);
  const skill = await db.createSkill({ agentId: from.id, slug: `${fromSlug}-meet`, name: "Meet", promptTemplate: "m" });
  const seed = (prompt) => ({
    agent: { slug: `${instance}-to`, name: "To", instructions: "y" },
    skills: [],
    memories: [],
    handoffs: [
      { fromAgent: fromSlug, skill: `${fromSlug}-meet`, prompt, note: "n" },
      { fromAgent: `${instance}-nobody`, prompt: "p" },
    ],
  });
  const lines = [];
  const first = await applySeed(seed("v1 {{sessionId}}"), { log: (l) => lines.push(l) });
  const to = await db.getAgent(`${instance}-to`);
  cleanupSlugs.push(to.id);
  let rows = await handoffs.listHandoffs(to.id);
  check("the first release creates the hand-off whose other side exists, and skips the one whose agent is missing, in words", rows.length === 1 && rows[0].skillId === skill.id && rows[0].prompt === "v1 {{sessionId}}" && first.handoffs.some((h) => /skipped: no agent/.test(h.outcome)) && lines.some((l) => /skipped\s+handoff/.test(l)), JSON.stringify(first.handoffs));
  const second = await applySeed(seed("v2 {{sessionId}}"));
  rows = await handoffs.listHandoffs(to.id);
  check("a new prompt in the code ships when nobody changed it", rows[0].prompt === "v2 {{sessionId}}" && second.handoffs[0].outcome === "updated");
  await handoffs.updateHandoffPrompt(rows[0].id, "the page's prompt");
  await handoffs.setHandoffEnabled(rows[0].id, false);
  const third = await applySeed(seed("v3 {{sessionId}}"));
  rows = await handoffs.listHandoffs(to.id);
  check("a prompt a person changed is kept over a newer code value, and their switch-off stays", rows[0].prompt === "the page's prompt" && rows[0].enabled === false && third.handoffs[0].outcome === "kept the page's prompt");
  await handoffs.deleteHandoff(rows[0].id);
  const fourth = await applySeed(seed("v3 {{sessionId}}"));
  check("a hand-off a person deleted after a release is not recreated", (await handoffs.listHandoffs(to.id)).length === 0 && fourth.handoffs[0].outcome === "kept deleted");
} finally {
  for (const id of cleanupSlugs) await db.deleteAgent(id).catch(() => {});
  await sql`delete from agents where slug like ${`${instance}-%`}`;
  await sql`delete from seed_applied where key like ${`${instance}-%`} or key like ${`%${instance}-%`}`;
  await sql.end({ timeout: 5 });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: how the agents behave together with a real model — see verify:asks (web) for the wiring, and a test hub for the judgement.");
