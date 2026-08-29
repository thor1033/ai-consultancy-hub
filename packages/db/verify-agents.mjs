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
  rememberMemory, listMemories, searchMemories, forgetMemory,
} = await import("./src/agents.ts");
const { getSql } = await import("./src/client.ts");

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
    knowledgeCollection: "verify-collection",
  });
  check("createAgent returns the stored row", Boolean(agent?.id), agent?.id?.slice(0, 8));
  check("it round-trips every field",
    agent.slug === slug &&
    agent.instructions === "Be brief." &&
    agent.model === "claude-opus-4-8" &&
    agent.knowledgeCollection === "verify-collection" &&
    Array.isArray(agent.mcpServers) && agent.mcpServers[0]?.name === "sample",
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
      renamed.knowledgeCollection === "verify-collection",
    `model=${renamed.model} collection=${renamed.knowledgeCollection}`,
  );

  // The case a coalesce-based update gets wrong: null means clear it.
  const cleared = await updateAgent(agent.id, { model: null, knowledgeCollection: null });
  check(
    "an explicit null clears a nullable field",
    cleared.model === null && cleared.knowledgeCollection === null,
    `model=${cleared.model} collection=${cleared.knowledgeCollection}`,
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
