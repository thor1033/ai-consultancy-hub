// Verification of the shared folders: SharePoint folders kept indexed, each
// into a collection with its visibility (src/sharepoint.ts), the incremental
// sync that follows them (syncListing in src/sources.ts), and the clock that
// runs it (apps/web/src/lib/sourceSync.ts, packages/db/src/sourceSyncs.ts).
//
//   node --experimental-transform-types --env-file=apps/web/.env.local packages/rag/verify-sharepoint.mjs
//
// Needs DATABASE_URL and a migrated database. No Microsoft tenant and no
// embedding spend: a throwaway HTTP server stands in for login.microsoftonline
// .com and graph.microsoft.com, the real `teams` server is pointed at it, and
// VOYAGE_API_KEY is unset so the dev hash embedder is used. Every source,
// document, collection and sync record it makes carries this run's stamp and
// is deleted at the end; nothing it does touches a real source.
//
// What it cannot prove: Microsoft's live listing shapes (verify:teams copies
// them; teams_status checks the live grant), and the first sync of the real
// library — that shows on /knowledge, and in the release's logs.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
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

// ── the throwaway tenant ─────────────────────────────────────────────────────
const TENANT = "test-tenant";
const SECRET = "test-secret";
const TOKEN = "fixture-token";
const HOST = "teqneo.example.com";
const enc = (s) => new TextEncoder().encode(s);

const FILES = {};
let nextId = 0;
function put(path, body, at = "2026-10-20T10:00:00Z") {
  const parts = path.split("/");
  const name = parts.pop();
  const parent = parts.join("/");
  // Folders are implied by their files, as they would be listed.
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!Object.values(FILES).some((f) => f.folder && full(f) === p)) {
      const id = `fold-${++nextId}`;
      FILES[id] = { id, name: parts[i - 1], folder: { childCount: 0 }, parent: parts.slice(0, i - 1).join("/"), lastModifiedDateTime: at };
    }
  }
  const existing = Object.values(FILES).find((f) => !f.folder && full(f) === path);
  const id = existing?.id ?? `file-${++nextId}`;
  FILES[id] = { id, name, parent, file: {}, body: enc(body), size: body.length, lastModifiedDateTime: at };
  return id;
}
const full = (f) => (f.parent ? `${f.parent}/${f.name}` : f.name);
const remove = (path) => {
  const f = Object.values(FILES).find((x) => !x.folder && full(x) === path);
  if (f) delete FILES[f.id];
};
const asItem = (f) => ({
  id: f.id,
  name: f.name,
  ...(f.folder ? { folder: f.folder } : { file: {}, size: f.size }),
  webUrl: `https://${HOST}/sites/Teqneo/Shared%20Documents/${encodeURI(full(f))}`,
  lastModifiedDateTime: f.lastModifiedDateTime,
  lastModifiedBy: { user: { displayName: "Ditlev Brygmann" } },
  parentReference: { path: `/drives/drive-1/root:${f.parent ? `/${f.parent}` : ""}` },
});

put("Company/Policies/Travel policy.md", "# Travel policy\n\nTrain under four hours.");
put("Company/Logo.png", "\x89PNG");
put("Sales/Pitch.md", "# Pitch\n\nWe build the hub on licences you already own.");
put("Sales/Scan.pdf", "not really a pdf");
put("Clients/Acme/Scope.md", "# Acme scope\n\nThree agents, eight weeks.");
put("Clients/Møller & Co/Brief.txt", "Møller wants a secretary agent.");
put("Clients/Moeller Co/Other.txt", "A second folder that slugs the same.");
put("Clients/stray.md", "A file filed next to the clients, not in one.");
put("Meetings/Agenda.md", "# Agenda\n\nStanding items.");
put("Meetings/Notes/2026-10-24 Weekly Brief.md", "# Weekly brief\n\nIndexed by teams-notes, not here.");
put("Product/Roadmap.md", "# Roadmap\n\nDecks next.");
put("Product/Hub/Architecture.md", "# Hub architecture\n\nThe inner entry owns this.");

const contentReads = [];
let failListing = null;

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = decodeURIComponent(url.pathname);
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const err = (status, code, message) => json(status, { error: { code, message } });
  if (req.method === "POST" && path === `/${TENANT}/oauth2/v2.0/token`) {
    let raw = "";
    for await (const c of req) raw += c;
    return new URLSearchParams(raw).get("client_secret") === SECRET ? json(200, { access_token: TOKEN, expires_in: 3600 }) : json(401, {});
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return err(401, "InvalidAuthenticationToken", "No token.");
  if (path === `/sites/${HOST}:/sites/Teqneo`) return json(200, { id: `${HOST},g1,g2`, displayName: "Teqneo", webUrl: `https://${HOST}/sites/Teqneo` });
  if (path === `/sites/${HOST},g1,g2/drive`) return json(200, { id: "drive-1", name: "Dokumenter" });
  const kids = path.match(/^\/drives\/drive-1\/root(?::\/(.+):)?\/children$/);
  if (kids) {
    const parent = kids[1] ?? "";
    if (failListing && parent === failListing) return err(503, "serviceNotAvailable", "SharePoint is having a moment.");
    if (parent && !Object.values(FILES).some((f) => f.folder && full(f) === parent)) return err(404, "itemNotFound", "The resource could not be found.");
    return json(200, { value: Object.values(FILES).filter((f) => f.parent === parent).map(asItem) });
  }
  const it = path.match(/^\/drives\/drive-1\/items\/([^/]+)(\/content)?$/);
  if (it) {
    const f = FILES[it[1]];
    if (!f) return err(404, "itemNotFound", "The resource could not be found.");
    if (!it[2]) return json(200, asItem(f));
    contentReads.push(full(f));
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(Buffer.from(f.body));
  }
  return err(404, "ResourceNotFound", `No route for ${path}.`);
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${http.address().port}`;

const stamp = String(Date.now()).slice(-6);
const K = (k) => `v${stamp}${k}`; // source keys
const C = (c) => `v${stamp}-${c}`; // collection names
Object.assign(process.env, {
  M365_TENANT_ID: TENANT,
  M365_CLIENT_ID: "test-client",
  M365_CLIENT_SECRET: SECRET,
  M365_TEAMS_SITE_URL: `https://${HOST}/sites/Teqneo`,
  M365_LOGIN_BASE_URL: origin,
  M365_GRAPH_BASE_URL: origin,
  M365_TEAMS_NOTES_FOLDER: "Meetings/Notes",
  M365_TIMEZONE: "Europe/Copenhagen",
});
delete process.env.M365_TEAMS_ORGANIZER_ID;
delete process.env.VOYAGE_API_KEY;
delete process.env.HUB_SHAREPOINT_SYNC_MINUTES;

const CONFIG = {
  [K("company")]: { folder: "Company", collection: C("company") },
  [K("sales")]: { folder: "/Sales/", collection: C("sales"), visibility: "open" },
  [K("clients")]: { folder: "Clients", perFolder: `v${stamp}-c-`, visibility: "open" },
  [K("meetings")]: { folder: "Meetings", collection: C("meetings"), visibility: "open" },
  [K("product")]: { folder: "Product", collection: C("product"), visibility: "open" },
  [K("hub")]: { folder: "Product/Hub", collection: C("hub"), visibility: "open" },
  [K("training")]: { folder: "Training material", collection: C("training"), visibility: "open" },
};

const { loadSharepointFolders, folderSlug, getSource, listSources, syncSource } = await import("./src/index.ts");
const { getSql, listSourceSyncs, claimSourceSync, finishSourceSync } = await import("../db/src/index.ts");
const { knowledgeAccessFor } = await import("../authz/src/index.ts");
const { listDocuments } = await import("./src/index.ts");
const sql = getSql();

const docsIn = async (collection) =>
  sql`select title, source, metadata, (select string_agg(content, ' ') from document_chunks c where c.document_id = d.id) as text
        from documents d where collection = ${collection} order by title`;
const visibilityOf = async (name) => (await sql`select visibility from collections where name = ${name}`)[0]?.visibility ?? null;

try {
  console.log("— configuration —");
  process.env.HUB_SHAREPOINT_FOLDERS = "{not json";
  check("malformed HUB_SHAREPOINT_FOLDERS syncs no folders at all", Object.keys(loadSharepointFolders()).length === 0);
  process.env.HUB_SHAREPOINT_FOLDERS = JSON.stringify({
    ok: { folder: "Sales", collection: "sales" },
    dots: { folder: "../Elsewhere", collection: "x" },
    both: { folder: "Sales", collection: "sales", perFolder: "c-" },
    caps: { folder: "Sales", collection: "Sales Team" },
    "bad key": { folder: "Sales", collection: "sales" },
  });
  const parsed = loadSharepointFolders();
  check("an entry that is wrong is dropped whole, the right one kept", Object.keys(parsed).join() === "ok", Object.keys(parsed).join());
  check("an entry that does not say open is restricted", parsed.ok?.visibility === "restricted");

  process.env.HUB_SHAREPOINT_FOLDERS = JSON.stringify(CONFIG);
  const cfg = loadSharepointFolders();
  check("a per-client entry is restricted even when it says open", cfg[K("clients")].visibility === "restricted");
  check("folder paths are cleaned", cfg[K("sales")].folder === "Sales");
  check("Danish folder names become readable collection names", folderSlug("Møller & Co. ApS") === "moeller-co-aps" && folderSlug("Ærø Å") === "aeroe-aa");
  const ours = listSources().filter((s) => s.type.startsWith(`sharepoint:v${stamp}`));
  check("each entry is a source of its own, on the clock by default every 60 minutes", ours.length === 7 && ours.every((s) => s.configured && s.autoSyncMinutes === 60));
  process.env.HUB_SHAREPOINT_SYNC_MINUTES = "0";
  check("HUB_SHAREPOINT_SYNC_MINUTES=0 leaves them to Sync now", listSources().filter((s) => s.type.startsWith(`sharepoint:v${stamp}`)).every((s) => !s.autoSyncMinutes));
  process.env.HUB_SHAREPOINT_SYNC_MINUTES = "soon";
  check("and an unreadable value falls back to the default, not to never", getSource(`sharepoint:${K("sales")}`).autoSyncMinutes === 60);
  delete process.env.HUB_SHAREPOINT_SYNC_MINUTES;

  console.log("\n— the first sync —");
  const company = await syncSource(`sharepoint:${K("company")}`);
  check("a restricted folder's collection is created restricted", (await visibilityOf(C("company"))) === "restricted" && company.createdCollections?.[0]?.visibility === "restricted");
  check("its files are indexed, subfolders included, with the path in the text", (await docsIn(C("company"))).some((d) => d.title === "Travel policy.md — Company/Policies" && /Company\/Policies\/Travel policy\.md/.test(d.text)));
  check("a file the hub cannot read is reported, not silently dropped", company.skipped?.some((s) => s.path === "Company/Logo.png" && /\.png/.test(s.reason)), JSON.stringify(company.skipped));

  const sales = await syncSource(`sharepoint:${K("sales")}`);
  check("an open folder's collection is created open", (await visibilityOf(C("sales"))) === "open");
  check("a file that will not read is skipped with Graph's reason", sales.skipped?.some((s) => s.path === "Sales/Scan.pdf"), JSON.stringify(sales.skipped));

  const clients = await syncSource(`sharepoint:${K("clients")}`);
  const acme = `v${stamp}-c-acme`;
  const moeller = `v${stamp}-c-moeller-co`;
  check("each client folder becomes its own restricted collection", (await visibilityOf(acme)) === "restricted" && (await visibilityOf(moeller)) === "restricted");
  check("with that client's files in it", (await docsIn(acme)).length === 1 && (await docsIn(moeller)).length === 1);
  check("a file next to the client folders is refused, not filed in a shared drawer", clients.skipped?.some((s) => s.path === "Clients/stray.md" && /belong in one of the folders/.test(s.reason)));
  // The teams server lists by name, so which of the two comes first is stable.
  const clash = clients.skipped?.filter((s) => /already/.test(s.reason)) ?? [];
  check(
    "two folders that would share a collection: one is refused, naming the other",
    clash.length === 1 && ["Clients/Moeller Co", "Clients/Møller & Co"].includes(clash[0].path) && clash[0].reason.includes(moeller),
    JSON.stringify(clash),
  );

  const meetings = await syncSource(`sharepoint:${K("meetings")}`);
  const meetingDocs = await docsIn(C("meetings"));
  check("the meeting-notes folder is left to its own source", meetingDocs.length === 1 && meetingDocs[0].title.startsWith("Agenda.md"), meetingDocs.map((d) => d.title).join(", "));
  await syncSource(`sharepoint:${K("product")}`);
  await syncSource(`sharepoint:${K("hub")}`);
  check("a folder another entry syncs is indexed once, by that entry", (await docsIn(C("product"))).length === 1 && (await docsIn(C("hub"))).length === 1);
  const training = await syncSource(`sharepoint:${K("training")}`);
  check("a folder that does not exist yet is a reported state, not a failure", training.documents === 0 && training.skipped?.[0]?.reason === "the folder does not exist yet");

  console.log("\n— who can read it —");
  const analyst = await knowledgeAccessFor({ id: `verify-sp-analyst-${stamp}`, roles: ["analyst"] });
  const visible = new Set((await listDocuments(analyst)).map((d) => d.collection));
  check("someone without a grant sees the open folders", visible.has(C("sales")) && visible.has(C("product")));
  check("and not the company's or any client's", !visible.has(C("company")) && !visible.has(acme) && !visible.has(moeller));

  console.log("\n— the next syncs follow the folder —");
  contentReads.length = 0;
  const again = await syncSource(`sharepoint:${K("clients")}`);
  check("nothing changed: nothing is downloaded or embedded again", again.documents === 0 && again.unchanged === 2 && contentReads.length === 0, `${contentReads.length} reads`);

  put("Clients/Acme/Scope.md", "# Acme scope\n\nFour agents now, ten weeks.", "2026-10-30T09:15:42Z");
  put("Clients/Acme/Contract.md", "# Contract\n\nSigned.", "2026-10-30T09:20:00Z");
  contentReads.length = 0;
  const edited = await syncSource(`sharepoint:${K("clients")}`);
  const acmeDocs = await docsIn(acme);
  check("an edited file is read again and replaced, not duplicated", acmeDocs.length === 2 && acmeDocs.some((d) => /Four agents now/.test(d.text)) && !acmeDocs.some((d) => /Three agents/.test(d.text)));
  check("only the changed and the new file were downloaded", edited.documents === 2 && contentReads.sort().join() === "Clients/Acme/Contract.md,Clients/Acme/Scope.md", contentReads.join());

  remove("Clients/Acme/Contract.md");
  const deleted = await syncSource(`sharepoint:${K("clients")}`);
  check("a file deleted in SharePoint is deleted from the index", deleted.removed === 1 && (await docsIn(acme)).length === 1);

  failListing = "Company/Policies";
  const before = (await docsIn(C("company"))).length;
  const failed = await syncSource(`sharepoint:${K("company")}`).then(() => "synced", (e) => e.message);
  check("a listing that fails part-way fails the sync, with the reason", /Could not list Company\/Policies/.test(failed), failed);
  check("and deletes nothing, because it could not see everything", (await docsIn(C("company"))).length === before && before > 0);
  failListing = null;

  await sql`update collections set visibility = 'open' where name = ${acme}`;
  const opened = await syncSource(`sharepoint:${K("clients")}`);
  check("a client drawer a person opened on /admin stays open — and the sync says so", (await visibilityOf(acme)) === "open" && opened.warnings?.some((w) => w.includes(acme)), opened.warnings?.join(" "));

  const override = await syncSource(`sharepoint:${K("clients")}`, { collection: "anywhere" }).then(() => "synced", (e) => e.message);
  check("naming a collection by hand is refused, so a restricted folder cannot be filed somewhere open", /leave the collection empty/.test(override), override);

  console.log("\n— the clock —");
  const t = `sharepoint:${K("sales")}`;
  check("the first claim of a source wins", (await claimSourceSync(t, 60)) === true);
  check("a second claim inside the interval loses — one machine syncs", (await claimSourceSync(t, 60)) === false);
  await finishSourceSync(t, { ok: false, error: "SharePoint is having a moment." });
  check("a failed sync is recorded with its reason", (await listSourceSyncs()).some((r) => r.sourceType === t && r.ok === false && /moment/.test(r.error ?? "")));
  await sql`update source_syncs set started_at = now() - interval '2 hours' where source_type = ${t}`;
  check("a sync that died is claimed again once its interval has passed", (await claimSourceSync(t, 60)) === true);

  // The ticker's own entry point, over the real listSources(): each of this
  // run's sources not synced in the last hour is synced and recorded.
  const { syncDueSources } = await import("../../apps/web/src/lib/sourceSync.ts");
  await sql`delete from source_syncs where source_type like ${`sharepoint:v${stamp}%`}`;
  put("Sales/Pricing.md", "# Pricing\n\nDay rate.", "2026-10-31T08:00:00Z");
  await syncDueSources();
  const rows = (await listSourceSyncs()).filter((r) => r.sourceType.startsWith(`sharepoint:v${stamp}`));
  check("the ticker syncs every due folder and records each outcome", rows.length === 7 && rows.every((r) => r.ok === true && r.finishedAt), rows.map((r) => `${r.sourceType.split(stamp)[1]}:${r.ok}`).join(" "));
  check("in words a person can read on /knowledge", rows.find((r) => r.sourceType === t)?.summary.startsWith("1 indexed, 1 unchanged"), rows.find((r) => r.sourceType === t)?.summary);
  contentReads.length = 0;
  await syncDueSources();
  check("and the next tick inside the hour does nothing", contentReads.length === 0 && (await listSourceSyncs()).filter((r) => r.sourceType.startsWith(`sharepoint:v${stamp}`)).every((r) => r.ok === true));
} catch (err) {
  console.error("\nverify-sharepoint crashed:", err);
  checks.push({ label: "script completed", ok: false });
} finally {
  await sql`delete from documents where source_type like ${`sharepoint:v${stamp}%`}`.catch(() => {});
  await sql`delete from collections where name like ${`v${stamp}-%`}`.catch(() => {});
  await sql`delete from source_syncs where source_type like ${`sharepoint:v${stamp}%`}`.catch(() => {});
  await sql.end({ timeout: 2 }).catch(() => {});
  http.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failedChecks.length}/${checks.length} checks passed.`);
process.exit(failedChecks.length ? 1 : 0);
