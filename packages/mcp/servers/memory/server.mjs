// Memory MCP server — what a standing agent remembers between conversations.
//
// Unlike the other built-in servers this one is *stateful and scoped*: it is
// spawned per run with HUB_AGENT_ID naming the agent whose memory it opens, so
// one agent can never read or overwrite another's. The scope comes from the
// environment rather than a tool argument on purpose — a model that could pass
// an agent id could pass someone else's.
//
// SCOPES (docs/memory-scopes.md). A memory is kept for everyone who uses the
// agent, for the readers of one knowledge collection, or for one person, and
// this server reads and writes only what the run's person may have:
//
//   HUB_MEMORY_PRINCIPAL    the run's person ('' for none). Their personal
//                           memories are theirs alone; no one else's load.
//   HUB_MEMORY_COLLECTIONS  which collections they may read, as JSON in the
//                           shape of KnowledgeAccess ({"kind":"all"} |
//                           {"kind":"allow"|"deny","collections":[…]}).
//                           Absent or malformed ⇒ none (fail closed).
//   HUB_MEMORY_RUN_ID       the run, recorded on what it writes.
//
// Where a write goes is not the model's choice: the hub's gate adds `__place`
// to memory_write from what the run has touched (lib/memoryScope.ts), and
// removes the argument from the schema the model sees. This server checks it
// anyway — a personal place must be this run's person, a collection one a
// collection they may read — so a forged place is refused, not obeyed.
//
// It talks to Postgres directly instead of importing @ai-hub/db: this runs as a
// bare `node server.mjs` child process, and that package's TypeScript sources
// use extensionless imports which only a bundler resolves. The statements below
// mirror packages/db/src/agents.ts — keep the upsert-by-key and active/inactive
// semantics in step if either changes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import postgres from "postgres";
import { z } from "zod";
import { identifierRefusal } from "../detect.mjs";

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

const PRINCIPAL = (process.env.HUB_MEMORY_PRINCIPAL ?? "").trim();
const RUN_ID = /^[0-9a-f-]{36}$/i.test(process.env.HUB_MEMORY_RUN_ID ?? "") ? process.env.HUB_MEMORY_RUN_ID : null;
const COLLECTIONS = (() => {
  try {
    const c = JSON.parse(process.env.HUB_MEMORY_COLLECTIONS ?? "");
    if (c?.kind === "all") return { kind: "all" };
    if ((c?.kind === "allow" || c?.kind === "deny") && Array.isArray(c.collections)) {
      return { kind: c.kind, collections: c.collections.filter((x) => typeof x === "string") };
    }
  } catch {
    /* fall through: none */
  }
  return { kind: "allow", collections: [] };
})();
const mayReadCollection = (name) =>
  COLLECTIONS.kind === "all" ? true : COLLECTIONS.kind === "allow" ? COLLECTIONS.collections.includes(name) : !COLLECTIONS.collections.includes(name);

/** Only what this run's person may have. '' matches no personal memory (their refs are never empty). */
function visible() {
  const collection =
    COLLECTIONS.kind === "all"
      ? sql`true`
      : COLLECTIONS.kind === "allow"
        ? COLLECTIONS.collections.length
          ? sql`scope_ref = any(${COLLECTIONS.collections}::text[])`
          : sql`false`
        : COLLECTIONS.collections.length
          ? sql`not (scope_ref = any(${COLLECTIONS.collections}::text[]))`
          : sql`true`;
  return sql`(scope = 'agent' or (scope = 'personal' and scope_ref = ${PRINCIPAL}) or (scope = 'collection' and ${collection}))`;
}

/** The narrowest visible memory under a key: a person's own before a collection's before the shared one. */
const byKey = (key) => sql`(select id from agent_memories
   where agent_id = ${AGENT_ID} and key = ${key} and ${visible()}
   order by case scope when 'personal' then 0 when 'collection' then 1 else 2 end limit 1)`;

/** Where a write goes: the gate's place, checked; else this run's person, else shared. */
function placeFor(raw) {
  let place = null;
  if (typeof raw === "string" && raw) {
    try {
      place = JSON.parse(raw);
    } catch {
      return { error: "Not remembered: the hub sent a place it could not read." };
    }
  }
  if (!place) return PRINCIPAL ? { scope: "personal", ref: PRINCIPAL } : { scope: "agent", ref: "" };
  if (place.scope === "agent") return { scope: "agent", ref: "" };
  if (place.scope === "personal") {
    if (!PRINCIPAL || place.ref !== PRINCIPAL) return { error: "Not remembered: a personal memory can only be this run's person's." };
    return { scope: "personal", ref: PRINCIPAL };
  }
  if (place.scope === "collection" && typeof place.ref === "string" && place.ref) {
    if (!mayReadCollection(place.ref)) return { error: `Not remembered: this run's person may not read "${place.ref}".` };
    return { scope: "collection", ref: place.ref };
  }
  return { error: "Not remembered: no such place." };
}

const scopeLabel = (r) => (r.scope === "agent" ? "shared" : r.scope === "personal" ? "only this person" : `readers of ${r.scopeRef}`);

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const server = new McpServer(
  { name: "memory", version: "0.1.0" },
  {
    instructions:
      "Your own memory, carried between conversations. Call memory_list at the " +
      "start of a conversation: it returns your ACTIVE memories — work in flight — " +
      "and how many inactive ones you have set aside. Use memory_write to record " +
      "a durable fact — a client's preference, a decision and its reason, a " +
      "correction someone made. When a piece of work is finished or paused, mark " +
      "its memories inactive with memory_set_active so they stop crowding the " +
      "live work; when it comes back, find them with memory_search and mark them " +
      "active again. Do not store transient detail you can look up again with " +
      "another tool.",
  },
);

const memoryRow = (r) => ({ key: r.key, content: r.content, updatedAt: r.updatedAt, kept: scopeLabel(r) });

server.registerTool(
  "memory_list",
  {
    description:
      "List your active memories (work in flight), most recently updated first, plus a count of inactive ones. Call this at the start of a conversation.",
    inputSchema: {
      include_inactive: z
        .boolean()
        .optional()
        .describe("Also return inactive memories (finished, paused or background work)."),
    },
  },
  async ({ include_inactive }) => {
    const rows = await sql`
      select key, content, active, scope, scope_ref as "scopeRef", updated_at as "updatedAt"
      from agent_memories where agent_id = ${AGENT_ID} and ${visible()}
      order by updated_at desc
    `;
    if (rows.length === 0) return text("You have no memories yet.");
    const active = rows.filter((r) => r.active).map(memoryRow);
    const inactive = rows.filter((r) => !r.active).map(memoryRow);
    if (include_inactive) return text({ active, inactive });
    return text({ active, inactiveCount: inactive.length });
  },
);

server.registerTool(
  "memory_search",
  {
    description:
      "Search all your memories, active and inactive, by keyword in the key or the content. Each result says whether it is active.",
    inputSchema: { query: z.string().describe("Keyword or phrase to look for.") },
  },
  async ({ query }) => {
    const term = `%${String(query ?? "").trim()}%`;
    const rows = await sql`
      select key, content, active, scope, scope_ref as "scopeRef", updated_at as "updatedAt"
      from agent_memories
      where agent_id = ${AGENT_ID} and ${visible()} and (key ilike ${term} or content ilike ${term})
      order by active desc, updated_at desc
      limit 20
    `;
    if (rows.length === 0) return text(`Nothing remembered matching "${query}".`);
    return text(rows.map((r) => ({ key: r.key, content: r.content, active: r.active, updatedAt: r.updatedAt, kept: scopeLabel(r) })));
  },
);

server.registerTool(
  "memory_write",
  {
    description:
      "Remember a fact under a short key. Writing an existing key replaces it — use that to correct yourself rather than recording a second, contradictory version. New and rewritten memories are active unless you say otherwise. " +
      "Who it is kept for — everyone who uses you, readers of a collection, or only the person you are working for — is decided by the hub from what this conversation touched; the answer says which.",
    inputSchema: {
      key: z
        .string()
        .min(1)
        .describe("Short stable name for this fact, e.g. 'client-reporting-cadence'."),
      content: z.string().min(1).describe("The fact, written so it still makes sense months later."),
      active: z
        .boolean()
        .optional()
        .describe("False to file it straight away as inactive (finished or background work). Default true."),
      // Set by the hub's gate, never by the model (it is removed from the schema the model sees).
      __place: z.string().optional(),
    },
  },
  async ({ key, content, active, __place }) => {
    const isActive = active ?? true;
    // CPR, card and account numbers are never kept (docs/sensitivity.md). Told
    // to the agent in words, so it can write the fact without the number.
    const refusal = identifierRefusal(`${key}\n${content}`);
    if (refusal) return text(refusal);
    const place = placeFor(__place);
    if (place.error) return text(place.error);
    const [row] = await sql`
      insert into agent_memories (agent_id, key, content, active, scope, scope_ref, written_by, source_run_id)
      values (${AGENT_ID}, ${key.trim()}, ${content}, ${isActive}, ${place.scope}, ${place.ref}, ${PRINCIPAL || null}, ${RUN_ID})
      on conflict (agent_id, key, scope, scope_ref) do update
        set content = excluded.content, active = excluded.active, updated_at = now(),
            written_by = coalesce(excluded.written_by, agent_memories.written_by),
            source_run_id = coalesce(excluded.source_run_id, agent_memories.source_run_id)
      returning key, scope, scope_ref as "scopeRef", (created_at = updated_at) as "isNew"
    `;
    return text(`${row.isNew ? "Remembered" : "Updated"} "${row.key}"${isActive ? "" : " (inactive)"}, kept for ${scopeLabel(row) === "shared" ? "everyone who uses this agent" : scopeLabel(row)}.`);
  },
);

server.registerTool(
  "memory_set_active",
  {
    description:
      "Mark a memory active (work in flight) or inactive (finished, paused or background) without changing what it says.",
    inputSchema: {
      key: z.string().min(1).describe("The key to move."),
      active: z.boolean().describe("True for active work, false to set it aside."),
    },
  },
  async ({ key, active }) => {
    const rows = await sql`
      update agent_memories set active = ${active}, updated_at = now()
       where id = ${byKey(key.trim())}
    `;
    return text(
      rows.count > 0
        ? `Marked "${key}" ${active ? "active" : "inactive"}.`
        : `Nothing was stored under "${key}".`,
    );
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
      delete from agent_memories where id = ${byKey(key.trim())}
    `;
    return text(rows.count > 0 ? `Forgot "${key}".` : `Nothing was stored under "${key}".`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
