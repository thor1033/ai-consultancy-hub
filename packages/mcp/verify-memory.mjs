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
    check("the memory server connects over stdio and lists its tools", names.length === 4, names.join(", "));
    check(
      "all four memory tools are present",
      ["memory_forget", "memory_list", "memory_search", "memory_write"].every((n) => names.includes(n)),
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
      "the fact reads back",
      Array.isArray(listed) && listed.length === 1 && listed[0].key === "reporting-cadence",
      Array.isArray(listed) ? `${listed.length} memory` : String(listed).slice(0, 60),
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
      afterUpdate.length === 1 && /Tuesday/.test(afterUpdate[0].content),
      afterUpdate[0]?.content?.slice(0, 50),
    );

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
    check("only the remaining memory is left", afterForget.length === 1);

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
