// Verification of the `knowledge` MCP server — the Context Steward's reading
// and its three held writes.
//
//   node packages/mcp/verify-knowledge.mjs        # or: npm run verify:knowledge -w @ai-hub/mcp
//
// Needs DATABASE_URL and a migrated database; no API key and no spend. A
// throwaway HTTP server stands in for the hub's own API (filing and search),
// and every row the script needs — two people, three agents, five chats,
// three collections, a note, a synced document, memories — is created here and
// deleted at the end. The real server runs against them through
// builtinServerConfig -> connectMcpServers, as an agent run resolves it.
//
// The checks that decide whether this is a steward rather than a scraper:
// whose chats come back (only the people who allowed it, never the steward's
// own, never a workbench run), that every write is annotated as a write (so
// the hub's gate holds it), and that the visibility rule refuses a filing
// from a chat into a collection its person may not read, and from a
// restricted note into an open collection.
//
// What it cannot prove: the steward's judgement — that a month of real chats
// yields the right ten proposals and not fifty. That is the model's, and is
// read in the approvals queue.
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

const TOKEN = "verify-steward-token";
const RUN = Date.now().toString(36);
const FOUNDER = { id: `verify-founder-${RUN}`, email: `verify-founder-${RUN}@example.com`, name: "Thor Simonsen" };
const OTHER = { id: `verify-other-${RUN}`, email: `verify-other-${RUN}@example.com`, name: "Anna Holm" };
const NOTES = `verify-notes-${RUN}`;
const OPEN = `verify-open-${RUN}`;
const RESTRICTED = `verify-restricted-${RUN}`;
const LOCKED = `verify-locked-${RUN}`;
const LABEL_ONLY = `verify-label-only-${RUN}`;

// The 1024-dim zero vector: the chunk table demands an embedding, and nothing
// here reads it back (search is the fixture's).
const ZERO = `[${new Array(1024).fill(0).join(",")}]`;

// ── the throwaway hub ────────────────────────────────────────────────────────
const posts = [];
let hubAccepts = TOKEN;
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const json = (status, out) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  };
  posts.push({ path: req.url, authorization: req.headers.authorization, body });
  if (req.headers.authorization !== `Bearer ${hubAccepts}`) return json(401, { error: "Unauthorized: missing or invalid bearer token." });
  if (req.url === "/api/rag/search") {
    return json(200, {
      query: body.query,
      chunks: /liability/i.test(body.query)
        ? [{ documentId: "doc-terms", title: "Standard contract terms", collection: OPEN, content: "The liability cap is twelve months of fees.", score: 0.91 }]
        : [],
    });
  }
  if (req.url === "/api/documents") {
    if (typeof body.content !== "string" || !body.content.trim()) return json(400, { error: "`content` (non-empty string) is required." });
    // Lands as a real row, so a later retire can act on it.
    const [doc] = await sql`
      insert into documents (source_type, source, collection, title, metadata)
      values (${body.sourceType ?? "manual"}, ${body.source ?? null}, ${body.collection ?? null}, ${body.title ?? ""}, ${sql.json(body.metadata ?? {})})
      returning id`;
    await sql`insert into document_chunks (document_id, chunk_index, content, embedding) values (${doc.id}, 0, ${body.content}, ${ZERO}::vector)`;
    return json(201, { documentId: doc.id, chunks: 1, embedder: "fixture", replaced: 0 });
  }
  return json(404, { error: `No route ${req.url}` });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${http.address().port}`;

// ── fixture rows ─────────────────────────────────────────────────────────────
const created = { agents: [], sessions: [], documents: [], collections: [], principals: [] };
let stewardWasThere = false;

async function principal(p, roles) {
  await sql`insert into principals (id, email, display_name, roles) values (${p.id}, ${p.email}, ${p.name}, ${sql.json(roles)})`;
  created.principals.push(p.id);
}
async function agent(slug, name) {
  const [row] = await sql`insert into agents (slug, name, description) values (${slug}, ${name}, 'Temporary.') returning id`;
  created.agents.push(row.id);
  return row.id;
}
async function session({ agentId, principalId, prompt, transcript, output, at, status = "succeeded" }) {
  const [row] = await sql`
    insert into agent_sessions (agent_id, principal_id, prompt, transcript, output, status, started_at)
    values (${agentId}, ${principalId}, ${prompt}, ${sql.json(transcript)}, ${output}, ${status}, ${at})
    returning id`;
  created.sessions.push(row.id);
  return row.id;
}
async function collection(name, visibility) {
  await sql`insert into collections (name, label, visibility) values (${name}, ${name}, ${visibility})`;
  created.collections.push(name);
}
async function document({ collection, title, content, sourceType = "manual", metadata = {}, at }) {
  const [row] = await sql`
    insert into documents (source_type, collection, title, metadata, created_at, updated_at)
    values (${sourceType}, ${collection}, ${title}, ${sql.json(metadata)}, ${at ?? new Date()}, ${at ?? new Date()})
    returning id`;
  await sql`insert into document_chunks (document_id, chunk_index, content, embedding) values (${row.id}, 0, ${content}, ${ZERO}::vector)`;
  created.documents.push(row.id);
  return row.id;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const lastPost = (path) => [...posts].reverse().find((p) => p.path === path);

let mcp;
try {
  await principal(FOUNDER, ["analyst"]);
  await principal(OTHER, ["analyst"]);
  const targetId = await agent(`verify-target-${RUN}`, "Project Manager (verify)");
  const [self] = await sql`select id from agents where slug = 'context-steward'`;
  stewardWasThere = Boolean(self);
  const stewardId = self?.id ?? (await agent("context-steward", "Context Steward (verify)"));

  const DECISION = [
    { role: "user", content: "Did we settle the standup day? I keep forgetting." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check the board." },
        { type: "tool_use", id: "t1", name: "pm_project_status", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"tasks": 114, "late": 3}' }] },
    { role: "assistant", content: "Yes: on 14 October Ditlev moved the standup from Friday to Thursday 09:00. The board still says Friday." },
    { role: "user", content: "Right. No, actually — we agreed Thursday 09:30, not 09:00." },
    { role: "assistant", content: "Noted: Thursday 09:30." },
  ];
  const founderChat = await session({ agentId: targetId, principalId: FOUNDER.id, prompt: DECISION[0].content, transcript: DECISION, output: "Noted: Thursday 09:30.", at: hoursAgo(20) });
  const otherChat = await session({ agentId: targetId, principalId: OTHER.id, prompt: "What is my salary band?", transcript: [{ role: "user", content: "What is my salary band?" }], output: "Band C.", at: hoursAgo(10) });
  const ownChat = await session({ agentId: stewardId, principalId: FOUNDER.id, prompt: "Sweep.", transcript: [{ role: "user", content: "Sweep." }], output: "Nothing new.", at: hoursAgo(2) });
  const oldChat = await session({ agentId: targetId, principalId: FOUNDER.id, prompt: "Old question.", transcript: [{ role: "user", content: "Old question." }], output: "Old answer.", at: hoursAgo(24 * 10) });
  const workbench = await session({ agentId: null, principalId: null, prompt: "Workbench.", transcript: [{ role: "user", content: "Workbench." }], output: "Hm.", at: hoursAgo(1) });
  const longTurns = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Turn ${i}: ${"detail ".repeat(30)}` }));
  const longChat = await session({ agentId: targetId, principalId: FOUNDER.id, prompt: "Long one.", transcript: longTurns, output: "Done.", at: hoursAgo(30) });

  await collection(NOTES, "restricted");
  await collection(OPEN, "open");
  await collection(RESTRICTED, "restricted");
  await collection(LOCKED, "restricted");
  await sql`insert into collection_grants (collection, principal_id) values (${NOTES}, ${FOUNDER.id}), (${RESTRICTED}, ${FOUNDER.id})`;
  const note = await document({ collection: NOTES, title: "2026-10-14 Teqneo Check-In", content: "## Decisions\n\n1. Standup moves to Thursday 09:30.\n\n## Actions\n\n- [ ] Update the board — Thor", sourceType: "teams-notes", metadata: { url: "https://example.sharepoint.com/note" }, at: hoursAgo(15) });
  const oldNote = await document({ collection: NOTES, title: "2026-09-01 Old check-in", content: "Old.", sourceType: "teams-notes", at: hoursAgo(24 * 20) });
  const synced = await document({ collection: OPEN, title: "Helios — Scope", content: "Scope.", sourceType: "pm-tool" });
  const labelOnly = await document({ collection: LABEL_ONLY, title: "Unfiled label", content: "A document whose collection has no row." });
  await sql`insert into agent_memories (agent_id, key, content, active) values (${targetId}, 'standup-day', 'Standup is Friday 09:00.', true), (${targetId}, 'old-client', 'Finished.', false)`;

  // ── startup ────────────────────────────────────────────────────────────────
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, "servers", "knowledge", "server.mjs");
  const noDb = spawnSync(process.execPath, [serverPath], { env: { ...process.env, DATABASE_URL: "" }, input: "", encoding: "utf8", timeout: 10_000 });
  check("without DATABASE_URL it refuses to start, on stderr only", noDb.status === 1 && /DATABASE_URL/.test(noDb.stderr) && noDb.stdout === "", noDb.stderr.trim());

  Object.assign(process.env, {
    HUB_BASE_URL: `${origin}/`,
    HUB_STEWARD_TOKEN: TOKEN,
    HUB_STEWARD_NOTES_COLLECTION: NOTES,
    HUB_TIMEZONE: "Europe/Copenhagen",
  });

  // Whose chats it reads is each person's own switch (principals.preferences.stewardMayRead).
  await sql`update principals set preferences = preferences || '{"stewardMayRead": true}'::jsonb where id = ${FOUNDER.id}`;

  const { connectMcpServers } = await import("./src/manager.ts");
  const { builtinServerConfig, BUILTIN_SERVER_NAMES, BUILTIN_SERVER_INFO } = await import("./src/servers.ts");
  check("knowledge is a built-in server that describes itself", BUILTIN_SERVER_NAMES.includes("knowledge") && BUILTIN_SERVER_INFO.some((i) => i.name === "knowledge" && /approval/.test(i.description)));

  mcp = await connectMcpServers([builtinServerConfig("knowledge")]);
  const details = mcp.details;
  const names = details.map((t) => t.name).sort();
  check("ten tools", names.length === 10, names.join(", "));
  const reads = ["knowledge_recent_chats", "knowledge_chat_get", "knowledge_recent_notes", "knowledge_document_get", "knowledge_agent_memories", "knowledge_find", "knowledge_collections"];
  const writes = ["knowledge_file_document", "knowledge_remember_for", "knowledge_retire_document"];
  check(
    "every read declares readOnlyHint: true, so the gate lets it through",
    reads.every((n) => details.find((t) => t.name === n)?.annotations?.readOnlyHint === true),
  );
  check(
    "every write declares readOnlyHint: false, so the gate holds it for a person",
    writes.every((n) => details.find((t) => t.name === n)?.annotations?.readOnlyHint === false),
  );
  check("retiring is the one destructive write", details.find((t) => t.name === "knowledge_retire_document")?.annotations?.destructiveHint === true && details.find((t) => t.name === "knowledge_file_document")?.annotations?.destructiveHint === false);
  check("no write tool declares its own reason argument (the gate adds one)", writes.every((n) => !("reason" in (details.find((t) => t.name === n)?.inputSchema?.properties ?? {}))));

  // ── chats ──────────────────────────────────────────────────────────────────
  const recent = parse(await mcp.execute("knowledge_recent_chats", {}));
  const ids = (recent.chats ?? []).map((c) => c.sessionId);
  check("recent chats: the founder's, newest first", ids[0] === founderChat && ids.includes(longChat), ids.length ? `${ids.length} chats` : String(recent).slice(0, 80));
  check("not the other person's, who has not allowed it", !ids.includes(otherChat));
  check("not the steward's own", !ids.includes(ownChat));
  check("not a workbench run with nobody behind it", !ids.includes(workbench));
  check("not one older than the default window", !ids.includes(oldChat));
  check("readers are the people who allowed it themselves, and only they", recent.readers?.includes(FOUNDER.email) && recent.chats?.[0]?.person === FOUNDER.name && recent.chats.every((c) => c.person === FOUNDER.name), JSON.stringify(recent.readers));
  check("each chat says who asked which agent what, and the answer in short", recent.chats?.[0]?.agent === "Project Manager (verify)" && /standup day/.test(recent.chats[0].asked) && /Thursday 09:30/.test(recent.chats[0].answered) && recent.chats[0].tools?.[0] === undefined);
  const windowed = parse(await mcp.execute("knowledge_recent_chats", { since: hoursAgo(24).toISOString() }));
  check("`since` narrows the window (the cursor a sweep continues from)", windowed.chats?.length === 1 && windowed.chats[0].sessionId === founderChat);
  const badSince = await mcp.execute("knowledge_recent_chats", { since: "yesterday" });
  check("an unreadable since is refused", /not a date I can read/.test(badSince));

  const full = await mcp.execute("knowledge_chat_get", { sessionId: founderChat });
  // A bare tool_result turn is the agent's working, not a thing anyone said,
  // so the numbering skips it: the answer after the tool call is turn 3.
  check("chat_get condenses to who said what, numbered, skipping bare tool results", /\[1\] Thor Simonsen: Did we settle the standup day/.test(full) && /\[3\] Project Manager \(verify\): Yes: on 14 October/.test(full), full.split("\n").find((l) => l.startsWith("[3]"))?.slice(0, 60));
  check("tool use is named, the tool result is not pasted", /\(used pm_project_status\)/.test(full) && !/"tasks": 114/.test(full));
  check("the correction at the end is there", /\[4\] Thor Simonsen: Right\. No, actually/.test(full) && /\[5\] Project Manager \(verify\): Noted: Thursday 09:30\./.test(full));
  const refused = await mcp.execute("knowledge_chat_get", { sessionId: otherChat });
  check("another person's chat is refused by id too", /Tool error/.test(refused) && /may read/.test(refused));
  const p1 = await mcp.execute("knowledge_chat_get", { sessionId: longChat });
  const next = Number(p1.match(/offset=(\d+)/)?.[1]);
  check("a long chat comes in pages with the offset to continue from", next > 0 && /Turn 0:/.test(p1) && !/Turn 399:/.test(p1), `next ${next}`);
  let offset = next;
  let pages = 1;
  let last = p1;
  while (offset && pages < 10) {
    last = await mcp.execute("knowledge_chat_get", { sessionId: longChat, offset });
    pages++;
    offset = Number(last.match(/call again with offset=(\d+)/)?.[1]) || 0;
  }
  check("and following the offsets reaches the end with nothing lost", pages >= 2 && /Turn 399:/.test(last) && /the end/.test(last), `${pages} pages`);

  // ── notes ──────────────────────────────────────────────────────────────────
  const notes = parse(await mcp.execute("knowledge_recent_notes", {}));
  check("recent notes: the week's, from the notes collection only", notes.notes?.length === 1 && notes.notes[0].documentId === note && /Decisions/.test(notes.notes[0].preview), JSON.stringify(notes).slice(0, 100));
  const noteText = await mcp.execute("knowledge_document_get", { documentId: note });
  check("document_get reads a note in full, with its link", /Standup moves to Thursday 09:30/.test(noteText) && /Link: https:\/\/example.sharepoint.com\/note/.test(noteText));
  const notANote = await mcp.execute("knowledge_document_get", { documentId: synced });
  check("but refuses a document outside the notes collection, pointing at knowledge_find", /Tool error/.test(notANote) && /knowledge_find/.test(notANote));

  // ── memory, find, collections ──────────────────────────────────────────────
  const mem = parse(await mcp.execute("knowledge_agent_memories", { agentSlug: `verify-target-${RUN}` }));
  check("agent_memories: active memories only", mem.memories?.length === 1 && mem.memories[0].key === "standup-day");
  const found = parse(await mcp.execute("knowledge_find", { query: "liability cap" }));
  check("find searches through the hub's API as the steward's credential", lastPost("/api/rag/search")?.authorization === `Bearer ${TOKEN}` && found.passages?.[0]?.title === "Standard contract terms", JSON.stringify(found).slice(0, 80));
  const nothing = await mcp.execute("knowledge_find", { query: "onboarding steps" });
  check("and says in words when nothing matches", /Nothing in the knowledge base matches/.test(nothing));
  const cols = parse(await mcp.execute("knowledge_collections", {}));
  const byName = new Map((cols.collections ?? []).map((c) => [c.name, c]));
  check("collections: visibility and counts", byName.get(OPEN)?.visibility === "open" && byName.get(RESTRICTED)?.visibility === "restricted" && byName.get(NOTES)?.documents === 2);
  check("a label with no row is listed as such, and reads as restricted", byName.get(LABEL_ONLY)?.labelOnly === true && byName.get(LABEL_ONLY)?.visibility === "restricted");

  // ── filing: the rule ───────────────────────────────────────────────────────
  const DOC = { title: "Standup day and time", content: "# Standup\n\nThe weekly standup is on **Thursday at 09:30**. Decided by Ditlev on 14 October 2026; corrected from 09:00 by Thor in a chat on the 27th. The board still said Friday at the time.\n" };
  const before = posts.length;
  const noSuch = await mcp.execute("knowledge_file_document", { ...DOC, collection: `nope-${RUN}`, source: { kind: "chat", id: founderChat } });
  check("filing into a collection that does not exist is refused, and nothing is posted", /Tool error/.test(noSuch) && /no collection/.test(noSuch) && posts.length === before);
  const locked = await mcp.execute("knowledge_file_document", { ...DOC, collection: LOCKED, source: { kind: "chat", id: founderChat } });
  check("a chat cannot be filed where the person who had it may not read", /Tool error/.test(locked) && /cannot be filed where they cannot see it/.test(locked) && posts.length === before, locked.split("\n")[0].slice(0, 90));
  const others = await mcp.execute("knowledge_file_document", { ...DOC, collection: OPEN, source: { kind: "chat", id: otherChat } });
  check("nor from a chat of someone who has not allowed it", /Tool error/.test(others) && /not allowed/.test(others) && posts.length === before);
  const wb = await mcp.execute("knowledge_file_document", { ...DOC, collection: OPEN, source: { kind: "chat", id: workbench } });
  check("nor from a workbench run", /Tool error/.test(wb) && /workbench/.test(wb) && posts.length === before);
  const leak = await mcp.execute("knowledge_file_document", { ...DOC, collection: OPEN, source: { kind: "note", id: note } });
  check("a restricted note never feeds an open collection", /Tool error/.test(leak) && /restricted/.test(leak) && posts.length === before, leak.split("\n")[0].slice(0, 90));

  const filed = parse(await mcp.execute("knowledge_file_document", { ...DOC, collection: RESTRICTED, source: { kind: "chat", id: founderChat, detail: "turn 5" } }));
  const post = lastPost("/api/documents");
  check("a chat files where its person may read, through the hub's ingest with the steward's credential", filed.filed === true && post?.authorization === `Bearer ${TOKEN}` && post.body.collection === RESTRICTED, JSON.stringify(filed).slice(0, 80));
  check("the filing names its source and who filed it", post?.body.sourceType === "steward" && post.body.source === `steward:chat:${founderChat}` && post.body.metadata?.source?.detail === "turn 5" && post.body.metadata?.filedBy === "context-steward");
  check("and the document is the document, not a note to the reviewer", post?.body.title === DOC.title && post.body.content === DOC.content);
  if (filed.documentId) created.documents.push(filed.documentId);
  const fromNote = parse(await mcp.execute("knowledge_file_document", { ...DOC, title: "From the note", collection: RESTRICTED, source: { kind: "note", id: note } }));
  check("a restricted note files into a restricted collection", fromNote.filed === true);
  if (fromNote.documentId) created.documents.push(fromNote.documentId);
  const openFromMemory = parse(await mcp.execute("knowledge_file_document", { ...DOC, title: "From memory", collection: OPEN, source: { kind: "memory", id: `verify-target-${RUN}` } }));
  check("a memory files anywhere that exists (the reviewer is the check)", openFromMemory.filed === true);
  if (openFromMemory.documentId) created.documents.push(openFromMemory.documentId);

  // ── remember ───────────────────────────────────────────────────────────────
  const rem = parse(await mcp.execute("knowledge_remember_for", { agentSlug: `verify-target-${RUN}`, key: "standup-day", content: "Standup is Thursday 09:30 (Ditlev, 14 Oct; corrected by Thor 27 Oct).", source: { kind: "chat", id: founderChat } }));
  const [m] = await sql`select content, active from agent_memories where agent_id = ${targetId} and key = 'standup-day'`;
  check("remember_for upserts the agent's memory by key, active", rem.remembered === true && rem.replaced === true && /Thursday 09:30/.test(m.content) && m.active === true);
  const selfMem = await mcp.execute("knowledge_remember_for", { agentSlug: "context-steward", key: "x", content: "y", source: { kind: "memory", id: `verify-target-${RUN}` } });
  check("its own memory is refused here (memory_write is for that)", /Tool error/.test(selfMem) && /memory_write/.test(selfMem));
  const noAgent = await mcp.execute("knowledge_remember_for", { agentSlug: "no-such-agent", key: "x", content: "y", source: { kind: "memory", id: `verify-target-${RUN}` } });
  check("an unknown agent is refused", /Tool error/.test(noAgent) && /No agent/.test(noAgent));

  // ── retire ─────────────────────────────────────────────────────────────────
  const keepSynced = await mcp.execute("knowledge_retire_document", { documentId: synced });
  check("a synced document is not retired here", /Tool error/.test(keepSynced) && /at the source/.test(keepSynced));
  const badReplacement = await mcp.execute("knowledge_retire_document", { documentId: oldNote, supersededBy: "00000000-0000-0000-0000-000000000000" });
  check("a replacement that does not exist is refused", /Tool error/.test(badReplacement) && /does not exist/.test(badReplacement));
  const retired = parse(await mcp.execute("knowledge_retire_document", { documentId: oldNote, supersededBy: note }));
  const [{ n }] = await sql`select count(*)::int as n from document_chunks where document_id = ${oldNote}`;
  check("retiring a filed note deletes it and its chunks", retired.retired === true && n === 0);
  check("everything the steward did went through the hub or the store, never past the rule", posts.filter((p) => p.path === "/api/documents").length === 3);

  await mcp.close();
  mcp = undefined;

  // ── without readers, without the hub ───────────────────────────────────────
  // The founder switches it off in Settings. Others in this database may have
  // it on, so the check is that the founder's chats are gone, not that nobody is read.
  await sql`update principals set preferences = preferences - 'stewardMayRead' where id = ${FOUNDER.id}`;
  process.env.HUB_STEWARD_READERS = FOUNDER.email; // no longer read: setting it must not bring them back
  const noReaders = await connectMcpServers([builtinServerConfig("knowledge")]);
  try {
    const r = await noReaders.execute("knowledge_recent_chats", { since: "2000-01-01" });
    check("once the person switches it off, their chats are not read — whatever the old env variable says", !r.includes(founderChat) && !r.includes(FOUNDER.email), r.slice(0, 120));
    const g = await noReaders.execute("knowledge_chat_get", { sessionId: founderChat });
    check("by id as well", /No one has allowed|No such chat/.test(g), g.slice(0, 120));
    const [{ n }] = await sql`select count(*)::int as n from principals where enabled and preferences->>'stewardMayRead' = 'true'`;
    if (n === 0) check("with nobody allowing it, the chat tools say so and where it is decided", /No one has allowed/.test(r) && /Settings/.test(r));
  } finally {
    await noReaders.close();
  }
  delete process.env.HUB_STEWARD_READERS;
  await sql`update principals set preferences = preferences || '{"stewardMayRead": true}'::jsonb where id = ${FOUNDER.id}`;
  process.env.HUB_STEWARD_TOKEN = "";
  const noHub = await connectMcpServers([builtinServerConfig("knowledge")]);
  try {
    const f = await noHub.execute("knowledge_find", { query: "x" });
    const w = await noHub.execute("knowledge_file_document", { ...DOC, collection: RESTRICTED, source: { kind: "chat", id: founderChat } });
    check("without the hub's credential, find and file say which variables are missing", /HUB_STEWARD_TOKEN/.test(f) && /Tool error/.test(w) && /HUB_STEWARD_TOKEN/.test(w));
  } finally {
    await noHub.close();
  }
  process.env.HUB_STEWARD_TOKEN = "wrong-token";
  const badToken = await connectMcpServers([builtinServerConfig("knowledge")]);
  try {
    const f = await badToken.execute("knowledge_find", { query: "x" });
    check("a credential the hub refuses is named as the cause", /Tool error/.test(f) && /401/.test(f) && /HUB_STEWARD_TOKEN/.test(f));
  } finally {
    await badToken.close();
  }
} finally {
  await mcp?.close().catch(() => {});
  http.close();
  // Children first, then what they hang from.
  for (const id of created.sessions) await sql`delete from agent_sessions where id = ${id}`;
  for (const id of created.documents) await sql`delete from documents where id = ${id}`;
  await sql`delete from documents where source like ${"steward:%"} and collection = any(${[OPEN, RESTRICTED, LOCKED, NOTES]}::text[])`;
  for (const name of created.collections) await sql`delete from collections where name = ${name}`;
  for (const id of created.agents) await sql`delete from agents where id = ${id}`;
  for (const id of created.principals) await sql`delete from principals where id = ${id}`;
  await sql.end({ timeout: 5 });
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(failedChecks.length ? `\n${failedChecks.length} of ${checks.length} checks FAILED` : `\nKnowledge MCP server OK (${checks.length} checks)`);
process.exit(failedChecks.length ? 1 : 0);
