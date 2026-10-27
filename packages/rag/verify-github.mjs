// Verification of the GitHub docs KnowledgeSource — the connector that indexes
// a repository's prose (docs/, README, CLAUDE.md) so an agent that owns a
// product knows its design record.
//
//   node --experimental-transform-types packages/rag/verify-github.mjs
//
// No GitHub, no token of yours, no network. A throwaway HTTP server stands in
// for api.github.com and the source is pointed at it with GITHUB_API_BASE_URL.
// With DATABASE_URL set (a migrated hub database), it also runs a sync, a
// re-sync that must not duplicate, and the collection rules, then deletes what
// it ingested.
//
// What it cannot prove: that GitHub's live responses match the documented
// shapes copied here (commits, git/trees, contents), or that a token has
// Contents: read on the real repositories. Syncing from /knowledge is the check
// for that, once the token is in place.
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

const TOKEN = "github_pat_fixture";
const HUB_REPO = "teqneo/hub";
const ATLAS_REPO = "teqneo/atlas";
const HUB_SHA = "0123456789abcdef0123456789abcdef01234567";

// ── the throwaway GitHub ────────────────────────────────────────────────────
// A docs folder with one subfolder, a README and a CLAUDE.md, plus the things
// that must NOT be indexed: a .ts file under docs/, a .md outside the paths, a
// huge .md and an empty one.
const FILES = {
  "README.md": "# AI Hub\n\nA private hub for the agents we actually run.",
  "CLAUDE.md": "# CLAUDE.md\n\nGuidance for Claude Code in this repo.",
  "docs/agents.md": "# Standing agents\n\nAn **agent** is someone you keep.",
  "docs/deep/approvals.md": "Writes wait for a person.\n\nA tool call that would write is held.",
  "docs/notes.txt": "plain notes count as prose",
  "docs/huge.md": "# Huge\n\n" + "x".repeat(300 * 1024),
  "docs/empty.md": "   \n",
  "docs/render.ts": "export const x = 1;",
  "packages/rag/README.md": "# rag\n\noutside the configured paths",
};
const tree = Object.entries(FILES).map(([path, body]) => ({ path, type: "blob", size: Buffer.byteLength(body) }));
tree.push({ path: "docs", type: "tree" }, { path: "docs/deep", type: "tree" });

const requests = [];
let truncate = false;
const http = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = decodeURIComponent(url.pathname);
  requests.push({ path, query: url.searchParams, authorization: req.headers.authorization, accept: req.headers.accept });
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: "Bad credentials" });

  // A private repository the token cannot see is a 404, as GitHub does it.
  if (path.startsWith(`/repos/${ATLAS_REPO}/`)) return json(404, { message: "Not Found" });

  if (path === `/repos/${HUB_REPO}/commits/master`) {
    return json(200, { sha: HUB_SHA, commit: { committer: { date: "2026-10-26T19:21:00Z" } } });
  }
  if (path === `/repos/${HUB_REPO}/git/trees/${HUB_SHA}`) {
    return json(200, { sha: HUB_SHA, truncated: truncate, tree });
  }
  const contents = path.match(new RegExp(`^/repos/${HUB_REPO}/contents/(.+)$`));
  if (contents) {
    const body = FILES[contents[1]];
    if (body === undefined) return json(404, { message: "Not Found" });
    if (url.searchParams.get("ref") !== HUB_SHA) return json(400, { message: "contents must be read at the pinned commit" });
    if (req.headers.accept !== "application/vnd.github.raw+json") return json(406, { message: "raw media type expected" });
    res.writeHead(200, { "content-type": "application/vnd.github.raw" });
    return res.end(body);
  }
  return json(404, { message: `No route for ${path}` });
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${http.address().port}`;

const { listSources, getSource, syncSource } = await import("./src/sources.ts");
const githubSources = () => listSources().filter((s) => s.type.startsWith("github:"));

try {
  // ── registration, from the env ─────────────────────────────────────────────
  delete process.env.HUB_GITHUB_SOURCES;
  delete process.env.GITHUB_TOKEN;
  check("no HUB_GITHUB_SOURCES: no GitHub sources, and the other sources are untouched", githubSources().length === 0 && listSources().some((s) => s.type === "pm-tool"));

  process.env.HUB_GITHUB_SOURCES = "{not json";
  check("malformed HUB_GITHUB_SOURCES: no GitHub sources (fails closed)", githubSources().length === 0);

  process.env.HUB_GITHUB_SOURCES = JSON.stringify({
    hub: { repo: HUB_REPO, ref: "master", paths: ["docs", "README.md", "CLAUDE.md"], collection: "hub-product" },
    atlas: { repo: ATLAS_REPO },
    "bad key!": { repo: HUB_REPO },
    nested: { repo: "../../evil" },
    noRepo: { paths: ["docs"] },
  });
  const listed = githubSources();
  check(
    "one source per well-formed entry, typed github:<key>; a bad key or repo is dropped",
    listed.map((s) => s.type).sort().join(",") === "github:atlas,github:hub",
    listed.map((s) => s.type).join(", "),
  );
  check("labelled by repository, filed under the entry's collection by default", listed.find((s) => s.type === "github:hub")?.label === `GitHub — ${HUB_REPO}` && listed.find((s) => s.type === "github:hub")?.defaultCollection === "hub-product");
  check("without GITHUB_TOKEN the sources are declared but not connected", listed.every((s) => s.configured === false));
  const unconnected = getSource("github:hub");
  const refused = await unconnected.fetch().then(() => "fetched", (e) => e.message);
  check("and a fetch refuses, naming the variable", /GITHUB_TOKEN/.test(refused) && /Contents: read/.test(refused), refused);
  check("no request left for GitHub without a token", requests.length === 0);

  process.env.GITHUB_TOKEN = TOKEN;
  check("with the token, connected", githubSources().every((s) => s.configured === true));

  // ── the fetch ──────────────────────────────────────────────────────────────
  const source = getSource("github:hub");
  const docs = await source.fetch();
  const byPath = Object.fromEntries(docs.map((d) => [d.metadata.path, d]));
  check(
    "indexes the prose under the configured paths, and nothing else",
    Object.keys(byPath).sort().join(",") === "CLAUDE.md,README.md,docs/agents.md,docs/deep/approvals.md,docs/notes.txt",
    Object.keys(byPath).sort().join(", "),
  );
  check("a .ts under docs/, a README outside the paths, a 300KB file and an empty file are left out", !byPath["docs/render.ts"] && !byPath["packages/rag/README.md"] && !byPath["docs/huge.md"] && !byPath["docs/empty.md"]);
  const short = HUB_SHA.slice(0, 7);
  check("the title is the first heading, with the path and the commit it was read at", byPath["docs/agents.md"]?.title === `Standing agents (docs/agents.md @ ${short})`, byPath["docs/agents.md"]?.title);
  check("a file with no heading is titled by its name", byPath["docs/deep/approvals.md"]?.title === `approvals (docs/deep/approvals.md @ ${short})`, byPath["docs/deep/approvals.md"]?.title);
  check("external ids are stable: github:<repo>:<path>", docs.every((d) => d.externalId === `github:${HUB_REPO}:${d.metadata.path}`));
  check(
    "the body opens with the title and the repository path, then the file as written",
    byPath["docs/agents.md"]?.content === `Standing agents — ${HUB_REPO}/docs/agents.md @ ${short}\n\n# Standing agents\n\nAn **agent** is someone you keep.`,
  );
  check(
    "every document says which commit it was read at, and links to that commit",
    docs.every((d) => d.metadata.sha === HUB_SHA && d.metadata.ref === "master" && d.metadata.url === `https://github.com/${HUB_REPO}/blob/${HUB_SHA}/${d.metadata.path}`),
    byPath["README.md"]?.metadata.url,
  );
  check("the huge file was never downloaded", !requests.some((r) => r.path.endsWith("/contents/docs/huge.md")));
  check("every read carries the token as a bearer", requests.every((r) => r.authorization === `Bearer ${TOKEN}`), `${requests.length} requests`);
  check("files are read raw, at the pinned commit", requests.filter((r) => r.path.includes("/contents/")).every((r) => r.accept === "application/vnd.github.raw+json" && r.query.get("ref") === HUB_SHA));

  const atlas = await getSource("github:atlas").fetch().then(() => "fetched", (e) => e.message);
  check("a repository the token cannot see fails naming it, with the 404-means-private hint", /teqneo\/atlas/.test(atlas) && /private repository/.test(atlas), atlas.slice(0, 90));

  truncate = true;
  const cut = await source.fetch().then(() => "fetched", (e) => e.message);
  check("a truncated tree is an error, never a partial index presented as complete", /too large/.test(cut), cut);
  truncate = false;

  // ── the DB round-trip ─────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    console.log("\nskip  sync + collection checks — no DATABASE_URL");
  } else {
    const { listDocuments, deleteDocument } = await import("./src/ingest.ts");
    const { ALL_KNOWLEDGE } = await import("../authz/src/knowledge.ts");
    const { embedderStatus } = await import("./src/embeddings.ts");
    const e = embedderStatus();
    console.log(`\n  embedder: ${e.name}${e.production ? "" : " (dev fallback — fine for a sync test)"}\n`);
    const mine = async () => (await listDocuments(ALL_KNOWLEDGE)).filter((d) => d.sourceType === "github:hub");

    const first = await syncSource("github:hub");
    const stored = await mine();
    check("syncSource ingests every fetched document", first.documents === docs.length && stored.length === docs.length, `${first.documents} docs / ${first.chunks} chunks`);
    check("with no collection given, they are filed under the entry's own", stored.every((d) => d.collection === "hub-product"), [...new Set(stored.map((d) => d.collection))].join(", "));

    await syncSource("github:hub");
    const again = await mine();
    check("re-syncing replaces rather than duplicating", again.length === stored.length, `${stored.length} → ${again.length}`);

    await syncSource("github:hub", { collection: "elsewhere" });
    const moved = await mine();
    check("a collection named at sync time wins over the default", moved.length === stored.length && moved.every((d) => d.collection === "elsewhere"));

    for (const d of await mine()) await deleteDocument(d.id);
    check("cleaned up", (await mine()).length === 0);
    const { getSql } = await import("../db/src/client.ts");
    await getSql().end({ timeout: 5 });
  }
} finally {
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks FAILED` : `\nGitHub docs source OK (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
