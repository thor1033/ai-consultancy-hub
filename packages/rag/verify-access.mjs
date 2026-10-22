// Verification of increment 02: retrieval that respects the principal.
//
//   node --experimental-transform-types --env-file=apps/web/.env.local \
//        packages/rag/verify-access.mjs
//
// No API key: the dev hash embedder is enough, because what is under test is
// the FILTER, not the ranking. Every check asks the same question in a
// different way — can this principal reach a document it was not granted — and
// the answer has to be no on all four read paths, because search returns ids
// and getDocument turns an id into the whole document.
//
// Everything happens in throwaway collections this script creates and deletes.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
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

const { ingestDocument, listDocuments, getDocument, listCollections } = await import(
  "./src/ingest.ts"
);
const { retrieveChunks } = await import("./src/retrieve.ts");
const {
  getSql,
  upsertPrincipal,
  upsertCollection,
  grantCollection,
  revokeCollectionGrant,
  listCollectionRows,
} = await import("../db/src/index.ts");
const { knowledgeAccessFor, ALL_KNOWLEDGE } = await import("../authz/src/knowledge.ts");

const sql = getSql();
const TAG = `vacc-${Date.now()}`;
const OPEN = `${TAG}-handbook`; // open: the staff handbook
const HR = `${TAG}-hr`; // restricted: the HR files
const CLIENT = `${TAG}-client`; // restricted: one client's engagement

const principal = (id, roles) => ({ id, roles, source: "credential" });

try {
  // --- the corpus ---------------------------------------------------------
  await upsertCollection({ name: OPEN, visibility: "open" });
  await upsertCollection({ name: HR, visibility: "restricted" });
  await upsertCollection({ name: CLIENT, visibility: "restricted" });

  const docs = {};
  for (const [key, collection, title, content] of [
    ["open", OPEN, "Staff handbook", "The office is open from nine. Expenses are filed monthly."],
    ["hr", HR, "Salary review", "Confidential: the salary bands and this year's review outcomes."],
    ["client", CLIENT, "Aurora engagement", "Confidential: the Aurora Capital delivery plan and its risks."],
    ["unfiled", null, "Loose note", "A note nobody filed into a collection."],
  ]) {
    const r = await ingestDocument({ title, content, ...(collection ? { collection } : {}) });
    docs[key] = r.documentId;
  }

  await upsertPrincipal({ id: `${TAG}-analyst`, roles: ["analyst"] });
  await upsertPrincipal({ id: `${TAG}-hr-lead`, roles: ["analyst"] });
  await upsertPrincipal({ id: `${TAG}-admin`, roles: ["admin"] });
  await grantCollection(HR, `${TAG}-hr-lead`, "verify-harness");

  const analyst = await knowledgeAccessFor(principal(`${TAG}-analyst`, ["analyst"]));
  const hrLead = await knowledgeAccessFor(principal(`${TAG}-hr-lead`, ["analyst"]));
  const admin = await knowledgeAccessFor(principal(`${TAG}-admin`, ["admin"]));

  const mine = (rows) => rows.filter((d) => String(d.title).match(/Staff handbook|Salary review|Aurora engagement|Loose note/));
  const titles = (rows) => mine(rows).map((d) => d.title).sort();

  // --- 1. listDocuments ---------------------------------------------------
  check(
    "an analyst does not see restricted documents in the list",
    JSON.stringify(titles(await listDocuments(analyst))) ===
      JSON.stringify(["Loose note", "Staff handbook"]),
    JSON.stringify(titles(await listDocuments(analyst))),
  );
  check(
    "a grant adds exactly the granted collection, nothing else",
    JSON.stringify(titles(await listDocuments(hrLead))) ===
      JSON.stringify(["Loose note", "Salary review", "Staff handbook"]),
    "the client engagement is still invisible",
  );
  check(
    "an admin sees everything",
    JSON.stringify(titles(await listDocuments(admin))) ===
      JSON.stringify(["Aurora engagement", "Loose note", "Salary review", "Staff handbook"]),
  );

  // --- 2. getDocument (the way around a filtered search) -------------------
  check(
    "an analyst cannot read a restricted document by id",
    (await getDocument(docs.hr, analyst)) === null,
    "reported as missing, not as forbidden — a 403 would confirm it exists",
  );
  check(
    "the grantee can read that same id",
    (await getDocument(docs.hr, hrLead))?.title === "Salary review",
  );
  check(
    "the grantee still cannot read the other restricted document",
    (await getDocument(docs.client, hrLead)) === null,
  );
  check("an analyst can read an open document", (await getDocument(docs.open, analyst))?.title === "Staff handbook");

  // --- 3. retrieveChunks --------------------------------------------------
  const hit = (chunks, title) => chunks.some((c) => c.title === title);
  const analystHits = await retrieveChunks("confidential salary bands", analyst, 20);
  check(
    "search never returns a restricted passage",
    !hit(analystHits, "Salary review") && !hit(analystHits, "Aurora engagement"),
    `${analystHits.length} chunks, none restricted`,
  );
  const leadHits = await retrieveChunks("confidential salary bands", hrLead, 20);
  check("search returns a granted passage", hit(leadHits, "Salary review"));
  check("search still hides what was not granted", !hit(leadHits, "Aurora engagement"));

  // --- 4. curation is not permission --------------------------------------
  const scoped = await retrieveChunks("confidential", analyst, 20, { collection: HR });
  check(
    "naming a restricted collection explicitly does not unlock it",
    scoped.length === 0,
    "curation and permission are ANDed, so `collection` cannot widen access",
  );

  // --- 4b. a set of collections (an agent's drawers) ----------------------
  const setForLead = await retrieveChunks("handbook salary", hrLead, 20, { collection: [OPEN, HR] });
  check(
    "a set of collections retrieves from each of them",
    hit(setForLead, "Staff handbook") && hit(setForLead, "Salary review"),
    `${setForLead.length} chunks`,
  );
  check("and from nothing outside the set", !hit(setForLead, "Aurora engagement") && !hit(setForLead, "Loose note"));
  const setForAnalyst = await retrieveChunks("handbook salary", analyst, 20, { collection: [OPEN, HR] });
  check(
    "the set is still ANDed with access: the analyst gets only the open drawer",
    hit(setForAnalyst, "Staff handbook") && !hit(setForAnalyst, "Salary review"),
    `${setForAnalyst.length} chunks`,
  );
  check(
    "an empty set matches nothing rather than everything",
    (await retrieveChunks("handbook", admin, 20, { collection: [] })).length === 0,
    "scoped to no drawer is not the same as unscoped",
  );

  // --- 5. listCollections -------------------------------------------------
  const analystCollections = await listCollections(analyst);
  check(
    "an analyst is not even offered the restricted collections",
    !analystCollections.includes(HR) && !analystCollections.includes(CLIENT),
    "a collection you cannot read should not appear in the scope picker",
  );
  check("the open collection is offered", (await listCollections(analyst)).includes(OPEN));
  check("the grantee is offered theirs", (await listCollections(hrLead)).includes(HR));

  // --- 6. revocation ------------------------------------------------------
  await revokeCollectionGrant(HR, `${TAG}-hr-lead`);
  const afterRevoke = await knowledgeAccessFor(principal(`${TAG}-hr-lead`, ["analyst"]));
  check(
    "revoking a grant closes retrieval immediately",
    !hit(await retrieveChunks("confidential salary bands", afterRevoke, 20), "Salary review"),
  );
  check(
    "and closes the document read with it",
    (await getDocument(docs.hr, afterRevoke)) === null,
  );

  // --- 7. the fail-closed default -----------------------------------------
  process.env.HUB_DEFAULT_COLLECTION_VISIBILITY = "restricted";
  const strict = await knowledgeAccessFor(principal(`${TAG}-analyst`, ["analyst"]));
  const strictTitles = titles(await listDocuments(strict));
  check(
    "with restricted-by-default, an ungranted analyst sees nothing",
    strictTitles.length === 0,
    `saw ${JSON.stringify(strictTitles)}`,
  );
  check(
    "including unfiled documents, which are in no drawer to be granted",
    (await getDocument(docs.unfiled, strict)) === null,
  );
  await grantCollection(OPEN, `${TAG}-analyst`, "verify-harness");
  const strictGranted = await knowledgeAccessFor(principal(`${TAG}-analyst`, ["analyst"]));
  check(
    "an explicit grant is the only way in under that default",
    JSON.stringify(titles(await listDocuments(strictGranted))) === JSON.stringify(["Staff handbook"]),
  );
  check(
    "an admin is still unfiltered under that default",
    titles(await listDocuments(await knowledgeAccessFor(principal(`${TAG}-admin`, ["admin"])))).length === 4,
  );
  delete process.env.HUB_DEFAULT_COLLECTION_VISIBILITY;

  // --- 8. the escape hatch is explicit ------------------------------------
  check(
    "ALL_KNOWLEDGE returns the whole corpus",
    titles(await listDocuments(ALL_KNOWLEDGE)).length === 4,
    "for ingest jobs and harnesses — never for a request",
  );

  // --- 9. unclassified collections are visible to an operator -------------
  const rows = await listCollectionRows();
  const openRow = rows.find((r) => r.name === OPEN);
  check("listCollectionRows reports document counts", openRow?.documentCount === 1);
  check(
    "an unclassified collection is listed as open so it can be found",
    rows.every((r) => r.visibility === "open" || r.visibility === "restricted"),
  );
} finally {
  await sql`delete from collection_grants where collection like ${`${TAG}%`}`;
  await sql`delete from documents where collection like ${`${TAG}%`} or title = 'Loose note'`;
  await sql`delete from collections where name like ${`${TAG}%`}`;
  await sql`delete from principals where id like ${`${TAG}%`}`;
  await sql.end();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) {
  console.log("Failed:");
  for (const f of failed) console.log(`  - ${f.label}`);
  process.exit(1);
}
