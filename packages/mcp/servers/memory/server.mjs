// Memory MCP server — what a standing agent remembers between conversations.
//
// Unlike the other built-in servers this one is *stateful and scoped*: it is
// spawned per run with HUB_AGENT_ID naming the agent whose memory it opens, so
// one agent can never read or overwrite another's. The scope comes from the
// environment rather than a tool argument on purpose — a model that could pass
// an agent id could pass someone else's.
//
// It talks to Postgres directly instead of importing @ai-hub/db: this runs as a
// bare `node server.mjs` child process, and that package's TypeScript sources
// use extensionless imports which only a bundler resolves. The four statements
// below mirror packages/db/src/agents.ts — keep the upsert-by-key semantics in
// step if either changes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import postgres from "postgres";
import { z } from "zod";

const AGENT_ID = process.env.HUB_AGENT_ID;
const DATABASE_URL = process.env.DATABASE_URL;

// Fail closed and loudly on stderr: stdout is the JSON-RPC channel, so anything
// written there would corrupt the protocol rather than produce a message.
if (!AGENT_ID) {
  console.error("[memory] HUB_AGENT_ID is not set — refusing to start unscoped.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("[memory] DATABASE_URL is not set — no memory store available.");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const server = new McpServer(
  { name: "memory", version: "0.1.0" },
  {
    instructions:
      "Your own memory, carried between conversations. Call memory_list at the " +
      "start of a conversation to recall what you already know. Use memory_write " +
      "to record a durable fact — a client's preference, a decision and its " +
      "reason, a correction someone made. Do not store transient detail you can " +
      "look up again with another tool.",
  },
);

server.registerTool(
  "memory_list",
  {
    description:
      "List everything you remember, most recently updated first. Call this at the start of a conversation.",
    inputSchema: {},
  },
  async () => {
    const rows = await sql`
      select key, content, updated_at as "updatedAt"
      from agent_memories where agent_id = ${AGENT_ID}
      order by updated_at desc
    `;
    if (rows.length === 0) return text("You have no memories yet.");
    return text(rows);
  },
);

server.registerTool(
  "memory_search",
  {
    description: "Search your memories by keyword, matching the key or the content.",
    inputSchema: { query: z.string().describe("Keyword or phrase to look for.") },
  },
  async ({ query }) => {
    const term = `%${String(query ?? "").trim()}%`;
    const rows = await sql`
      select key, content, updated_at as "updatedAt"
      from agent_memories
      where agent_id = ${AGENT_ID} and (key ilike ${term} or content ilike ${term})
      order by updated_at desc
      limit 20
    `;
    if (rows.length === 0) return text(`Nothing remembered matching "${query}".`);
    return text(rows);
  },
);

server.registerTool(
  "memory_write",
  {
    description:
      "Remember a fact under a short key. Writing an existing key replaces it — use that to correct yourself rather than recording a second, contradictory version.",
    inputSchema: {
      key: z
        .string()
        .min(1)
        .describe("Short stable name for this fact, e.g. 'client-reporting-cadence'."),
      content: z.string().min(1).describe("The fact, written so it still makes sense months later."),
    },
  },
  async ({ key, content }) => {
    const [row] = await sql`
      insert into agent_memories (agent_id, key, content)
      values (${AGENT_ID}, ${key.trim()}, ${content})
      on conflict (agent_id, key) do update
        set content = excluded.content, updated_at = now()
      returning key, content, (created_at = updated_at) as "isNew"
    `;
    return text(`${row.isNew ? "Remembered" : "Updated"} "${row.key}".`);
  },
);

server.registerTool(
  "memory_forget",
  {
    description: "Forget the fact stored under a key, when it is wrong or no longer true.",
    inputSchema: { key: z.string().min(1).describe("The key to forget.") },
  },
  async ({ key }) => {
    const rows = await sql`
      delete from agent_memories where agent_id = ${AGENT_ID} and key = ${key.trim()}
    `;
    return text(rows.count > 0 ? `Forgot "${key}".` : `Nothing was stored under "${key}".`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
