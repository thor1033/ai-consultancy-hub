// Knowledge MCP server — what the Context Steward reads, and the three writes
// it may propose (docs/context-steward.md).
//
// The steward is a librarian: it reads what has been said and written lately
// and proposes what to file, remember or retire. The reads here are its eyes.
// The writes are its proposals: every one is annotated as a write, so the
// hub's approval gate holds it for a person, and approving replays the call
// through this same server. The server never decides to file; it only knows
// how, once a person has said yes.
//
// WHOSE CHATS it may read is each person's own decision, never an argument:
// the people who switched on "Let the Context Steward read my conversations"
// in Settings (principals.preferences.stewardMayRead). It used to be a list in
// the deployment's environment, HUB_STEWARD_READERS, which a person could not
// see or leave (docs/data-protection-review.md, F9); that variable is no
// longer read. A chat tool takes no principal, so a model cannot widen the set
// by asking. Sessions with no principal at all (a workbench run) are never
// served: nobody said yes for them. A disabled person is not read.
//
// WHERE it may file is checked when the write runs, which is at approval: a
// document sourced from a chat goes only where the person who had that chat
// may read; one sourced from a note in a restricted collection goes only to a
// restricted collection. The brief tells the steward the same rule so it does
// not propose what the check will refuse, but the check is what holds.
//
// Like servers/memory this talks to Postgres directly, because it runs as a
// bare `node server.mjs` child and @ai-hub/* is TypeScript only a bundler
// resolves. Filing and searching go through the hub's own HTTP API instead
// (HUB_BASE_URL + HUB_STEWARD_TOKEN): there is one chunking-and-embedding path
// in the hub, and a second one here would drift from it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import postgres from "postgres";
import { z } from "zod";

const DATABASE_URL = process.env.DATABASE_URL;
const HUB_URL = (process.env.HUB_BASE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.HUB_STEWARD_TOKEN ?? "";
if (process.env.HUB_STEWARD_READERS) {
  console.error("[knowledge] HUB_STEWARD_READERS is no longer read: each person allows the steward in their own Settings.");
}
/** Where the Secretary files meeting notes: the one collection read in full here. */
const NOTES_COLLECTION = process.env.HUB_STEWARD_NOTES_COLLECTION?.trim() || "meetings";
/** The steward's own slug: its chats are never its own material, and it has memory_* for itself. */
const SELF = "context-steward";
const TIMEZONE = process.env.HUB_TIMEZONE ?? process.env.M365_TIMEZONE ?? "UTC";

// stdout is the JSON-RPC channel, so refusals go to stderr.
if (!DATABASE_URL) {
  console.error("[knowledge] DATABASE_URL is not set — nothing to read. Refusing to start.");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failed = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

/** Tool bodies differ; their failure mode does not. */
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

const HUB_OFF =
  "The hub's API is not configured for the steward: set HUB_BASE_URL and HUB_STEWARD_TOKEN (a credential with the analyst role). See docs/context-steward.md.";

async function hub(path, body) {
  if (!HUB_URL || !TOKEN) throw new Error(HUB_OFF);
  const res = await fetch(`${HUB_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `The hub answered ${res.status} to ${path}: ${out.error ?? "no detail"}.` +
        (res.status === 401 ? " HUB_STEWARD_TOKEN is not a credential the hub accepts." : "") +
        (res.status === 403 ? " The steward's credential lacks the role this needs (analyst)." : ""),
    );
  }
  return out;
}

const localTime = (iso) =>
  iso && !Number.isNaN(new Date(iso).getTime())
    ? new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : null;

// Long text comes back a page at a time, never truncated: the correction that
// matters is as often at the end of a chat as at the start.
const PAGE_CHARS = 40_000;
function page(body, offset = 0) {
  const total = body.length;
  if (offset >= total && total > 0) return { slice: "", header: `Offset ${offset} is past the end (${total} characters).` };
  let end = Math.min(offset + PAGE_CHARS, total);
  if (end < total) {
    const nl = body.lastIndexOf("\n", end);
    if (nl > offset) end = nl + 1;
  }
  const header =
    end < total ? `Characters ${offset}–${end} of ${total}. There is more: call again with offset=${end}.` : offset > 0 ? `Characters ${offset}–${total} of ${total} (the end).` : null;
  return { slice: body.slice(offset, end), header };
}

function parseSince(since, fallbackDays) {
  if (!since) return new Date(Date.now() - fallbackDays * 864e5);
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── readers ──────────────────────────────────────────────────────────────────
// Resolved on every call rather than at startup: a person who switches it on
// is read from the next run, and one who switches it off is not read again.
async function readers() {
  return sql`
    select id, coalesce(nullif(email, ''), id) as who from principals
     where enabled and preferences->>'stewardMayRead' = 'true'
     order by id`;
}
async function readerIds() {
  return (await readers()).map((r) => r.id);
}

const NO_READERS =
  "No one has allowed the steward to read their chats. Each person decides for themselves, in Settings, under \"Context Steward\".";

// ── transcripts → text ───────────────────────────────────────────────────────
// The Anthropic message array, condensed to what a reader needs: who said what,
// and which tools were used, without the tool results (those are the agent's
// working, often pages of JSON, and the answer already reflects them).
function condense(transcript, person, agent) {
  const lines = [];
  let n = 0;
  for (const m of Array.isArray(transcript) ? transcript : []) {
    const who = m.role === "user" ? person : agent;
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    const said = [];
    const tools = [];
    let results = 0;
    for (const p of parts) {
      if (p.type === "text" && p.text?.trim()) said.push(p.text.trim());
      else if (p.type === "tool_use") tools.push(p.name);
      else if (p.type === "tool_result") results++;
    }
    if (said.length === 0 && tools.length === 0) continue; // a bare tool_result turn
    n++;
    const head = `[${n}] ${who}:`;
    const body = said.join("\n");
    const used = tools.length ? `  (used ${tools.join(", ")})` : "";
    lines.push(body ? `${head} ${body}${used}` : `${head}${used}`);
  }
  return lines.join("\n\n");
}

const SESSION_COLUMNS = `
  s.id, coalesce(s.started_at, s.created_at) as at, s.status, s.prompt, s.output, s.tools_used as "toolsUsed",
  a.slug as "agentSlug", a.name as "agentName",
  p.id as "principalId", p.email as "personEmail", p.display_name as "personName"
`;

// ── documents ────────────────────────────────────────────────────────────────
async function collectionVisibility(name) {
  const [row] = await sql`select visibility from collections where name = ${name}`;
  // A collection may exist only as a label on documents, with no row yet. The
  // hub's default for those is what HUB_DEFAULT_COLLECTION_VISIBILITY says;
  // here the safe reading is "restricted", so an unfiled label is never a
  // place a restricted source may leak into by omission.
  return row?.visibility ?? (process.env.HUB_DEFAULT_COLLECTION_VISIBILITY === "open" ? "open" : "restricted");
}

async function collectionExists(name) {
  const [row] = await sql`
    select exists(select 1 from collections where name = ${name})
        or exists(select 1 from documents where collection = ${name}) as ok`;
  return Boolean(row?.ok);
}

/** Whether a principal may read a collection, by the same rule retrieval uses (docs/knowledge-access.md). */
async function mayRead(principalId, collection) {
  const [p] = await sql`select roles from principals where id = ${principalId}`;
  if (!p) return false;
  const roles = Array.isArray(p.roles) ? p.roles : [];
  if (roles.includes("admin")) return true;
  if ((await collectionVisibility(collection)) === "open") return true;
  const [g] = await sql`select 1 from collection_grants where collection = ${collection} and principal_id = ${principalId}`;
  return Boolean(g);
}

async function documentText(id) {
  const rows = await sql`select content from document_chunks where document_id = ${id} order by chunk_index`;
  return rows.map((r) => r.content).join("\n");
}

// ── server ───────────────────────────────────────────────────────────────────
const server = new McpServer(
  { name: "knowledge", version: "0.1.0" },
  {
    instructions:
      "The steward's reading and its proposals. Read with knowledge_recent_chats, knowledge_chat_get, " +
      "knowledge_recent_notes, knowledge_document_get, knowledge_agent_memories, knowledge_find and " +
      "knowledge_collections. Propose with knowledge_file_document, knowledge_remember_for and " +
      "knowledge_retire_document: each of those is held for a person to approve, so give the reason a " +
      "reviewer needs, and name the source. Nothing is filed until someone says yes.",
  },
);

// Each tool SAYS which it is. The hub's gate holds any tool not declared
// read-only, so the reads declare it and pass, and the writes declare the
// opposite and wait for a person.
const withHint = (hint) => (name, config, handler) =>
  server.registerTool(name, { ...config, annotations: { ...hint, ...(config.annotations ?? {}) } }, handler);
const readTool = withHint({ readOnlyHint: true });
const writeTool = withHint({ readOnlyHint: false, destructiveHint: false });
const destructiveTool = withHint({ readOnlyHint: false, destructiveHint: true });

readTool(
  "knowledge_recent_chats",
  {
    description:
      "Conversations people have had with agents lately, newest first: who asked which agent what, and how it answered, in short. Only the chats of people who have allowed the steward to read them. Defaults to the last 7 days; pass `since` to continue from your last sweep. Read one in full with knowledge_chat_get.",
    inputSchema: {
      since: z.string().optional().describe("ISO 8601. Chats started after this moment. Defaults to 7 days ago."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum chats to return (default 25)."),
    },
  },
  async ({ since, limit }) =>
    attempt(async () => {
      const ids = await readerIds();
      if (ids.length === 0) return text(NO_READERS);
      const from = parseSince(since, 7);
      if (!from) return failed(`"${since}" is not a date I can read.`);
      const rows = await sql`
        select ${sql.unsafe(SESSION_COLUMNS)}
          from agent_sessions s
          join principals p on p.id = s.principal_id
          left join agents a on a.id = s.agent_id
         where s.principal_id = any(${ids}::text[])
           and coalesce(s.started_at, s.created_at) > ${from}
           and (a.slug is null or a.slug <> ${SELF})
           and s.status in ('succeeded', 'failed')
         order by coalesce(s.started_at, s.created_at) desc
         limit ${(limit ?? 25) + 1}`;
      const more = rows.length > (limit ?? 25);
      const chats = rows.slice(0, limit ?? 25).map((r) => ({
        sessionId: r.id,
        when: localTime(r.at),
        at: r.at,
        agent: r.agentName ?? "(no agent: a workbench session)",
        person: r.personName || r.personEmail,
        asked: (r.prompt ?? "").slice(0, 240),
        answered: (r.output ?? "").slice(0, 320),
        status: r.status,
        tools: Array.isArray(r.toolsUsed) ? r.toolsUsed : [],
      }));
      const who = (await readers()).map((r) => r.who);
      if (chats.length === 0) return text(`No chats since ${from.toISOString()} by the people who allow it (${who.join(", ")}).`);
      return text({
        since: from.toISOString(),
        readers: who,
        count: chats.length,
        chats,
        ...(more ? { note: "There are more: raise the limit, or sweep a shorter window." } : {}),
      });
    }),
);

readTool(
  "knowledge_chat_get",
  {
    description:
      "One conversation in full, condensed to who said what and which tools were used. Long chats come in pages — when the result says there is more, call again with the offset it gives.",
    inputSchema: {
      sessionId: z.string().min(1).describe("The sessionId from knowledge_recent_chats."),
      offset: z.number().int().min(0).optional(),
    },
  },
  async ({ sessionId, offset }) =>
    attempt(async () => {
      const ids = await readerIds();
      if (ids.length === 0) return text(NO_READERS);
      const [r] = await sql`
        select ${sql.unsafe(SESSION_COLUMNS)}, s.transcript
          from agent_sessions s
          join principals p on p.id = s.principal_id
          left join agents a on a.id = s.agent_id
         where s.id::text = ${sessionId}
           and s.principal_id = any(${ids}::text[])
           and (a.slug is null or a.slug <> ${SELF})`;
      if (!r) return failed("No such chat among the ones the steward may read. Ids come from knowledge_recent_chats.");
      const person = r.personName || r.personEmail;
      const body = condense(r.transcript, person, r.agentName ?? "Agent") || `${person}: ${r.prompt}\n\nAgent: ${r.output ?? "(no answer)"}`;
      const { slice, header } = page(body, offset ?? 0);
      return text(
        [`Chat: ${person} with ${r.agentName ?? "the workbench"}, ${localTime(r.at)} (${TIMEZONE})`, `Session: ${r.id}`, header, "", slice]
          .filter((l) => l !== null)
          .join("\n"),
      );
    }),
);

readTool(
  "knowledge_recent_notes",
  {
    description: `Meeting notes filed lately in the "${NOTES_COLLECTION}" collection, newest first, with a preview. Defaults to the last 7 days. Read one in full with knowledge_document_get.`,
    inputSchema: {
      since: z.string().optional().describe("ISO 8601. Notes filed after this moment. Defaults to 7 days ago."),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ since, limit }) =>
    attempt(async () => {
      const from = parseSince(since, 7);
      if (!from) return failed(`"${since}" is not a date I can read.`);
      const rows = await sql`
        select d.id, d.title, d.metadata, d.created_at as "createdAt", d.updated_at as "updatedAt",
               (select left(c.content, 300) from document_chunks c where c.document_id = d.id order by c.chunk_index limit 1) as preview
          from documents d
         where d.collection = ${NOTES_COLLECTION} and d.updated_at > ${from}
         order by d.updated_at desc
         limit ${limit ?? 25}`;
      if (rows.length === 0) return text(`No notes in "${NOTES_COLLECTION}" since ${from.toISOString()}.`);
      return text({
        collection: NOTES_COLLECTION,
        since: from.toISOString(),
        notes: rows.map((r) => ({ documentId: r.id, title: r.title, filed: localTime(r.updatedAt), url: r.metadata?.url ?? null, preview: r.preview ?? "" })),
      });
    }),
);

readTool(
  "knowledge_document_get",
  {
    description: `A meeting note in full, by documentId from knowledge_recent_notes. Only notes in "${NOTES_COLLECTION}" are read this way; for anything else, search with knowledge_find.`,
    inputSchema: { documentId: z.string().min(1), offset: z.number().int().min(0).optional() },
  },
  async ({ documentId, offset }) =>
    attempt(async () => {
      const [d] = await sql`select id, title, collection, metadata from documents where id::text = ${documentId}`;
      if (!d) return failed("No such document.");
      if (d.collection !== NOTES_COLLECTION) {
        return failed(`"${d.title}" is in "${d.collection ?? "no collection"}", not "${NOTES_COLLECTION}". Search it with knowledge_find; it is served to you as the steward's credential may read it.`);
      }
      const body = await documentText(d.id);
      const { slice, header } = page(body, offset ?? 0);
      return text([`Note: ${d.title}`, `Document: ${d.id}`, d.metadata?.url ? `Link: ${d.metadata.url}` : null, header, "", slice].filter((l) => l !== null).join("\n"));
    }),
);

readTool(
  "knowledge_agent_memories",
  {
    description:
      "What another agent remembers for everyone who uses it: its active shared memories, key and content. Read-only. A person's own memories, and those kept for the readers of a collection, are not shown. Use it to find facts an agent learned that are really company knowledge and should be a document, or facts another agent should also know.",
    inputSchema: { agentSlug: z.string().min(1).describe("The agent's slug, e.g. secretary.") },
  },
  async ({ agentSlug }) =>
    attempt(async () => {
      const [a] = await sql`select id, name from agents where slug = ${agentSlug}`;
      if (!a) return failed(`No agent "${agentSlug}".`);
      // Shared memories only (docs/memory-scopes.md): a person's own, and a
      // restricted collection's, are not the steward's to read, whoever it runs as.
      const rows = await sql`select key, content, updated_at as "updatedAt" from agent_memories where agent_id = ${a.id} and active and scope = 'agent' order by updated_at desc limit 200`;
      if (rows.length === 0) return text(`${a.name} has no active memories.`);
      return text({ agent: a.name, slug: agentSlug, memories: rows.map((r) => ({ key: r.key, content: r.content, updated: localTime(r.updatedAt) })) });
    }),
);

readTool(
  "knowledge_find",
  {
    description:
      "What the knowledge base already says about something: the passages closest to the query, with the document and collection each comes from. Use it before proposing, so you do not file what is already filed, and to see whether a recurring question has an answer.",
    inputSchema: {
      query: z.string().min(1).describe("What you are looking for, as a question or a phrase."),
      k: z.number().int().min(1).max(20).optional().describe("How many passages (default 6)."),
    },
  },
  async ({ query, k }) =>
    attempt(async () => {
      const out = await hub("/api/rag/search", { query, k: k ?? 6 });
      const chunks = Array.isArray(out.chunks) ? out.chunks : [];
      if (chunks.length === 0) return text(`Nothing in the knowledge base matches "${query}" (as far as the steward's credential may read).`);
      // The search answers with the passage and its document; which collection
      // that document sits in is what the steward needs to not file a second
      // copy, so it is looked up here.
      const ids = [...new Set(chunks.map((c) => c.documentId).filter((id) => typeof id === "string"))];
      const rows = ids.length ? await sql`select id::text as id, collection from documents where id::text = any(${ids}::text[])` : [];
      const collectionOf = new Map(rows.map((r) => [r.id, r.collection]));
      return text({
        query,
        passages: chunks.map((c) => ({
          documentId: c.documentId ?? null,
          title: c.title ?? null,
          collection: collectionOf.get(c.documentId) ?? c.collection ?? null,
          score: typeof c.score === "number" ? Number(c.score.toFixed(3)) : undefined,
          text: String(c.content ?? "").slice(0, 700),
        })),
      });
    }),
);

readTool(
  "knowledge_collections",
  {
    description:
      "Every collection, with its visibility (open: anyone signed in may read; restricted: only people granted it) and how many documents it holds. A proposal must name one of these; check visibility before filing anything from a chat or a restricted note.",
    inputSchema: {},
  },
  async () =>
    attempt(async () => {
      const rows = await sql`
        select n.name, coalesce(c.label, '') as label, coalesce(c.description, '') as description,
               coalesce(c.visibility, ${process.env.HUB_DEFAULT_COLLECTION_VISIBILITY === "open" ? "open" : "restricted"}) as visibility,
               (select count(*)::int from documents d where d.collection = n.name) as documents,
               (c.name is null) as "labelOnly"
          from (select name from collections union select distinct collection from documents where collection is not null) n
          left join collections c on c.name = n.name
         order by n.name`;
      if (rows.length === 0) return text("There are no collections yet.");
      return text({ collections: rows });
    }),
);

// ── the proposals ────────────────────────────────────────────────────────────
const SOURCE = z.object({
  kind: z.enum(["chat", "note", "memory"]).describe("Where this came from."),
  id: z.string().min(1).describe("The sessionId, documentId, or agentSlug it came from."),
  detail: z.string().optional().describe('Where in it, e.g. "turn 4" or "Decisions, item 2".'),
});

/**
 * The visibility rule, at the moment the write runs.
 *
 * chat: the person who had the chat must be able to read the target, so
 * nothing they said ends up somewhere they cannot see it. note: a restricted
 * note never feeds an open collection. memory: no source side to compare, so
 * the reviewer is the check.
 */
async function sourceAllows(source, collection) {
  if (source.kind === "chat") {
    const [s] = await sql`select principal_id as "principalId" from agent_sessions where id::text = ${source.id}`;
    if (!s) return "The source chat does not exist.";
    if (!s.principalId) return "The source chat has no person behind it (a workbench run); it is not steward material.";
    if (!(await readerIds()).includes(s.principalId)) return "The source chat belongs to someone who has not allowed the steward to read it.";
    if (!(await mayRead(s.principalId, collection))) {
      return `"${collection}" is not readable by the person who had that chat. What someone said cannot be filed where they cannot see it.`;
    }
    return null;
  }
  if (source.kind === "note") {
    const [d] = await sql`select collection from documents where id::text = ${source.id}`;
    if (!d) return "The source document does not exist.";
    const from = await collectionVisibility(d.collection ?? "");
    const to = await collectionVisibility(collection);
    if (from === "restricted" && to === "open") {
      return `The source is in "${d.collection}", which is restricted; "${collection}" is open. Nothing moves from a restricted collection into an open one.`;
    }
    return null;
  }
  const [a] = await sql`select 1 from agents where slug = ${source.id}`;
  return a ? null : `No agent "${source.id}" to source a memory from.`;
}

writeTool(
  "knowledge_file_document",
  {
    description:
      "Propose filing a new document in the knowledge base. Held for a person's approval; the reviewer reads the document as it will be retrieved, so write it as the finished document, not as a note to the reviewer. Name the collection (from knowledge_collections) and the source. Nothing from a restricted collection may go to an open one, and what a person said in a chat goes only where that person may read.",
    inputSchema: {
      title: z.string().min(3).max(200).describe("The document's title, as a reader would look for it."),
      collection: z.string().min(1).max(120).describe("An existing collection name."),
      content: z.string().min(40).max(60_000).describe("The document, in Markdown. State the fact, who decided or said it, and when."),
      source: SOURCE,
    },
  },
  async ({ title, collection, content, source }) =>
    attempt(async () => {
      const name = collection.trim();
      if (!(await collectionExists(name))) {
        return failed(`There is no collection "${name}". Pick one from knowledge_collections; a new collection is a decision for a person.`);
      }
      const refusal = await sourceAllows(source, name);
      if (refusal) return failed(refusal);
      const out = await hub("/api/documents", {
        title: title.trim(),
        content,
        collection: name,
        sourceType: "steward",
        source: `steward:${source.kind}:${source.id}`,
        metadata: { filedBy: SELF, source, filedAt: new Date().toISOString() },
      });
      return text({ filed: true, documentId: out.documentId ?? null, title: title.trim(), collection: name, chunks: out.chunks ?? null });
    }),
);

writeTool(
  "knowledge_remember_for",
  {
    description:
      "Propose adding a memory to another agent: a durable fact it keeps being told, or one it should know. Held for a person's approval. It is kept for EVERYONE who uses that agent, so never propose anything personal, confidential or from a restricted collection. Upserts by key, so a corrected fact replaces the old one. Not for your own memory — use memory_write for that.",
    inputSchema: {
      agentSlug: z.string().min(1).describe("The agent that should remember it."),
      key: z.string().min(1).max(120).describe("A short stable key, e.g. standup-day."),
      content: z.string().min(1).max(4000).describe("The fact, with who said it and when."),
      source: SOURCE,
    },
  },
  async ({ agentSlug, key, content, source }) =>
    attempt(async () => {
      if (agentSlug === SELF) return failed("That is your own memory: use memory_write.");
      const [a] = await sql`select id, name from agents where slug = ${agentSlug}`;
      if (!a) return failed(`No agent "${agentSlug}".`);
      const refusal = source.kind === "chat" ? await sourceAllows(source, NOTES_COLLECTION).then((r) => (r && /not exist|workbench|not allowed/.test(r) ? r : null)) : null;
      if (refusal) return failed(refusal);
      const [row] = await sql`
        insert into agent_memories (agent_id, key, content, active, scope, scope_ref)
        values (${a.id}, ${key.trim()}, ${content}, true, 'agent', '')
        on conflict (agent_id, key, scope, scope_ref) do update set content = excluded.content, active = true, updated_at = now()
        returning (created_at = updated_at) as "isNew"`;
      return text({ remembered: true, agent: a.name, key: key.trim(), replaced: !row.isNew });
    }),
);

destructiveTool(
  "knowledge_retire_document",
  {
    description:
      "Propose removing a document from the knowledge base because it is superseded or wrong. Held for a person's approval. Only documents that were filed by hand, by the steward, or from meeting notes can be retired here; a document synced from a system is retired at its source.",
    inputSchema: {
      documentId: z.string().min(1),
      supersededBy: z.string().optional().describe("The documentId that replaces it, if one does."),
    },
  },
  async ({ documentId, supersededBy }) =>
    attempt(async () => {
      const [d] = await sql`select id, title, collection, source_type as "sourceType" from documents where id::text = ${documentId}`;
      if (!d) return failed("No such document; it may already be gone.");
      if (!["manual", "steward", "teams-notes"].includes(d.sourceType)) {
        return failed(`"${d.title}" is synced from ${d.sourceType}; deleting it here would only last until the next sync. Retire it at the source.`);
      }
      if (supersededBy) {
        const [s] = await sql`select 1 from documents where id::text = ${supersededBy}`;
        if (!s) return failed(`The replacement ${supersededBy} does not exist.`);
      }
      await sql`delete from documents where id = ${d.id}`; // chunks cascade
      return text({ retired: true, documentId: d.id, title: d.title, collection: d.collection, supersededBy: supersededBy ?? null });
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
