// The web as a tool an agent may be given (docs/web.md): through the shipping
// run path against a real database, with a throwaway Messages API that
// answers as if it had searched.
//
//   node --experimental-transform-types --env-file=.env.local verify-web.mjs
//
// Needs DATABASE_URL and a migrated database. No API key and no spend.
//
// What is proven: a web entry on an agent reaches the request as the API's
// own search and fetch tools with the entry's bounds; the run's memory writes
// are held for a person and the model told, because a page can carry
// instructions; what the run remembers is kept for its person; the searches
// are counted on the run and the tools named; on another model provider the
// web is dropped from the run and said; the design save keeps a web entry's
// sites as hostnames and its counts, and refuses junk in words.
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = new URL("./src/", import.meta.url);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier.slice(2) + ext, base);
        if (existsSync(fileURLToPath(url)) && (ext !== "" || /\.(tsx?|mjs|js)$/.test(url.pathname))) return { url: url.href, shortCircuit: true };
      }
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".")) return nextResolve(`${specifier}.js`, context);
      if (!context.parentURL) throw err;
      for (const ext of [".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
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
  console.error("DATABASE_URL is not set — run with --env-file=.env.local");
  process.exit(1);
}

const stamp = Date.now();
// A stand-in Messages API: an agent given the web searches once inside the
// request, then tries to remember what it read, then answers with a citation.
// One without the web tries to remember straight away.
const calls = [];
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n"));
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const last = body.messages.at(-1);
  const lastResult = last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? textOf(last.content) : null;
  const toolsSeen = body.messages.filter((m) => m.role === "assistant" && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === "tool_use" || b.type === "server_tool_use").map((b) => b.name));
  calls.push({ tools: body.tools ?? [], lastResult, model: body.model });
  const hasWeb = (body.tools ?? []).some((t) => t.name === "web_search");
  const canRemember = (body.tools ?? []).some((t) => t.name === "memory_write");
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  send({ type: "message_start", message: { id: `m${calls.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  let index = 0;
  let searched = false;
  let stop = "end_turn";
  const blocks = [];
  if (hasWeb && !toolsSeen.includes("web_search")) {
    searched = true;
    send({ type: "content_block_start", index: index, content_block: { type: "server_tool_use", id: "st_1", name: "web_search", input: {} } });
    send({ type: "content_block_delta", index: index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "acme pricing" }) } });
    send({ type: "content_block_stop", index: index++ });
    send({ type: "content_block_start", index: index, content_block: { type: "web_search_tool_result", tool_use_id: "st_1", content: [{ type: "web_search_result", url: "https://acme.example/pricing", title: "Pricing", encrypted_content: "x", page_age: null }] } });
    send({ type: "content_block_stop", index: index++ });
  }
  if (canRemember && !toolsSeen.includes("memory_write")) {
    blocks.push({ type: "tool_use", id: `tu_${calls.length}`, name: "memory_write", input: { key: "competitor:acme", content: hasWeb ? "Acme charges 99 a seat. checked today" : "No web here." } });
    stop = "tool_use";
  } else blocks.push({ type: "text", text: hasWeb ? "Acme charges 99 a seat (https://acme.example/pricing)." : "I could not look." });
  for (const b of blocks) {
    if (b.type === "text") {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      send({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send({ type: "content_block_stop", index: index++ });
  }
  send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20, ...(searched ? { server_tool_use: { web_search_requests: 1 } } : {}) } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${http.address().port}`;
process.env.ANTHROPIC_API_KEY = "fixture-key";
delete process.env.LANGFUSE_PUBLIC_KEY;
delete process.env.HUB_MODEL_PROVIDER;

const db = await import("../../packages/db/src/index.ts");
const { runAgentForPrincipal } = await import("./src/lib/agentRuns.ts");
const { webProblem, unavailableServers, knownServers } = await import("./src/lib/runSession.ts");
const { saveAgentAs } = await import("./src/lib/agentDesign.ts");
const sql = db.getSql();
const PERSON = { id: `verify-web-person-${stamp}`, roles: ["admin"], source: "credential" };
const made = [];
const draft = (slug, mcpServers) => ({ slug, name: slug, description: "", instructions: "x", model: "", knowledgeAll: false, knowledgeCollections: [], maxIterations: null, mcpServers, functionName: "", owner: "" });

try {
  console.log("— the entry —");
  check("the web is a known pseudo-server, like the ask entry", knownServers().includes("web"));
  check("webOptionsFrom reads the bounds and ignores junk", JSON.stringify(db.webOptionsFrom({ name: "web", searches: 12, fetches: "x", only: ["acme.example", 3], search: "no", fetch: false })) === '{"fetch":false,"maxSearches":12,"allowedDomains":["acme.example"]}' && JSON.stringify(db.webOptionsFrom("junk")) === "{}", JSON.stringify(db.webOptionsFrom({ name: "web", searches: 12, fetches: "x", only: ["acme.example", 3], search: "no", fetch: false })));
  check("on the Anthropic provider the web has no problem", webProblem({}) === null);
  check("on Bedrock it has one, in words", /Claude API's own tools.*bedrock/.test(webProblem({ HUB_MODEL_PROVIDER: "bedrock" }) ?? ""));

  console.log("\n— a run with the web —");
  await db.upsertPrincipal({ id: PERSON.id, roles: PERSON.roles, displayName: "Verify web", email: null });
  const agent = await db.createAgent({ slug: `verify-web-${stamp}`, name: "Webbed", instructions: "WEB BRIEF", keepsMemory: true, mcpServers: [{ name: "web", searches: 5, only: ["acme.example"] }] });
  made.push(agent.id);
  const out = await runAgentForPrincipal({ agentRef: agent.id, prompt: "What does Acme charge?", principal: PERSON, deadlineMs: 60_000 });
  check("the run finishes with the cited answer", out.kind === "done" && /https:\/\/acme\.example\/pricing/.test(out.output), out.kind === "error" ? out.message : out.output?.slice(0, 80));
  const first = calls[0];
  const search = first?.tools.find((t) => t.name === "web_search");
  const fetch = first?.tools.find((t) => t.name === "web_fetch");
  check("the request carried the API's search and fetch tools with the entry's bounds, beside the memory tools", search?.type === "web_search_20260209" && search.max_uses === 5 && JSON.stringify(search.allowed_domains) === '["acme.example"]' && fetch?.type === "web_fetch_20260209" && first.tools.some((t) => t.name === "memory_list"), JSON.stringify(first?.tools.map((t) => t.name)));
  check("the web tools carry no approval reason line: they are the API's, not the gate's", !("input_schema" in (search ?? {})));
  const [row] = await sql`select tools_used as tools, cost_usd::float8 as cost from agent_sessions where id = ${out.runId}`;
  check("the run names web_search among its tools and its cost includes the search", row?.tools.includes("web_search") && row.cost >= 0.01, JSON.stringify(row));
  const held = await sql`select tool, status, reason, args from proposals where run_id = ${out.runId}`;
  check("the memory write it tried after reading the web was held for a person, with the reason", held.length === 1 && held[0].tool === "memory_write" && held[0].status === "pending" && /Remembered after reading from the web/.test(held[0].reason), JSON.stringify(held.map((h) => [h.tool, h.status, h.reason])));
  check("and the model was told it was held, not that it happened", calls.some((c) => /HELD FOR APPROVAL/.test(c.lastResult ?? "")));
  check("so the agent remembers nothing from the web until a person approves", (await sql`select count(*)::int as n from agent_memories where agent_id = ${agent.id}`)[0].n === 0);
  check("what it would remember is placed for its person, not shared", /"scope":"personal"/.test(String(held[0]?.args?.__place ?? "")), String(held[0]?.args?.__place));

  console.log("\n— a run without the web —");
  calls.length = 0;
  const plain = await db.createAgent({ slug: `verify-web-plain-${stamp}`, name: "Plain", instructions: "WEB BRIEF", keepsMemory: true, mcpServers: [] });
  made.push(plain.id);
  const dry = await runAgentForPrincipal({ agentRef: plain.id, prompt: "What does Acme charge?", principal: PERSON, deadlineMs: 60_000 });
  check("an agent without the entry gets no web tools, and its memory write goes through", dry.kind === "done" && !calls[0].tools.some((t) => /web/.test(t.name)) && (await sql`select count(*)::int as n from agent_memories where agent_id = ${plain.id}`)[0].n === 1, `${calls[0]?.tools.map((t) => t.name).join(",")}`);

  console.log("\n— another provider —");
  process.env.HUB_MODEL_PROVIDER = "bedrock";
  const missing = unavailableServers(["web", "memory"], new Set());
  check("on Bedrock the web is reported unavailable with the reason, so the model and the answer say so", missing.length === 1 && missing[0].name === "web" && /bedrock/.test(missing[0].reason), JSON.stringify(missing));
  delete process.env.HUB_MODEL_PROVIDER;

  console.log("\n— the design save —");
  const saved = await saveAgentAs(PERSON, null, draft(`verify-web-saved-${stamp}`, [{ name: "web", only: ["https://Acme.Example/pricing", "g2.com", ""], searches: "7" }]));
  const savedRow = "id" in saved ? await db.getAgent(saved.id) : null;
  if (savedRow) made.push(savedRow.id);
  check("a web entry is saved with its sites as hostnames and its count as a number", savedRow?.mcpServers[0]?.name === "web" && JSON.stringify(savedRow.mcpServers[0].only) === '["acme.example","g2.com"]' && savedRow.mcpServers[0].searches === 7, JSON.stringify(savedRow?.mcpServers ?? saved));
  const junk = await saveAgentAs(PERSON, null, draft(`verify-web-junk-${stamp}`, [{ name: "web", only: ["not a site"] }]));
  check("a site that is not a site is refused in words", /is not a site name/.test(junk.error ?? ""), junk.error);
  const both = await saveAgentAs(PERSON, null, draft(`verify-web-both-${stamp}`, [{ name: "web", only: ["a.com"], never: ["b.com"] }]));
  check("only and never together are refused", /not both/.test(both.error ?? ""), both.error);
  const many = await saveAgentAs(PERSON, null, draft(`verify-web-many-${stamp}`, [{ name: "web", searches: 500 }]));
  check("a count outside 1–50 is refused", /from 1 to 50/.test(many.error ?? ""), many.error);
} finally {
  await sql`delete from proposals where principal_id = ${PERSON.id}`;
  await sql`delete from agent_sessions where principal_id = ${PERSON.id}`;
  for (const id of made) await db.deleteAgent(id).catch(() => {});
  await sql`delete from agents where slug like ${`verify-web-%-${stamp}`}`;
  await sql`delete from principals where id = ${PERSON.id}`;
  await sql.end({ timeout: 5 });
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: whether a real search finds the real page — the Claude API's, read on the run page.");
