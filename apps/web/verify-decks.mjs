// Decks (docs/decks.md), driven through the shipping code against a real
// database:
//
//   node --experimental-transform-types --env-file=.env.local verify-decks.mjs
//
// Needs DATABASE_URL and a migrated database. No API key: the question box's
// model call is NOT made here. Its parsing and validation of a reply are
// checked on canned replies; that a real model answers in the expected shape
// is only proven by using it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
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
      if (!specifier.startsWith(".")) return nextResolve(`${specifier}.js`, context);
      if (!context.parentURL) throw err;
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
  console.error("DATABASE_URL is not set — run with --env-file=.env.local");
  process.exit(1);
}

const ops = await import("./src/lib/decks/ops.ts");
const { validateSlide, SLIDE_KINDS } = await import("./src/lib/decks/schema.ts");
const { parseDraftedSlide } = await import("./src/lib/decks/draft.ts");
const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
const db = await import("../../packages/db/src/index.ts");
const sql = db.getSql();

const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
async function connect(principal) {
  const server = await buildHubMcpServer(principal, { baseUrl: "https://hub.example" });
  const client = new Client({ name: "verify", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  return { isError: Boolean(r.isError), text: t, body: parse(t) };
};

const stamp = Date.now();
const OWNER = { id: `verify-deck-owner-${stamp}`, roles: ["analyst"], source: "credential" };
const OTHER = { id: `verify-deck-other-${stamp}`, roles: ["analyst"], source: "credential" };
const ADMIN = { id: `verify-deck-admin-${stamp}`, roles: ["admin"], source: "credential" };
const VIEWER = { id: `verify-deck-viewer-${stamp}`, roles: ["viewer"], source: "credential" };
const SECRET = `verify-deck-secret-${stamp}`;
const decks = [];

try {
  for (const p of [OWNER, OTHER, ADMIN, VIEWER]) await db.upsertPrincipal({ id: p.id, roles: p.roles, displayName: p.id });
  await db.upsertCollection({ name: SECRET, visibility: "restricted" });
  await db.grantCollection(SECRET, OWNER.id, "verify");

  // --- 1. what a slide may contain -----------------------------------------
  console.log("— the slide schema —");
  check("seventeen kinds, the consultancy exhibits among them", SLIDE_KINDS.length === 17 && ["summary", "agenda", "waterfall", "matrix", "process", "timeline", "harvey", "trend", "quotes"].every((k) => SLIDE_KINDS.includes(k)), SLIDE_KINDS.join(", "));
  check(
    "every kind takes the frame: tracker, sticker, takeaway, footnote, printed sources",
    "slide" in validateSlide({ kind: "bullets", title: "T", bullets: ["a"], kicker: "Diagnostic", sticker: "Preliminary", takeaway: "So what", footnote: "n=12", sources: ["Pilot data"] }),
  );
  const wf = validateSlide({ kind: "waterfall", title: "T", start: { label: "Base", value: 4.6 }, steps: [{ label: "Cost", value: -1.2 }], end: "Net" });
  check("a waterfall takes negative steps and a computed end", "slide" in wf);
  const threeQuads = validateSlide({ kind: "matrix", title: "T", x: { label: "X" }, y: { label: "Y" }, quadrants: [{ title: "a" }, { title: "b" }, { title: "c" }] });
  check("a 2×2 needs exactly four quadrants", "error" in threeQuads && /quadrants/.test(threeQuads.error), threeQuads.error);
  const badGantt = validateSlide({ kind: "timeline", title: "T", periods: ["Q1", "Q2"], rows: [{ label: "x", from: 1, to: 3 }] });
  check("a timeline row must sit within its periods", "error" in badGantt && /within the periods/.test(badGantt.error), badGantt.error);
  const badHarvey = validateSlide({ kind: "harvey", title: "T", options: ["A", "B"], criteria: ["c1", "c2"], scores: [[4, 2]] });
  check("Harvey balls need one score per option per criterion", "error" in badHarvey && /scores/.test(badHarvey.error), badHarvey.error);
  check("and a score is 0 to 4", "error" in validateSlide({ kind: "harvey", title: "T", options: ["A", "B"], criteria: ["c"], scores: [[5, 1]] }));
  check("a good bullets slide passes", "slide" in validateSlide({ kind: "bullets", title: "T", bullets: ["a", "b"] }));
  const unknown = validateSlide({ kind: "video", title: "x" });
  check("an unknown kind is refused, naming the kinds", "error" in unknown && /must be one of/.test(unknown.error), unknown.error);
  const tooMany = validateSlide({ kind: "bullets", title: "T", bullets: Array(9).fill("x") });
  check("too many bullets is refused with the field named", "error" in tooMany && /bullets/.test(tooMany.error), tooMany.error);
  const ragged = validateSlide({ kind: "table", title: "T", columns: ["a", "b"], rows: [["1", "2"], ["3"]] });
  check("a table row with the wrong number of cells is refused", "error" in ragged && /one cell per column/.test(ragged.error), ragged.error);
  const extra = validateSlide({ kind: "quote", quote: "Q", html: "<script>x</script>" });
  check("fields a kind does not have are dropped, not stored", "slide" in extra && !("html" in extra.slide));

  // --- 2. creating and editing, outside a presentation -----------------------
  console.log("\n— a deck between presentations —");
  const made = await ops.createDeck(OWNER, { title: "Verify deck", slides: [{ kind: "title", title: "Hello" }, { kind: "bullets", title: "Two", bullets: ["x"] }] }, "person");
  check("createDeck stores the deck and its slides, all live", made.ok && made.value.slides.length === 2 && made.value.slides.every((s) => s.status === "live"));
  const deck = made.value;
  decks.push(deck.id);
  const bad = await ops.createDeck(OWNER, { title: "Bad", slides: [{ kind: "bullets", title: "x", bullets: [] }] }, "person");
  check("a deck with an invalid slide is refused, naming the slide", "error" in bad && /^Slide 1:/.test(bad.error), bad.error);
  const empty = await ops.createDeck(OWNER, { title: "Just a title" }, "person");
  check("a deck made with no slides gets a title slide", empty.ok && empty.value.slides[0]?.kind === "title" && empty.value.slides[0]?.title === "Just a title");
  if (empty.ok) decks.push(empty.value.id);

  const add = await ops.addSlide(OWNER, deck.id, { kind: "quote", quote: "Agent quote" }, { by: "agent" });
  check("outside a presentation an agent's slide goes straight into the deck", add.ok && add.value.placed === "deck" && add.value.slide.status === "live" && add.value.slide.by === "agent");
  const firstId = deck.slides[0].id;
  const placed = await ops.addSlide(OWNER, deck.id, { kind: "section", title: "Part 2" }, { by: "person", after: firstId });
  let d = await db.getDeck(deck.id);
  check("a slide lands after the one named", d.slides[1].id === placed.value.slide.id, d.slides.map((s) => s.kind).join(","));
  const mv = await ops.moveSlide(OWNER, deck.id, placed.value.slide.id, null, "agent");
  d = await db.getDeck(deck.id);
  check("moving to the start works", mv.ok && d.slides[0].id === placed.value.slide.id);

  // --- 3. while presenting -------------------------------------------------
  console.log("\n— while presenting —");
  await ops.setPresenting(OWNER, deck.id, true);
  d = await db.getDeck(deck.id);
  check("presenting puts a live slide on screen", d.presenting && d.slides.some((s) => s.id === d.position && s.status === "live"));
  const onScreen = d.slides[2].id;
  await ops.setPosition(OWNER, deck.id, onScreen);
  const v0 = (await db.getDeck(deck.id)).version;
  await ops.setPosition(OWNER, deck.id, onScreen);
  check("moving to the slide already on screen writes nothing", (await db.getDeck(deck.id)).version === v0);
  const agentAdd = await ops.addSlide(OWNER, deck.id, { kind: "bullets", title: "Answer", bullets: ["From the room"] }, { by: "agent" });
  check("an agent's new slide goes to the tray", agentAdd.ok && agentAdd.value.placed === "tray" && agentAdd.value.slide.status === "pending");
  check("anchored to the slide on screen", agentAdd.value.slide.after === onScreen);
  const personAdd = await ops.addSlide(OWNER, deck.id, { kind: "bullets", title: "Mine", bullets: ["x"] }, { by: "person", after: onScreen });
  check("a person's slide still goes straight in", personAdd.ok && personAdd.value.placed === "deck");
  const liveId = d.slides.find((s) => s.status === "live").id;
  const agentEdit = await ops.updateSlide(OWNER, deck.id, liveId, { kind: "title", title: "Changed" }, "agent");
  check("an agent may not change a live slide mid-presentation", "error" in agentEdit && /being presented/.test(agentEdit.error), agentEdit.error);
  check("nor move one", "error" in (await ops.moveSlide(OWNER, deck.id, liveId, null, "agent")));
  check("nor remove one", "error" in (await ops.removeSlide(OWNER, deck.id, liveId, "agent")));
  const revise = await ops.updateSlide(OWNER, deck.id, agentAdd.value.slide.id, { kind: "bullets", title: "Answer v2", bullets: ["Revised"] }, "agent");
  check("but it may revise its own slide in the tray", revise.ok && revise.value.status === "pending" && revise.value.title === "Answer v2");
  const shown = await ops.acceptSlide(OWNER, deck.id, agentAdd.value.slide.id, true);
  d = await db.getDeck(deck.id);
  const shownAt = d.slides.findIndex((s) => s.id === agentAdd.value.slide.id);
  check(
    "Show now puts it right after the slide on screen and on screen",
    shown.ok && d.position === agentAdd.value.slide.id && d.slides[shownAt - 1]?.id === onScreen && d.slides[shownAt].status === "live" && !("after" in d.slides[shownAt]),
    d.slides.map((s) => `${s.kind}:${s.status}`).join(","),
  );
  const toDiscard = await ops.addSlide(OWNER, deck.id, { kind: "quote", quote: "Nope" }, { by: "agent" });
  await ops.discardSlide(OWNER, deck.id, toDiscard.value.slide.id);
  check("a discarded slide is gone", !(await db.getDeck(deck.id)).slides.some((s) => s.id === toDiscard.value.slide.id));
  check("an agent may remove its slide from the tray", (await ops.removeSlide(OWNER, deck.id, (await ops.addSlide(OWNER, deck.id, { kind: "quote", quote: "x" }, { by: "agent" })).value.slide.id, "agent")).ok);

  // --- 4. two writers at once ----------------------------------------------
  console.log("\n— two writers at once —");
  const before = (await db.getDeck(deck.id)).slides.length;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ops.addSlide(OWNER, deck.id, { kind: "quote", quote: `Concurrent ${i}` }, { by: "person" })));
  d = await db.getDeck(deck.id);
  check("six simultaneous adds all land, none overwritten", results.every((r) => r.ok) && d.slides.length === before + 6, `${before} → ${d.slides.length}`);
  const st = await ops.deckState(OWNER, deck.id, d.version);
  check("deckState says nothing new at the current version", st && st.version === d.version && !st.deck);
  const st2 = await ops.deckState(OWNER, deck.id, d.version - 1);
  check("and sends the deck when it moved", Boolean(st2?.deck?.id === deck.id));

  // --- 5. who may see a deck ------------------------------------------------
  console.log("\n— who may see a deck —");
  const secret = await ops.createDeck(OWNER, { title: "Client deck", collection: SECRET }, "person");
  check("the owner, granted the collection, can make a deck about it", secret.ok);
  decks.push(secret.value.id);
  check("someone without the grant cannot see it", (await ops.visibleDeck(OTHER, secret.value.id)) === null);
  check("nor poll it", (await ops.deckState(OTHER, secret.value.id, null)) === null);
  check("nor find it in the list", !(await ops.visibleDecks(OTHER)).some((x) => x.id === secret.value.id));
  check("an admin can", (await ops.visibleDeck(ADMIN, secret.value.id))?.id === secret.value.id);
  const notGranted = await ops.createDeck(OTHER, { title: "x", collection: SECRET }, "person");
  check("nobody can make a deck about a collection they may not read", "error" in notGranted, notGranted.error);
  check("a viewer, who may not run agents, sees no decks at all", (await ops.visibleDecks(VIEWER)).length === 0);
  check("someone else cannot delete the owner's deck", "error" in (await ops.removeDeck(OTHER, deck.id)));

  // --- 6. the MCP tools -----------------------------------------------------
  console.log("\n— from Claude Code —");
  const mcp = await connect(OWNER);
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  check("the deck tools are offered", ["hub_deck_list", "hub_deck_create", "hub_deck_get", "hub_deck_add_slide", "hub_deck_update_slide", "hub_deck_move_slide", "hub_deck_remove_slide"].every((n) => names.includes(n)));
  const createTool = (await mcp.listTools()).tools.find((t) => t.name === "hub_deck_create");
  check("their descriptions carry the slide kinds", /bars: \{/.test(createTool.description) && /\n\n/.test(createTool.description));
  const created = await call(mcp, "hub_deck_create", { title: "From Claude Code", slides: [{ kind: "title", title: "Hi" }, { kind: "stats", title: "Numbers", stats: [{ value: "38%", label: "less" }] }] });
  check("hub_deck_create makes a deck and returns its id and URL", !created.isError && created.body.slides?.length === 2 && created.body.url === `https://hub.example/decks/${created.body.deck}`, created.text.slice(0, 80));
  decks.push(created.body.deck);
  const badTool = await call(mcp, "hub_deck_create", { title: "x", slides: [{ kind: "bars", title: "B", items: [{ label: "a", value: -3 }] }] });
  check("an invalid slide comes back as an error naming the field", badTool.isError && /items/.test(badTool.text), badTool.text);
  await ops.setPresenting(OWNER, created.body.deck, true);
  const viaTool = await call(mcp, "hub_deck_add_slide", { deck: created.body.deck, slide: { kind: "bullets", title: "Q", bullets: ["A"] } });
  check("hub_deck_add_slide during a presentation goes to the tray and says so", !viaTool.isError && viaTool.body.placed === "tray" && /tray/.test(viaTool.body.note));
  const editLive = await call(mcp, "hub_deck_update_slide", { deck: created.body.deck, slideId: created.body.slides[0].id, slide: { kind: "title", title: "No" } });
  check("hub_deck_update_slide on a live slide mid-presentation is refused", editLive.isError, editLive.text.slice(0, 70));
  const listed = await call(mcp, "hub_deck_list", {});
  check("hub_deck_list shows the deck with one in the tray", Array.isArray(listed.body) && listed.body.some((x) => x.deck === created.body.deck && x.inTray === 1 && x.presenting));
  const other = await connect(OTHER);
  const hidden = await call(other, "hub_deck_get", { deck: secret.value.id });
  check("hub_deck_get refuses a deck about a collection you may not read", hidden.isError && /No deck/.test(hidden.text));
  const viewerTools = (await (await connect(VIEWER)).listTools()).tools.map((t) => t.name);
  check("a viewer is offered no deck tools", !viewerTools.some((n) => n.startsWith("hub_deck_")));

  // --- 7. the question box's reply handling -----------------------------------
  console.log("\n— a drafted slide —");
  const fenced = parseDraftedSlide('Here you go:\n```json\n{"kind":"bullets","title":"Cost for Oslo","bullets":["About 4 weeks"]}\n```');
  check("a fenced JSON reply becomes a slide", "slide" in fenced && fenced.slide.title === "Cost for Oslo");
  const raw = parseDraftedSlide('{"kind":"quote","quote":"Yes"}');
  check("so does a bare JSON object", "slide" in raw);
  check("prose with no JSON is refused", "error" in parseDraftedSlide("I cannot answer that."));
  check("a reply that breaks the schema is refused with the field", "error" in parseDraftedSlide('```json\n{"kind":"stats","title":"x","stats":[]}\n```'));
} catch (err) {
  console.error("\nverify-decks crashed:", err);
  checks.push({ label: "script completed", ok: false });
} finally {
  for (const id of decks) await db.deleteDeck(id).catch(() => {});
  await sql`delete from collection_grants where collection = ${SECRET}`.catch(() => {});
  await sql`delete from collections where name = ${SECRET}`.catch(() => {});
  for (const p of [OWNER, OTHER, ADMIN, VIEWER]) await sql`delete from principals where id = ${p.id}`.catch(() => {});
  await sql.end({ timeout: 2 }).catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
