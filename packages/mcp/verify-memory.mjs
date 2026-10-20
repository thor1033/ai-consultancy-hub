// Verification of the `memory` MCP server — what a standing agent remembers
// between conversations.
//
//   node --env-file=apps/web/.env.local packages/mcp/verify-memory.mjs
//
// Needs DATABASE_URL and the agents/agent_memories tables (npm run migrate -w
// @ai-hub/db). No API key: this drives the server through the hub's own client
// path (memoryServerConfig -> connectMcpServers), never a hand-rolled call, so
// a pass here means an agent run works and not merely that the SQL is right.
//
// Everything happens under two throwaway agents that this script creates and
// deletes. The check that matters most is the last one: one agent must not be
// able to read another's memory.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}

const { connectMcpServers } = await import("./src/manager.ts");
const { memoryServerConfig } = await import("./src/servers.ts");

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

/** Tool results are content blocks; these tools answer with text or JSON text. */
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const agents = [];
async function makeAgent(slug, name) {
  const [row] = await sql`
    insert into agents (slug, name, description)
    values (${slug}, ${name}, 'Temporary agent created by verify-memory.')
    returning id
  `;
  agents.push(row.id);
  return row.id;
}

try {
  const agentA = await makeAgent(`verify-memory-a-${Date.now()}`, "Verify A");
  const agentB = await makeAgent(`verify-memory-b-${Date.now()}`, "Verify B");
  console.log(`\n  … using throwaway agents ${agentA.slice(0, 8)} / ${agentB.slice(0, 8)}\n`);

  const mcp = await connectMcpServers([memoryServerConfig(agentA)]);
  try {
    const names = mcp.tools.map((t) => t.name).sort();
    check("the memory server connects over stdio and lists its tools", names.length === 5, names.join(", "));
    check(
      "all five memory tools are present",
      ["memory_forget", "memory_list", "memory_search", "memory_set_active", "memory_write"].every((n) =>
        names.includes(n),
      ),
    );

    const empty = await mcp.execute("memory_list", {});
    check("a new agent starts with no memories", /no memories/i.test(empty), empty.slice(0, 60));

    const wrote = await mcp.execute("memory_write", {
      key: "reporting-cadence",
      content: "Aurora Capital wants the portfolio review every Monday morning, not Friday.",
    });
    check("memory_write records a fact", /Remembered/i.test(wrote), wrote.trim());

    const listed = parse(await mcp.execute("memory_list", {}));
    check(
      "the fact reads back as active",
      listed.active?.length === 1 && listed.active[0].key === "reporting-cadence" && listed.inactiveCount === 0,
      JSON.stringify(listed).slice(0, 80),
    );

    // The reason memory is keyed rather than appended: a correction must replace.
    const updated = await mcp.execute("memory_write", {
      key: "reporting-cadence",
      content: "Correction: Aurora Capital wants the portfolio review every Tuesday.",
    });
    check("rewriting a key updates rather than duplicating", /Updated/i.test(updated), updated.trim());

    const afterUpdate = parse(await mcp.execute("memory_list", {}));
    check(
      "there is still exactly one memory, with the corrected content",
      afterUpdate.active?.length === 1 && /Tuesday/.test(afterUpdate.active[0].content),
      afterUpdate.active?.[0]?.content?.slice(0, 50),
    );

    // ── active vs inactive work ──────────────────────────────────────────────
    // Finished work must stop loading by default, stay findable, and come back.
    await mcp.execute("memory_write", {
      key: "old-engagement",
      content: "Borealis audit closed in March; final report delivered.",
      active: false,
    });
    const withInactive = parse(await mcp.execute("memory_list", {}));
    check(
      "an inactive memory is not loaded by default, only counted",
      withInactive.active.length === 1 &&
        withInactive.inactiveCount === 1 &&
        !JSON.stringify(withInactive.active).includes("Borealis"),
      JSON.stringify(withInactive).slice(0, 80),
    );
    const everything = parse(await mcp.execute("memory_list", { include_inactive: true }));
    check(
      "include_inactive returns both groups",
      everything.active?.length === 1 && everything.inactive?.[0]?.key === "old-engagement",
    );
    const foundInactive = parse(await mcp.execute("memory_search", { query: "Borealis" }));
    check(
      "search finds an inactive memory and says it is inactive",
      Array.isArray(foundInactive) && foundInactive.length === 1 && foundInactive[0].active === false,
    );
    const reactivated = await mcp.execute("memory_set_active", { key: "old-engagement", active: true });
    const afterReactivate = parse(await mcp.execute("memory_list", {}));
    check(
      "memory_set_active brings work back into the active set",
      /Marked "old-engagement" active/.test(reactivated) &&
        afterReactivate.active.length === 2 &&
        afterReactivate.inactiveCount === 0,
      reactivated.trim(),
    );
    await mcp.execute("memory_set_active", { key: "old-engagement", active: false });
    await mcp.execute("memory_write", {
      key: "old-engagement",
      content: "Borealis is back: a follow-up audit starts in November.",
    });
    const rewritten = parse(await mcp.execute("memory_list", {}));
    check(
      "rewriting an inactive memory makes it active again",
      rewritten.active.some((m) => m.key === "old-engagement") && rewritten.inactiveCount === 0,
    );
    const missingMove = await mcp.execute("memory_set_active", { key: "never-existed", active: false });
    check("moving a key that does not exist says so", /nothing was stored/i.test(missingMove));
    await mcp.execute("memory_forget", { key: "old-engagement" });

    await mcp.execute("memory_write", {
      key: "deck-style",
      content: "Their house style is muted navy, no gradients, one chart per slide.",
    });

    const hit = parse(await mcp.execute("memory_search", { query: "navy" }));
    check(
      "memory_search finds a memory by its content",
      Array.isArray(hit) && hit.length === 1 && hit[0].key === "deck-style",
      Array.isArray(hit) ? hit.map((h) => h.key).join(", ") : String(hit).slice(0, 50),
    );

    const miss = await mcp.execute("memory_search", { query: "zzzz-not-a-thing" });
    check("a search that matches nothing says so plainly", /nothing remembered/i.test(miss), miss.trim().slice(0, 60));

    const forgot = await mcp.execute("memory_forget", { key: "deck-style" });
    check("memory_forget removes a memory", /Forgot/i.test(forgot), forgot.trim());
    const afterForget = parse(await mcp.execute("memory_list", {}));
    check("only the remaining memory is left", afterForget.active?.length === 1);

    const forgotMissing = await mcp.execute("memory_forget", { key: "never-existed" });
    check(
      "forgetting something never stored is not an error",
      /nothing was stored/i.test(forgotMissing),
      forgotMissing.trim().slice(0, 60),
    );

    // ── scope ────────────────────────────────────────────────────────────────
    // The whole reason the agent id travels in the environment and not in a
    // tool argument. If this fails, every client shares one memory.
    const mcpB = await connectMcpServers([memoryServerConfig(agentB)]);
    try {
      const bList = await mcpB.execute("memory_list", {});
      check(
        "a second agent cannot see the first agent's memories",
        /no memories/i.test(bList),
        bList.slice(0, 60),
      );
      const bSearch = await mcpB.execute("memory_search", { query: "Aurora" });
      check("nor find them by searching", /nothing remembered/i.test(bSearch));
    } finally {
      await mcpB.close();
    }
  } finally {
    await mcp.close();
  }

  // ── it must refuse to run unscoped ─────────────────────────────────────────
  // An unscoped memory server would open every agent's memory at once.
  const here = dirname(fileURLToPath(import.meta.url));
  const unscoped = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, "servers", "memory", "server.mjs")], {
      env: { ...process.env, HUB_AGENT_ID: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  check(
    "the server refuses to start without an agent id",
    unscoped.code === 1 && /HUB_AGENT_ID/.test(unscoped.stderr),
    `exit ${unscoped.code}`,
  );
} finally {
  for (const id of agents) await sql`delete from agents where id = ${id}`;
  console.log(`\n  … throwaway agents deleted\n`);
  await sql.end();
}

const failed = checks.filter((c) => !c.ok);
console.log(
  failed.length === 0
    ? `Memory MCP server OK (${checks.length} checks)`
    : `Memory MCP server FAILED (${failed.length}/${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
