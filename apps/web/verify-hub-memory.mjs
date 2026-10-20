// Verification of token-bound agent memory over /api/mcp.
//
//   node --experimental-transform-types --env-file=apps/web/.env.local \
//     apps/web/verify-hub-memory.mjs
//
// Needs DATABASE_URL and the agents/agent_memories tables (npm run migrate -w
// @ai-hub/db). No API key.
//
// It drives the real buildHubMcpServer through a real MCP client over an
// in-memory transport, so a pass means a Claude Code session would see the same
// thing — not merely that the SQL is right.
//
// The checks that matter are the negative ones: a token with no binding, a
// binding a role does not permit, and a stale binding must all yield NO memory
// tools at all. And there is no tool that takes an agent id, so one agent's
// token cannot even ask for another's memory.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// The workspace TypeScript uses extensionless imports, which bundlers resolve
// and Node does not. Harness-only; nothing in the packages changes for a test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Next resolves the `@/` alias to apps/web/src; raw Node does not, and
    // hubServer reaches its siblings that way. Harness-only.
    if (specifier.startsWith("@/")) {
      const base = new URL("./src/", import.meta.url);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier.slice(2) + ext, base);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
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

const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
const { authenticate } = await import("../../packages/authz/src/principal.ts");
const { createAgent, deleteAgent, rememberMemory } = await import(
  "../../packages/db/src/agents.ts"
);

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };

async function connect(principal) {
  const server = await buildHubMcpServer(principal);
  const client = new Client({ name: "verify", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: () => client.close() };
}
const toolNames = async (client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();

const slug = `verify-mem-${Date.now()}`;
let agentA, agentB;

try {
  agentA = await createAgent({ name: "Verify Agent A", slug, instructions: "test" });
  agentB = await createAgent({
    name: "Verify Agent B",
    slug: `${slug}-b`,
    instructions: "test",
  });
  await rememberMemory(agentB.id, "b-secret", "Agent B's private fact.");

  // --- token parsing -------------------------------------------------------
  process.env.HUB_API_TOKENS = JSON.stringify({
    "t-none": { id: "none", roles: ["analyst"] },
    "t-bound": { id: "bound", roles: ["analyst"], agentId: agentA.id },
    "t-slug": { id: "slugbound", roles: ["analyst"], agentId: slug },
    "t-viewer": { id: "v", roles: ["viewer"], agentId: agentA.id },
    "t-stale": { id: "stale", roles: ["analyst"], agentId: "11111111-1111-1111-1111-111111111111" },
    "t-bad": { id: "bad", roles: ["analyst"], agentId: 42 },
  });
  // authenticate() is async now: it may reach the database for an OAuth
  // identity or a credential. These legacy-map tokens resolve in process, but
  // the seam is the same one for all three sources.
  const auth = (tok) => authenticate(new Headers({ authorization: `Bearer ${tok}` }));

  check("token without agentId parses with none", (await auth("t-none")).agentId === undefined);
  check("token with agentId parses it", (await auth("t-bound")).agentId === agentA.id);
  check("non-string agentId is dropped, not coerced", (await auth("t-bad")).agentId === undefined);

  // --- registration is by construction -------------------------------------
  const unbound = await connect(await auth("t-none"));
  const unboundTools = await toolNames(unbound.client);
  check(
    "unbound token is offered NO memory tools",
    unboundTools.every((n) => !n.startsWith("hub_memory")),
    unboundTools.join(", "),
  );
  check("unbound token still gets the knowledge tools", unboundTools.includes("hub_search_knowledge"));
  await unbound.close();

  const viewer = await connect(await auth("t-viewer"));
  const viewerTools = await toolNames(viewer.client);
  check(
    "viewer with a binding is offered NO memory tools (lacks agent:run)",
    viewerTools.every((n) => !n.startsWith("hub_memory")),
    viewerTools.join(", "),
  );
  await viewer.close();

  const stale = await connect(await auth("t-stale"));
  const staleTools = await toolNames(stale.client);
  check(
    "binding to a non-existent agent fails closed",
    staleTools.every((n) => !n.startsWith("hub_memory")),
    staleTools.join(", "),
  );
  await stale.close();

  const bySlug = await connect(await auth("t-slug"));
  check("a token may bind by slug", (await toolNames(bySlug.client)).includes("hub_memory_list"));
  await bySlug.close();

  // --- the bound session ---------------------------------------------------
  const bound = await connect(await auth("t-bound"));
  const boundTools = await toolNames(bound.client);
  check(
    "bound token gets all five memory tools",
    [
      "hub_memory_forget",
      "hub_memory_list",
      "hub_memory_search",
      "hub_memory_set_active",
      "hub_memory_write",
    ].every((n) => boundTools.includes(n)),
    boundTools.filter((n) => n.startsWith("hub_memory")).join(", "),
  );

  const callText = async (name, args = {}) =>
    (await bound.client.callTool({ name, arguments: args })).content[0].text;

  check("empty memory reads as empty", (await callText("hub_memory_list")).includes("no memories"));

  await callText("hub_memory_write", { key: "review-day", content: "Weekly review is Tuesday." });
  const listed = parse(await callText("hub_memory_list"));
  check(
    "a written memory reads back as active",
    listed.active?.length === 1 && listed.active[0].key === "review-day" && listed.inactiveCount === 0,
  );

  await callText("hub_memory_write", { key: "review-day", content: "Weekly review moved to Wednesday." });
  const after = parse(await callText("hub_memory_list"));
  check(
    "writing the same key REPLACES it (no contradictory pair)",
    after.active?.length === 1 && after.active[0].content.includes("Wednesday"),
    `${after.active?.length} memories`,
  );

  // --- active vs inactive work --------------------------------------------
  await callText("hub_memory_write", {
    key: "closed-engagement",
    content: "Borealis audit closed in March.",
    active: false,
  });
  const split = parse(await callText("hub_memory_list"));
  check(
    "an inactive memory is counted but not loaded by default",
    split.active.length === 1 && split.inactiveCount === 1 && !JSON.stringify(split.active).includes("Borealis"),
  );
  const both = parse(await callText("hub_memory_list", { include_inactive: true }));
  check(
    "include_inactive returns the inactive group",
    both.inactive?.length === 1 && both.inactive[0].key === "closed-engagement",
  );
  const inactiveHit = parse(await callText("hub_memory_search", { query: "Borealis" }));
  check(
    "search reaches inactive memories and labels them",
    Array.isArray(inactiveHit) && inactiveHit[0]?.active === false,
  );
  check(
    "hub_memory_set_active moves a memory back to active",
    (await callText("hub_memory_set_active", { key: "closed-engagement", active: true })).includes(
      "Marked",
    ) && parse(await callText("hub_memory_list")).active.length === 2,
  );
  await callText("hub_memory_forget", { key: "closed-engagement" });

  const found = parse(await callText("hub_memory_search", { query: "Wednesday" }));
  check("search finds it by content", Array.isArray(found) && found.length === 1);
  check(
    "search misses what is not there",
    (await callText("hub_memory_search", { query: "zzz-nope" })).includes("No memories matched"),
  );

  // --- the isolation property ---------------------------------------------
  const memorySchemas = (await bound.client.listTools()).tools
    .filter((t) => t.name.startsWith("hub_memory"))
    .map((t) => t.inputSchema);
  check(
    "no memory tool accepts an agent id",
    !JSON.stringify(memorySchemas).toLowerCase().includes("agentid"),
  );
  const visible = parse(await callText("hub_memory_list"));
  check(
    "agent A's token cannot see agent B's memory",
    !JSON.stringify(visible).includes("b-secret"),
  );

  check("forget removes it", (await callText("hub_memory_forget", { key: "review-day" })).includes("Forgot"));
  check(
    "forgetting an unknown key says so rather than lying",
    (await callText("hub_memory_forget", { key: "never-existed" })).includes("Nothing was stored"),
  );
  check("memory is empty again", (await callText("hub_memory_list")).includes("no memories"));

  await bound.close();
} finally {
  if (agentA) await deleteAgent(agentA.id);
  if (agentB) await deleteAgent(agentB.id);
  await sql.end();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
