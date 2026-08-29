// Verification of the PM-tool KnowledgeSource — the connector that indexes
// Atlas's *documents* (business case, scope, glossary, notes) into RAG.
//
// Run against a configured hub:
//   node --env-file=apps/web/.env.local packages/rag/verify-pm-tool.mjs
//
// Needs HUB_REMOTE_MCP_SERVERS + the token env it names (it talks to the real
// PM-tool endpoint). The DB half is skipped when DATABASE_URL is absent, so the
// fetch/shape checks still run anywhere.
//
// The check that matters most is the split: no task, risk or milestone state may
// ever appear in a document. Those change hourly and a stale vector answers
// confidently with yesterday's status — that is what the MCP tools are for.

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The packages import each other the way a bundler expects — `from "./manager"`,
// no extension — which Next and Turbopack resolve but Node's ESM resolver does
// not, since it never extension-searches. This hook fills that gap for the
// harness only; nothing in the app changes shape to accommodate a test.
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

const { listSources, getSource } = await import("./src/sources.ts");

// ── registration ────────────────────────────────────────────────────────────
const listed = listSources();
const info = listed.find((s) => s.type === "pm-tool");
check("pm-tool is registered as a knowledge source", Boolean(info), info?.label);
check(
  "it reports itself configured (HUB_REMOTE_MCP_SERVERS + token)",
  info?.configured === true,
  info?.configured ? "" : "declare the server and its tokenEnv to run the rest",
);

if (!info?.configured) {
  console.log("\nSkipping the live checks — the source is not configured.");
  process.exit(1);
}

// ── fetch from the live endpoint ────────────────────────────────────────────
const source = getSource("pm-tool");
const docs = await source.fetch();
check("fetch() returns documents", docs.length > 0, `${docs.length} document(s)`);

console.log("\n  documents fetched:");
for (const d of docs) console.log(`    ${d.externalId}  ·  ${d.title}`);
console.log();

check(
  "every document has a stable pm-tool: external id",
  docs.every((d) => /^pm-tool:[^:]+:.+/.test(d.externalId)),
);
check(
  "external ids are unique (a re-sync replaces, never duplicates)",
  new Set(docs.map((d) => d.externalId)).size === docs.length,
);
check(
  "every document carries its project and a link back",
  docs.every((d) => d.metadata?.projectId && String(d.metadata?.url ?? "").includes("/projects/")),
  docs[0]?.metadata?.url,
);
check("no document is empty", docs.every((d) => d.content.trim().length > 0));
check(
  "each document names its project in the body (chunks lose the title)",
  docs.every((d) => d.content.startsWith(String(d.metadata.projectName))),
);

// ── the split: documents only, never live board state ───────────────────────
const sections = new Set(docs.map((d) => d.metadata.section));
check(
  "no board state is indexed (no tasks/risks/milestones sections)",
  !["tasks", "risks", "milestones", "activity"].some((s) => sections.has(s)),
  `sections: ${[...sections].join(", ")}`,
);
// Task ids are "t_xxxx" in PM-tool; a stray one means the board leaked in.
check(
  "no task ids leaked into any document body",
  !docs.some((d) => /\bt_[a-z0-9]{6,}\b/.test(d.content)),
);

// ── content fidelity ────────────────────────────────────────────────────────
const glossary = docs.find((d) => d.metadata.section === "glossary");
if (glossary) {
  check(
    "the glossary renders term/definition pairs as prose, not JSON",
    /Term: /.test(glossary.content) &&
      /Definition: /.test(glossary.content) &&
      !glossary.content.includes('{"'),
    `${glossary.content.length} chars`,
  );
  check(
    "internal ids are stripped from the glossary",
    !/\bgl_[a-z0-9]+\b/.test(glossary.content),
  );
}
const notes = docs.filter((d) => d.metadata.section === "notes");
check("notes are indexed one document each", notes.length > 0, `${notes.length} note(s)`);

// Untouched sections must not become blank documents full of empty labels.
check(
  "empty sections produce no document at all",
  !docs.some((d) => d.content.split("\n").filter((l) => /^[A-Z][\w ]+:\s*$/.test(l)).length > 5),
);

// ── the DB round-trip ───────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log("\nskip  sync + retrieval checks — no DATABASE_URL");
} else {
  const { syncSource } = await import("./src/sources.ts");
  const { listDocuments } = await import("./src/ingest.ts");
  const { retrieveChunks } = await import("./src/retrieve.ts");
  const { embedderStatus } = await import("./src/embeddings.ts");

  const embedder = embedderStatus();
  console.log(`\n  embedder: ${embedder.name}${embedder.production ? "" : " (dev fallback — retrieval is noise)"}\n`);

  const first = await syncSource("pm-tool", { collection: "pm-tool-verify" });
  check(
    "syncSource ingests every fetched document",
    first.documents === docs.length && first.chunks > 0,
    `${first.documents} docs / ${first.chunks} chunks`,
  );

  const afterFirst = (await listDocuments()).filter((d) => d.sourceType === "pm-tool");
  check("the documents land in the store", afterFirst.length === docs.length, `${afterFirst.length} stored`);

  // The real risk with a re-syncable connector: running it twice doubles the corpus.
  const second = await syncSource("pm-tool", { collection: "pm-tool-verify" });
  const afterSecond = (await listDocuments()).filter((d) => d.sourceType === "pm-tool");
  check(
    "re-syncing replaces rather than duplicating",
    afterSecond.length === afterFirst.length,
    `${afterFirst.length} → ${afterSecond.length} after a second sync of ${second.documents}`,
  );

  if (glossary && embedder.production) {
    const hits = await retrieveChunks("What does this project mean by an agent?", 3, {
      collection: "pm-tool-verify",
    });
    check(
      "a glossary question retrieves a PM-tool chunk",
      hits.some((h) => /agent/i.test(h.content)),
      hits[0]?.content?.slice(0, 80).replace(/\n/g, " "),
    );
  } else {
    console.log("skip  retrieval check — needs a real embedder (VOYAGE_API_KEY)");
  }

  // Leave the store as found: this is someone's hub, not a fixture.
  const { deleteDocument } = await import("./src/ingest.ts");
  for (const d of (await listDocuments()).filter((d) => d.collection === "pm-tool-verify")) {
    await deleteDocument(d.id);
  }
  console.log("\n  … verification documents removed\n");
}

const failed = checks.filter((c) => !c.ok);
console.log(
  failed.length === 0
    ? `PM-tool knowledge source OK (${checks.length} checks)`
    : `PM-tool knowledge source FAILED (${failed.length}/${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
