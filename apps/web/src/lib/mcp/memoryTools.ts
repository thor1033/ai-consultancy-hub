import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { identifierRefusal } from "@ai-hub/mcp/detect";
import {
  listMemories,
  rememberMemory,
  setMemoryActive,
  forgetMemory,
  searchMemories,
  type MemoryPlace,
} from "@ai-hub/db";
import { memoryReachFor } from "@/lib/memoryScope";

/*
 * An agent's memory as MCP tools, for a server that already knows which agent
 * it is serving.
 *
 * Shared by the two places that serve memory over HTTP: /api/mcp, where the
 * agent comes from the credential's binding, and /api/mcp/agents/<slug>, where
 * a synced local sub-agent reaches its own memory. Neither lets a tool argument
 * name the agent — the id is closed over here, so the question cannot be asked.
 *
 * Scoped by the caller's person (docs/memory-scopes.md), the same way a hub run
 * is: they see the agent's shared memory, their own, and that of collections
 * they may read. What they write is kept for them alone. A local agent's model
 * runs on someone's machine and the hub cannot see what it read before it
 * remembered, so the hub assumes the narrowest; an admin can share a memory
 * from the agent's page.
 */

export const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

export function registerMemoryTools(server: McpServer, agentId: string, principal: { id: string; roles: string[] }): void {
  const memoryRow = (m: { key: string; content: string; updatedAt: string; scope: string; scopeRef: string }) => ({
    key: m.key,
    content: m.content,
    updatedAt: m.updatedAt,
    kept: m.scope === "agent" ? "shared" : m.scope === "personal" ? "only you" : `readers of ${m.scopeRef}`,
  });
  // Resolved per call: a grant given or taken away applies to the next call.
  const reach = () => memoryReachFor(principal);
  const mine: MemoryPlace = { scope: "personal", ref: principal.id };

  server.registerTool(
    "hub_memory_list",
    {
      description:
        "List your active memories (work in flight), most recently updated " +
        "first, plus a count of inactive ones. Call this at the start of a " +
        "conversation.",
      inputSchema: {
        include_inactive: z
          .boolean()
          .optional()
          .describe("Also return inactive memories (finished, paused or background work)."),
      },
    },
    async ({ include_inactive }) => {
      const rows = await listMemories(agentId, await reach());
      if (!rows.length) return text("You have no memories yet.");
      const active = rows.filter((m) => m.active).map(memoryRow);
      const inactive = rows.filter((m) => !m.active).map(memoryRow);
      if (include_inactive) return text({ active, inactive });
      return text({ active, inactiveCount: inactive.length });
    },
  );

  server.registerTool(
    "hub_memory_search",
    {
      description:
        "Search all your memories, active and inactive, by keyword in the key " +
        "or the content. Each result says whether it is active.",
      inputSchema: {
        query: z.string().min(1).describe("Keyword or phrase to look for."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many memories to return (default 20)."),
      },
    },
    async ({ query, limit }) => {
      const rows = await searchMemories(agentId, query, limit ?? 20, await reach());
      if (!rows.length) return text(`No memories matched "${query}".`);
      return text(rows.map((m) => ({ ...memoryRow(m), active: m.active })));
    },
  );

  server.registerTool(
    "hub_memory_write",
    {
      description:
        "Record a durable fact under a short key. Writing an existing key " +
        "replaces it, so correcting yourself does not leave two contradictory " +
        "memories. New and rewritten memories are active unless you say otherwise. " +
        "What you write here is kept for the person you are working for alone.",
      inputSchema: {
        key: z
          .string()
          .min(1)
          .describe("A short stable name for this fact, e.g. \"weekly-review-day\"."),
        content: z.string().min(1).describe("The fact, written so it reads on its own later."),
        active: z
          .boolean()
          .optional()
          .describe("False to file it straight away as inactive (finished or background work). Default true."),
      },
    },
    async ({ key, content, active }) => {
      // A CPR, card or account number is refused by the store (docs/sensitivity.md); said, not thrown.
      const refusal = identifierRefusal(`${key}\n${content}`);
      if (refusal) return { content: [{ type: "text" as const, text: refusal }], isError: true };
      const saved = await rememberMemory(agentId, key, content, active ?? true, mine, { writtenBy: principal.id });
      return text({
        saved: saved.key,
        content: saved.content,
        active: saved.active,
        updatedAt: saved.updatedAt,
      });
    },
  );

  server.registerTool(
    "hub_memory_set_active",
    {
      description:
        "Mark a memory active (work in flight) or inactive (finished, paused or " +
        "background) without changing what it says.",
      inputSchema: {
        key: z.string().min(1).describe("The key to move."),
        active: z.boolean().describe("True for active work, false to set it aside."),
      },
    },
    async ({ key, active }) => {
      const moved = await setMemoryActive(agentId, key, active, await reach());
      return text(
        moved
          ? `Marked "${key}" ${active ? "active" : "inactive"}.`
          : `Nothing was stored under "${key}".`,
      );
    },
  );

  server.registerTool(
    "hub_memory_forget",
    {
      description: "Forget the fact stored under a key, when it is wrong or no longer true.",
      inputSchema: {
        key: z.string().min(1).describe("The key to forget."),
      },
    },
    async ({ key }) => {
      const gone = await forgetMemory(agentId, key, await reach());
      return text(gone ? `Forgot "${key}".` : `Nothing was stored under "${key}".`);
    },
  );
}
